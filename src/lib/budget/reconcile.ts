/**
 * The three-way match: plan ↔ platform ↔ card.
 *
 * Accounts payable has matched purchase order, goods received and invoice for
 * a century. Marketing budgets have not: the plan lives in a spreadsheet, the
 * platforms report what they *say* they spent, and the card shows what was
 * actually taken. Each disagrees with the others for reasons that are mostly
 * innocent — threshold billing timing, VAT, FX, credits — and occasionally not
 * — a duplicate charge, a failed payment quietly pausing delivery, a card used
 * for an account nobody budgeted.
 *
 * Method (from the research):
 *  - Platforms expose accrued cost reliably and card charges not at all, so
 *    charges are matched to spend on running totals per platform, not 1:1.
 *    With threshold billing the expected gap (spend − charges) sits between
 *    zero and one threshold; outside that band something needs explaining.
 *  - Google charges carry the customer id and are attributed to an account.
 *  - Pending authorisations are shown, never matched; a pending item that
 *    duplicates a settled charge (Google does this) is not a discrepancy.
 *  - Each discrepancy has a stable fingerprint so a person's "explained"
 *    sticks across nightly runs.
 *
 * Pure. Money in pence.
 */
import { createHash } from 'node:crypto'
import { channelDef, channelLabelFor } from './channels'
import { formatCustomerId } from './merchants'
import { money, pct } from './money'
import { addDays, daysBetween } from './pacing'
import type {
  BillingProfile,
  CardTx,
  Discrepancy,
  DiscrepancyKind,
  PlatformDay,
  ReconciliationReport,
  Severity,
  ThreeWayRow,
} from './types'

export type ReconcileLine = {
  id: string
  key: string
  label: string
  plannedPence: number
}

export type ReconcileInput = {
  periodStart: string
  periodEnd: string
  today: string
  lines: ReconcileLine[]
  /** Already classified: platform = channel key; accountRef for Google. */
  txs: (CardTx & { accountRef?: string | null; ignored?: boolean })[]
  platformDays: PlatformDay[]
  /** Platforms whose spend Aurea can see. Charges for others are unverifiable. */
  connectedPlatforms: string[]
  billing?: Partial<Record<string, Partial<BillingProfile>>>
  /** Google Ads customer ids the workspace owns, digits only. */
  knownGoogleAccounts?: string[]
  cardCurrency?: string
  simulated?: boolean
}

const STALE_PENDING_DAYS = 7

function fp(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16)
}

function day(iso: string): string {
  return iso.slice(0, 10)
}

function billingFor(platform: string, input: ReconcileInput): BillingProfile {
  const def = channelDef(platform)?.billing
  const o = input.billing?.[platform] ?? {}
  return {
    platform,
    thresholdPence: o.thresholdPence !== undefined ? o.thresholdPence : (def?.thresholdPence ?? null),
    billingCurrency: o.billingCurrency ?? def?.currency ?? input.cardCurrency ?? 'GBP',
    vatRate: o.vatRate ?? def?.vatRate ?? 0,
    settlementLagDays: o.settlementLagDays ?? def?.settlementLagDays ?? 2,
  }
}

