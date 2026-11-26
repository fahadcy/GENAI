/**
 * Card descriptors → budget lines.
 *
 * A card statement says "GOOGLE*GOOG 4820917365" or "FACEBK *2QX8ZK9LP2", not
 * "Google Ads, CY Group account". This module turns one into the other, and
 * never holds a card number while doing it.
 *
 *  - Google is the only platform that officially prints the 10-digit customer
 *    id in its descriptor, so Google charges are attributed to an ad account
 *    exactly. Everything else is attributed to a platform, then matched by
 *    running totals in reconcile.ts.
 *  - A person's own rules win over the built-in patterns. Rules are plain
 *    case-insensitive substrings, not regular expressions: a rule is typed
 *    into a form, and a user-supplied regular expression is a way to hang the
 *    server (the Competitors review found exactly that class of bug).
 *  - Any run of 12–19 digits in a descriptor is masked before it is stored. A
 *    statement export occasionally carries a full card number in the narrative;
 *    storing it would pull GenAI into PCI DSS scope for no benefit.
 */
import { createHash } from 'node:crypto'
import { CHANNELS } from './channels'

export type MerchantRule = {
  id: string
  /** Plain text, matched case-insensitively anywhere in the descriptor. */
  contains: string
  channelKey: string | null
  lineId: string | null
  /** True when the rule says "this is not marketing" (excluded from reconciliation). */
  ignore: boolean
}

export type Classification = {
  channelKey: string | null
  lineId: string | null
  /** Google Ads customer id, digits only, when the descriptor carries one. */
  accountRef: string | null
  via: 'rule' | 'pattern' | 'ignored' | 'none'
  ruleId: string | null
}

/** Masks anything that looks like a card number, and tidies whitespace. */
export function sanitiseDescriptor(raw: string): string {
  // Whitespace first, so "4111  1111  1111  1111" cannot slip through as separate groups.
  // No word boundaries: "CARD4111111111111111" and "4111111111111111ABC" are masked too.
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d(?:[ .\-]?\d){11,18}/g, (m) => {
      const digits = m.replace(/\D/g, '')
      return `••••${digits.slice(-4)}`
    })
    .slice(0, 200)
}

export function normaliseDescriptor(raw: string): string {
  return sanitiseDescriptor(raw).toUpperCase()
}

export function googleCustomerId(descriptor: string): string | null {
  const m = descriptor.match(/GOOGLE\s*\*?\s*(?:GOOG|SVCS|ADS)?\s*[^\d]{0,12}(\d{3}-?\d{3}-?\d{4})(?!\d)/i)
  if (!m) return null
  return m[1].replace(/-/g, '')
}

export function formatCustomerId(id: string): string {
  return id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id
}

export function classify(descriptor: string, rules: MerchantRule[] = []): Classification {
  const d = normaliseDescriptor(descriptor)
  for (const r of rules) {
    const needle = r.contains.trim().toUpperCase()
    if (needle.length >= 2 && d.includes(needle)) {
      return {
        channelKey: r.ignore ? null : r.channelKey,
        lineId: r.ignore ? null : r.lineId,
        accountRef: googleCustomerId(d),
        via: r.ignore ? 'ignored' : 'rule',
        ruleId: r.id,
      }
    }
  }
  for (const c of CHANNELS) {
    if (c.merchants?.some((re) => re.test(d))) {
      return {
        channelKey: c.key,
        lineId: null,
        accountRef: c.key === 'google_ads' ? googleCustomerId(d) : null,
        via: 'pattern',
        ruleId: null,
      }
    }
  }
  return { channelKey: null, lineId: null, accountRef: null, via: 'none', ruleId: null }
}

/**
 * Our own idempotency key. TrueLayer warns that its transaction ids can change
 * between requests, so a feed is deduplicated on what the charge *is*: card,
 * day, amount, currency, descriptor — plus an occurrence index, because two
 * identical threshold charges on the same day are both real.
 */
export function txKey(parts: {
  cardId: string
  day: string
  amountPence: number
  currency: string
  descriptor: string
  occurrence: number
}): string {
  return createHash('sha256')
    .update([parts.cardId, parts.day, parts.amountPence, parts.currency, normaliseDescriptor(parts.descriptor), parts.occurrence].join('|'))
    .digest('hex')
    .slice(0, 40)
}

/** Assigns occurrence indexes so identical charges on the same day get distinct keys. */
export function withOccurrence<T extends { day: string; amountPence: number; currency: string; descriptor: string }>(
  cardId: string,
  rows: T[],
): (T & { key: string })[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const base = [r.day, r.amountPence, r.currency, normaliseDescriptor(r.descriptor)].join('|')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...r, key: txKey({ cardId, ...r, occurrence: n }) }
  })
}