export function reconcile(input: ReconcileInput): ReconciliationReport {
  const { periodStart, periodEnd, today } = input
  const discrepancies: Discrepancy[] = []
  const add = (d: Omit<Discrepancy, 'fingerprint'> & { key: string }) => {
    const { key, ...rest } = d
    discrepancies.push({ ...rest, fingerprint: fp(d.kind, periodStart, key) })
  }

  const cardCurrency = input.cardCurrency ?? 'GBP'
  const inWindow = input.txs.filter((t) => !t.ignored && day(t.postedAt) >= periodStart && day(t.postedAt) <= periodEnd)
  // Pence and cents are not the same unit: charges settled in another currency are set aside, not summed.
  const otherCurrency = inWindow.filter((t) => t.currency.toUpperCase() !== cardCurrency)
  const inPeriod = inWindow.filter((t) => t.currency.toUpperCase() === cardCurrency)
  const settled = inPeriod.filter((t) => t.status === 'settled')
  const pending = inPeriod.filter((t) => t.status === 'pending')
  const lineByKey = new Map(input.lines.map((l) => [l.key, l]))
  const lineById = new Map(input.lines.map((l) => [l.id, l]))

  /* ---- pending: stale ones, and benign duplicates of settled charges. */
  for (const p of pending) {
    const dupOfSettled = settled.some(
      (s) =>
        s.amountPence === p.amountPence &&
        s.platform === p.platform &&
        Math.abs(daysBetween(day(s.postedAt), day(p.postedAt))) <= 5,
    )
    if (dupOfSettled) continue
    const age = daysBetween(day(p.postedAt), today)
    if (age > STALE_PENDING_DAYS) {
      add({
        key: `pending:${p.externalId}`,
        kind: 'stale_pending',
        severity: 'low',
        platform: p.platform,
        lineId: p.lineId,
        amountPence: p.amountPence,
        txIds: [p.id],
        title: `${money(p.amountPence)} authorised ${age} days ago and never settled`,
        detail: `"${p.descriptor}" is still pending. Most authorisations clear within a week; some stay pending for months and then drop off.`,
        suggestion: 'If it is a card verification or a pre-authorisation hold, it will drop off on its own. If it is older than a month, ask the card issuer.',
      })
    }
  }

  if (otherCurrency.length) {
    const ccys = [...new Set(otherCurrency.map((t) => t.currency.toUpperCase()))]
    add({
      key: `currency:${ccys.join(',')}`,
      kind: 'unverifiable',
      severity: 'medium',
      platform: null,
      lineId: null,
      amountPence: 0,
      txIds: otherCurrency.map((t) => t.id),
      title: `${otherCurrency.length} charge${otherCurrency.length === 1 ? '' : 's'} settled in ${ccys.join(', ')} left out of the totals`,
      detail: `The plan is in ${cardCurrency}. Charges that settled in another currency (a card held in ${ccys.join(', ')}) cannot be added to ${cardCurrency} figures without an exchange rate, so they are listed but not counted.`,
      suggestion: `Use a ${cardCurrency} card for this plan, or import that card's statement in ${cardCurrency}.`,
    })
  }

  /* ---- what each charge belongs to. */
  const lineOf = (t: CardTx): ReconcileLine | null =>
    (t.lineId ? lineById.get(t.lineId) : undefined) ?? (t.platform ? lineByKey.get(t.platform) : undefined) ?? null

  // Charges from a Google Ads account that is not the workspace's are their own problem,
  // not part of the Google line's running total (Google prints the paying account id).
  const known = new Set(input.knownGoogleAccounts ?? [])
  const isForeign = (t: (typeof settled)[number]) =>
    known.size > 0 && t.platform === 'google_ads' && !!t.accountRef && !known.has(t.accountRef)
  const cardByLine = new Map<string, number>()
  const cardByPlatform = new Map<string, CardTx[]>()
  for (const t of settled) {
    if (isForeign(t)) continue
    const l = lineOf(t)
    if (l) cardByLine.set(l.id, (cardByLine.get(l.id) ?? 0) + t.amountPence)
    if (t.platform) cardByPlatform.set(t.platform, [...(cardByPlatform.get(t.platform) ?? []), t])
  }

  /* ---- unknown merchants and unbudgeted spend. */
  const unknown = settled.filter((t) => !t.platform && !t.lineId && t.amountPence > 0)
  for (const t of unknown) {
    add({
      key: `unknown:${t.externalId}`,
      kind: 'unknown_merchant',
      severity: t.amountPence >= 50_000 ? 'medium' : 'low',
      platform: null,
      lineId: null,
      amountPence: t.amountPence,
      txIds: [t.id],
      title: `${money(t.amountPence)} to "${t.descriptor}" — not recognised`,
      detail: 'This charge is on a card connected to the marketing budget, but nothing identifies what it was for.',
      suggestion: 'Assign it to a budget line, or mark the merchant as not marketing. Aurea remembers the choice for future charges.',
    })
  }
  const unbudgeted = new Map<string, CardTx[]>()
  for (const t of settled) {
    if (t.platform && !lineOf(t) && t.amountPence > 0 && !isForeign(t)) unbudgeted.set(t.platform, [...(unbudgeted.get(t.platform) ?? []), t])
  }
  for (const [platform, txs] of unbudgeted) {
    const total = txs.reduce((a, t) => a + t.amountPence, 0)
    add({
      key: `unbudgeted:${platform}`,
      kind: 'unbudgeted_spend',
      severity: total >= 100_000 ? 'high' : 'medium',
      platform,
      lineId: null,
      amountPence: total,
      txIds: txs.map((t) => t.id),
      title: `${money(total)} spent on ${channelLabelFor(platform)}, which has no budget line`,
      detail: `${txs.length} charge${txs.length === 1 ? '' : 's'} identified as ${channelLabelFor(platform)}. Money is going out on something the plan does not include.`,
      suggestion: `Add a ${channelLabelFor(platform)} line to the plan, or stop the spend at source.`,
    })
  }

  /* ---- Google charges for accounts the workspace does not know. */
  const foreign = new Map<string, CardTx[]>()
  if (known.size > 0) {
    for (const t of settled) {
      if (isForeign(t)) {
        foreign.set(t.accountRef as string, [...(foreign.get(t.accountRef as string) ?? []), t])
      }
    }
    for (const [acct, txs] of foreign) {
      const total = txs.reduce((a, t) => a + t.amountPence, 0)
      add({
        key: `foreign-google:${acct}`,
        kind: 'unbudgeted_spend',
        severity: 'high',
        platform: 'google_ads',
        lineId: lineByKey.get('google_ads')?.id ?? null,
        amountPence: total,
        txIds: txs.map((t) => t.id),
        title: `${money(total)} charged by Google Ads account ${formatCustomerId(acct)}, which is not one of yours`,
        detail: 'Google prints the paying account’s customer id on every charge. This one is not connected to Aurea — a card shared with another brand or client, or an account nobody remembers opening.',
        suggestion: 'Connect the account in Google Ads settings if it is yours, or remove this card from it in Google Ads → Billing.',
      })
    }
  }

  /* ---- running totals per platform: the core of the match. */
  const platformSpend = new Map<string, PlatformDay[]>()
  for (const d of input.platformDays) {
    if (d.day < periodStart || d.day > periodEnd) continue
    platformSpend.set(d.platform, [...(platformSpend.get(d.platform) ?? []), d])
  }
  const cashFactors: Record<string, number> = {}
  const platformsSeen = new Set([...cardByPlatform.keys(), ...platformSpend.keys()])

  for (const platform of platformsSeen) {
    const charges = cardByPlatform.get(platform) ?? []
    const connected = input.connectedPlatforms.includes(platform)
    const charged = charges.reduce((a, t) => a + t.amountPence, 0)
    const label = channelLabelFor(platform)

    if (!connected) {
      // Only ad platforms report spend of their own; a SaaS subscription has nothing to verify against.
      // A platform with no line is already reported as unbudgeted spend; one finding is enough.
      if (charged > 0 && channelDef(platform)?.category === 'paid_media' && lineByKey.has(platform)) {
        add({
          key: `unverifiable:${platform}`,
          kind: 'unverifiable',
          severity: 'low',
          platform,
          lineId: lineByKey.get(platform)?.id ?? null,
          amountPence: charged,
          txIds: charges.map((t) => t.id),
          title: `${money(charged)} charged by ${label}, with nothing to check it against`,
          detail: `${label} spend is not connected to Aurea, so these charges cannot be matched to what was delivered.`,
          suggestion: `Connect ${label} so spend can be compared with charges, or record its spend manually.`,
        })
      }
      continue
    }

    const b = billingFor(platform, input)
    const days = platformSpend.get(platform) ?? []
    // Spend old enough to have been charged by now.
    const billableBy = addDays(today, -b.settlementLagDays)
    const spendBillable = days.filter((d) => d.day <= billableBy).reduce((a, d) => a + d.spendPence, 0)
    const expectedCash = Math.round(spendBillable * (1 + b.vatRate))
    const gap = charged - expectedCash // positive: charged more than spend explains
    const threshold = b.thresholdPence ?? 0
    const tolerance = Math.max(500, Math.round(expectedCash * 0.02))

    // Observed cash factor, only from enough billed spend to mean something.
    if (spendBillable > 0 && charged > 0 && (threshold === 0 || spendBillable >= threshold * 8)) {
      const residual = Math.min(threshold, Math.max(0, expectedCash - charged)) / 2
      const factor = (charged + residual) / spendBillable
      if (factor > 0.8 && factor < 1.4) cashFactors[platform] = Math.round(factor * 10_000) / 10_000
    }

    /*
     * Why the threshold appears on both sides: at the start of the window up
     * to one threshold of earlier spend may still be unbilled, and it gets
     * charged inside the window. So the window's own gap can legitimately be
     * anywhere in ±threshold. Beyond that, or with a matching identical pair,
     * something needs explaining.
     */
    const vatLike =
      b.vatRate === 0 && spendBillable >= Math.max(threshold * 5, 10_000) && Math.abs(charged / spendBillable - 1.2) < 0.02
    const dup = gap > tolerance ? findDuplicatePair(charges) : null
    if (vatLike || (dup && gap >= dup[0].amountPence * 0.5) || gap > threshold + tolerance) {
      if (vatLike) {
        add({
          key: `vat:${platform}`,
          kind: 'overcharge',
          severity: 'medium',
          platform,
          lineId: lineByKey.get(platform)?.id ?? null,
          amountPence: gap,
          txIds: charges.map((t) => t.id),
          title: `${label} charges are 20% above its spend — UK VAT is being added`,
          detail: `${label} reports ${money(spendBillable)} of spend; the card was charged ${money(charged)}. That is exactly UK VAT at 20%, which happens when the ad account has no VAT number and the reverse charge does not apply.`,
          suggestion: `Add your UK VAT number to the ${label} billing settings. If you are VAT-registered the VAT is recoverable, but it still ties up cash and distorts cost per result.`,
        })
      } else if (dup) {
        add({
          key: `dup:${platform}:${dup.map((t) => t.externalId).sort().join(',')}`,
          kind: 'duplicate_charge',
          severity: 'high',
          platform,
          lineId: lineByKey.get(platform)?.id ?? null,
          amountPence: Math.min(gap, dup[1].amountPence),
          txIds: dup.map((t) => t.id),
          title: `Possible duplicate: two ${money(dup[0].amountPence)} charges from ${label}`,
          detail: `Charges exceed reported spend by ${money(gap)}, and two identical charges ("${dup[0].descriptor}") landed within two days of each other.`,
          suggestion:
            platform === 'google_ads'
              ? 'Google credits a genuine double charge to future spend rather than refunding the card. Check Billing → Transactions in Google Ads, and ask for a refund if you would rather have the cash.'
              : `Check the ${label} billing history. If both are real charges for one bill, ask ${label} for a refund.`,
        })
      } else {
        add({
          key: `over:${platform}`,
          kind: 'overcharge',
          severity: gap > Math.max(threshold, 20_000) ? 'high' : 'medium',
          platform,
          lineId: lineByKey.get(platform)?.id ?? null,
          amountPence: gap,
          txIds: charges.map((t) => t.id),
          title: `${label} charged ${money(gap)} more than its reported spend`,
          detail: `Reported spend to ${billableBy}: ${money(spendBillable)}${b.vatRate ? ` plus ${pct(b.vatRate)} VAT` : ''}. Charged: ${money(charged)}. Usual causes: FX fees on a foreign-currency account, a charge for spend from before this period, or a fee.`,
          suggestion: `Compare with the ${label} billing history. If the account bills in another currency, the difference may be FX — see the cash factor on the allocator.`,
        })
      }
    } else if (-gap > threshold + tolerance && spendBillable > 0) {
      const unbilled = -gap
      add({
        key: `unbilled:${platform}`,
        kind: 'unbilled_spend',
        severity: unbilled > threshold * 2 + tolerance ? 'high' : 'medium',
        platform,
        lineId: lineByKey.get(platform)?.id ?? null,
        amountPence: unbilled,
        txIds: charges.map((t) => t.id),
        title: `${money(unbilled)} of ${label} spend has not reached the card`,
        detail: `${label} reports ${money(spendBillable)} of spend that should have been billed by now; the card shows ${money(charged)}.${threshold ? ` Threshold billing explains up to ${money(threshold)} of that.` : ''} The rest is either on another payment method, covered by credits, or a payment that failed.`,
        suggestion:
          platform === 'google_ads'
            ? 'Check Google Ads → Billing for a failed payment (delivery stops until it is paid) and for credits applied to the balance. If another card is paying, connect it.'
            : `Check ${label} billing for a failed payment or a second payment method. A failed payment pauses delivery.`,
      })
    }
  }

  /* ---- FX: charges converted from another currency. */
  const fx = settled.filter((t) => t.originalCurrency && t.originalCurrency !== t.currency && t.originalAmountMinor)
  const byPair = new Map<string, CardTx[]>()
  for (const t of fx) {
    const k = `${t.platform ?? 'other'}:${t.originalCurrency}`
    byPair.set(k, [...(byPair.get(k) ?? []), t])
  }
  for (const [k, txs] of byPair) {
    const rates = txs.map((t) => t.amountPence / (t.originalAmountMinor as number))
    const lo = Math.min(...rates)
    const hi = Math.max(...rates)
    const total = txs.reduce((a, t) => a + t.amountPence, 0)
    const [platform, ccy] = k.split(':')
    // An issuer FX margin is typically ~3%: flag when the rates themselves vary that much, or when the likely fee passes £5.
    const spread = lo > 0 ? hi / lo - 1 : 0
    const est = Math.round(total * 0.0275)
    if (spread > 0.03 || est >= 500) {
      add({
        key: `fx:${k}`,
        kind: 'fx_cost',
        severity: spread > 0.03 ? 'medium' : 'low',
        platform: platform === 'other' ? null : platform,
        lineId: platform === 'other' ? null : (lineByKey.get(platform)?.id ?? null),
        amountPence: est,
        txIds: txs.map((t) => t.id),
        title: `${money(total)} of ${platform === 'other' ? 'charges' : channelLabelFor(platform)} converted from ${ccy}`,
        detail: `${txs.length} charge${txs.length === 1 ? '' : 's'} billed in ${ccy} and converted on the card${spread > 0.03 ? `; the effective rate varied by ${pct(spread, 1)} across them` : ''}. Card issuers typically add around 2.75–3% on conversions, roughly ${money(est)} here (an estimate — the issuer’s statement shows the exact fee).`,
        suggestion: `Bill the ad account in GBP if the platform allows it, or pay from a ${ccy} wallet (an Airwallex or Revolut ${ccy} balance avoids the conversion).`,
      })
    }
  }

  /* ---- refunds nobody can place. */
  for (const t of settled.filter((x) => x.amountPence < 0 && !x.platform && !x.lineId)) {
    add({
      key: `refund:${t.externalId}`,
      kind: 'refund_unmatched',
      severity: 'low',
      platform: null,
      lineId: null,
      amountPence: -t.amountPence,
      txIds: [t.id],
      title: `${money(-t.amountPence)} refunded by "${t.descriptor}"`,
      detail: 'Money came back to the card from a merchant Aurea cannot place.',
      suggestion: 'Assign it to the line it belongs to so that line’s spend is stated net.',
    })
  }

  /* ---- three-way rows and line overruns. */
  const rows: ThreeWayRow[] = input.lines.map((l) => {
    const platformDaysForLine = platformSpend.get(l.key)
    const connected = input.connectedPlatforms.includes(l.key)
    const platformPence = connected && platformDaysForLine ? platformDaysForLine.reduce((a, d) => a + d.spendPence, 0) : connected ? 0 : null
    const cardPence = cardByLine.get(l.id) ?? 0
    return {
      lineId: l.id,
      label: l.label,
      platform: channelDef(l.key)?.category === 'paid_media' ? l.key : null,
      plannedPence: l.plannedPence,
      platformPence,
      cardPence,
      billingGapPence: platformPence === null ? null : cardPence - platformPence,
      planGapPence: cardPence - l.plannedPence,
      matched: false,
    }
  })
  for (const [platform, txs] of unbudgeted) {
    rows.push({
      lineId: null,
      label: `${channelLabelFor(platform)} (no line)`,
      platform,
      plannedPence: 0,
      platformPence: null,
      cardPence: txs.reduce((a, t) => a + t.amountPence, 0),
      billingGapPence: null,
      planGapPence: txs.reduce((a, t) => a + t.amountPence, 0),
      matched: false,
    })
  }
  for (const [acct, txs] of foreign) {
    const total = txs.reduce((a, t) => a + t.amountPence, 0)
    rows.push({
      lineId: null,
      label: `Google Ads ${formatCustomerId(acct)} (not yours)`,
      platform: 'google_ads',
      plannedPence: 0,
      platformPence: null,
      cardPence: total,
      billingGapPence: null,
      planGapPence: total,
      matched: false,
    })
  }
  if (unknown.length) {
    const total = unknown.reduce((a, t) => a + t.amountPence, 0)
    rows.push({
      lineId: null,
      label: 'Not identified',
      platform: null,
      plannedPence: 0,
      platformPence: null,
      cardPence: total,
      billingGapPence: null,
      planGapPence: total,
      matched: false,
    })
  }

  for (const r of rows) {
    if (!r.lineId || r.plannedPence <= 0) continue
    // Cash or accrual, whichever is higher, against plan: a line is over when either says so.
    const used = Math.max(r.cardPence, r.platformPence ?? 0)
    const over = used - r.plannedPence
    if (over > Math.max(500, r.plannedPence * 0.02)) {
      const share = over / r.plannedPence
      add({
        // Keyed by channel, not line id: a revision copies lines under new ids, and an explanation must survive that.
        key: `overrun:${lineById.get(r.lineId)?.key ?? r.lineId}`,
        kind: 'line_overrun',
        severity: share > 0.1 ? 'high' : 'medium',
        platform: r.platform,
        lineId: r.lineId,
        amountPence: over,
        txIds: [],
        title: `${r.label} is ${money(over)} (${pct(share)}) over plan`,
        detail: `Planned ${money(r.plannedPence)}; ${r.platformPence !== null && r.platformPence >= r.cardPence ? `the platform reports ${money(r.platformPence)}` : `the card shows ${money(r.cardPence)}`}.`,
        suggestion: 'Reallocate from a line that is under, or lower the daily budgets on the platform. Platform-side caps (Google account budgets, Meta spend caps) stop spend; a card limit only stops payment.',
      })
    }
  }

  const flaggedLines = new Set(discrepancies.filter((d) => d.severity !== 'low' && d.lineId).map((d) => d.lineId))
  const flaggedPlatforms = new Set(discrepancies.filter((d) => d.severity !== 'low' && d.platform).map((d) => d.platform))
  for (const r of rows) {
    r.matched =
      !!r.lineId &&
      (r.cardPence !== 0 || (r.platformPence ?? 0) !== 0) &&
      !flaggedLines.has(r.lineId) &&
      !(r.platform && flaggedPlatforms.has(r.platform))
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  discrepancies.sort((a, b) => rank[a.severity] - rank[b.severity] || b.amountPence - a.amountPence)

  const totals = {
    plannedPence: input.lines.reduce((a, l) => a + l.plannedPence, 0),
    platformPence: [...platformSpend.values()].flat().reduce((a, d) => a + d.spendPence, 0),
    cardPence: settled.reduce((a, t) => a + t.amountPence, 0),
    explainedPence: rows.filter((r) => r.matched).reduce((a, r) => a + r.cardPence, 0),
  }

  return {
    periodStart,
    periodEnd,
    rows,
    discrepancies,
    totals,
    cashFactors,
    simulated: !!input.simulated,
  }
}

/** Two identical charges within two days. Threshold billing makes equal amounts normal, so this is only consulted once totals already disagree. */
function findDuplicatePair(charges: CardTx[]): [CardTx, CardTx] | null {
  const sorted = [...charges].sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (daysBetween(day(a.postedAt), day(b.postedAt)) > 2) break
      if (a.amountPence === b.amountPence && a.descriptor === b.descriptor) return [a, b]
    }
  }
  return null
}

export const DISCREPANCY_LABEL: Record<DiscrepancyKind, string> = {
  duplicate_charge: 'Duplicate charge',
  overcharge: 'Charged more than spend',
  unbilled_spend: 'Spend not billed',
  unbudgeted_spend: 'Unbudgeted spend',
  unknown_merchant: 'Unknown merchant',
  fx_cost: 'Currency conversion',
  refund_unmatched: 'Unmatched refund',
  stale_pending: 'Stale authorisation',
  line_overrun: 'Over plan',
  unverifiable: 'Cannot verify',
}
