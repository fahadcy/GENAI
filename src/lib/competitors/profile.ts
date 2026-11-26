/**
 * The business profile, without a model.
 *
 * Ported from the competitor-intelligence prototype (`sic_keywords.py` and
 * `ensure_keywords` in `app.py`), keeping its hard-won guard rails:
 *
 *  - A SIC code is a poor description of what a company actually sells. A
 *    payments firm registered under 64999 kept being matched with takeaways,
 *    because the model latched on to a generic word. So some SIC families force
 *    their own keywords and scope, and forbid food terms outright.
 *  - Dormant and holding companies (99999, 6420x, 82990) say nothing about
 *    the trade; they get neutral corporate-services terms, never a guess.
 *  - A name can say more than the SIC code ("… Insolvency Ltd" under 70221).
 *
 * The model, when there is one, goes first; these rules then correct it and
 * are the whole answer when there is no model. Pure: no I/O.
 */

import type { CompanyProfile, Scope } from './types'

export const FOOD_TERMS = new Set([
  'restaurant',
  'meal_takeaway',
  'takeaway',
  'cafe',
  'fast food',
  'coffee shop',
  'meal delivery',
  'pizza',
  'burger',
  'kebab',
])

type Guard = {
  /**
   * A veto guard (holding companies, finance) wins over the company name and
   * over the model: a holding company called "… Property Holdings" is not an
   * estate agent, and "Burger Payments" is not a takeaway.
   */
  veto: boolean
  pattern: RegExp
  businessType: string
  scope: Scope
  keywords: string[]
  forbidFood: boolean
}

/** SIC families whose meaning is clear enough to override a model. Order matters: first match wins. */
export const SIC_GUARDS: Guard[] = [
  {
    // Dormant, holding and management companies.
    veto: true,
    // 82990 ("other business support") is a catch-all, not a holding code, so
    // it is a separate, non-veto guard below: the name can still say more.
    pattern: /\b(99999|6420[1-9])\b/,
    businessType: 'corporate services / holding',
    scope: 'hybrid',
    keywords: [
      'corporate services',
      'registered office',
      'company formation',
      'company secretarial',
      'compliance services',
      'business support',
    ],
    forbidFood: true,
  },
  {
    // Finance and payments. Never food.
    veto: true,
    pattern: /\b(64|65|66)\d{3}\b/,
    businessType: 'financial services / payments',
    scope: 'national',
    keywords: [
      'payment processing',
      'merchant services',
      'card acquiring',
      'payment gateway',
      'direct debit',
      'open banking',
      'fx payments',
    ],
    forbidFood: true,
  },
  {
    // Generic business support: neutral terms when nothing else is known.
    veto: false,
    pattern: /\b82990\b/,
    businessType: 'business support services',
    scope: 'hybrid',
    keywords: ['business support services', 'outsourced business services', 'corporate services', 'compliance services'],
    forbidFood: true,
  },
  {
    // Food and drink service.
    veto: false,
    pattern: /\b56\d{3}\b/,
    businessType: 'restaurant / takeaway',
    scope: 'local',
    keywords: ['restaurant', 'takeaway', 'meal delivery', 'fast food', 'cafe', 'coffee shop'],
    forbidFood: false,
  },
  {
    // Software and IT.
    veto: false,
    pattern: /\b62\d{3}\b/,
    businessType: 'software development',
    scope: 'national',
    keywords: ['software development', 'web development', 'app development', 'it consultancy', 'digital agency'],
    forbidFood: true,
  },
]

/**
 * Holding codes (6420x) sit inside the finance division, so the holding guard
 * is listed first. The prototype had them the other way round, which gave a
 * dormant holding company payment-processing competitors.
 */

/** SIC codes whose words mislead; the prototype's override table. */
export const SIC_OVERRIDES: Record<string, { businessType: string; keywords: string[]; scope: Scope }> = {
  '70221': {
    businessType: 'insolvency practitioner',
    keywords: [
      'insolvency practitioner',
      'business recovery',
      'company liquidation',
      'creditors voluntary liquidation',
      'administration',
      'pre-pack administration',
      'restructuring advisory',
    ],
    scope: 'hybrid',
  },
  '62020': {
    businessType: 'software development',
    keywords: ['software development company', 'custom software', 'web development', 'mobile app development'],
    scope: 'national',
  },
}

/** Name hints: what the company calls itself often beats its SIC code. */
export const NAME_HINTS: { pattern: RegExp; businessType: string; keywords: string[]; scope: Scope }[] = [
  {
    // "Recovery" alone is vehicle recovery as often as business recovery.
    pattern: /\binsolvenc(y|ies)\b|\brestructur(ing|e)\b|\bbusiness recovery\b|\bliquidat(e|ion|ions|ors?)\b/i,
    businessType: 'insolvency practitioner',
    keywords: [
      'insolvency practitioner',
      'business recovery',
      'company liquidation',
      'creditors voluntary liquidation',
      'administration',
      'company voluntary arrangement',
    ],
    scope: 'hybrid',
  },
  {
    pattern: /\bplumb(ing|er|ers)\b/i,
    businessType: 'plumber',
    keywords: ['plumber', 'emergency plumber', 'boiler repair', 'drain unblocking', 'leak repair'],
    scope: 'local',
  },
  {
    pattern: /\belectric(al|ian|ians)\b/i,
    businessType: 'electrician',
    keywords: ['electrician', 'rewiring', 'ev charger installer', 'emergency electrician', 'consumer unit replacement'],
    scope: 'local',
  },
  {
    pattern: /\baccount(ant|ants|ancy|ing)\b|\bbookkeep/i,
    businessType: 'accountant',
    keywords: ['accountant', 'tax advisor', 'bookkeeping', 'vat returns', 'payroll services'],
    scope: 'hybrid',
  },
  {
    pattern: /\bsolicitor(s)?\b|\blaw\b|\blegal\b|\bbarrister/i,
    businessType: 'law firm',
    keywords: ['solicitor', 'law firm', 'legal services', 'employment solicitor', 'commercial law'],
    scope: 'hybrid',
  },
  {
    pattern: /\b(digital|marketing|seo|ppc)\b.*\b(agency|marketing|media)\b|\bmarketing agency\b/i,
    businessType: 'digital marketing agency',
    keywords: ['digital marketing agency', 'seo agency', 'ppc management', 'content marketing', 'social media agency'],
    scope: 'national',
  },
  {
    pattern: /\bdental\b|\bdentist/i,
    businessType: 'dentist',
    keywords: ['dentist', 'dental practice', 'teeth whitening', 'dental implants', 'emergency dentist'],
    scope: 'local',
  },
  {
    pattern: /\bestate agent|\blettings?\b|\bproperty\b/i,
    businessType: 'estate agent',
    keywords: ['estate agent', 'letting agent', 'property management', 'house valuation', 'sell my house'],
    scope: 'local',
  },
  {
    pattern: /\b(restaurant|takeaway|pizza|kebab|burger|cafe|coffee|bakery)\b/i,
    businessType: 'restaurant / takeaway',
    keywords: ['restaurant', 'takeaway', 'meal delivery', 'cafe', 'coffee shop'],
    scope: 'local',
  },
]

export function dedupe(xs: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of xs) {
    const x = (raw ?? '').trim().replace(/\s+/g, ' ')
    const k = x.toLowerCase()
    if (x.length > 1 && !seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  return out
}

/** Accepts "70221", "70221 - Financial management", or a list; returns the five-digit codes. */
export function parseSicCodes(input: string | readonly string[]): string[] {
  const text = Array.isArray(input) ? input.join(' ') : String(input ?? '')
  return dedupe(text.match(/\b\d{5}\b/g) ?? [])
}

export type ProfileGuess = Pick<CompanyProfile, 'businessType' | 'keywords' | 'scope' | 'confidence' | 'source'>

/**
 * Rules-only classification. Used as the whole answer without a model, and as
 * the correction applied to a model's answer.
 */
export function classifyByRules(companyName: string, sicCodes: readonly string[]): ProfileGuess {
  const name = companyName ?? ''
  const sicText = sicCodes.join(' ')

  for (const g of SIC_GUARDS) {
    if (g.veto && g.pattern.test(sicText)) {
      return { businessType: g.businessType, keywords: g.keywords, scope: g.scope, confidence: 0.6, source: 'rules' }
    }
  }
  for (const hint of NAME_HINTS) {
    if (hint.pattern.test(name)) {
      return { businessType: hint.businessType, keywords: hint.keywords, scope: hint.scope, confidence: 0.75, source: 'rules' }
    }
  }
  for (const code of sicCodes) {
    const o = SIC_OVERRIDES[code]
    if (o) return { businessType: o.businessType, keywords: o.keywords, scope: o.scope, confidence: 0.7, source: 'rules' }
  }
  for (const g of SIC_GUARDS) {
    if (g.pattern.test(sicText)) {
      return { businessType: g.businessType, keywords: g.keywords, scope: g.scope, confidence: 0.6, source: 'rules' }
    }
  }
  return {
    businessType: 'general services',
    keywords: ['local services', 'service provider', 'consultancy', 'business services'],
    scope: 'local',
    confidence: 0.3,
    source: 'rules',
  }
}

/**
 * Hold a model's answer to the guard rails. The model can describe the
 * business better than any table, but it cannot be allowed to put a payments
 * company in competition with kebab shops.
 */
export function applyGuards(
  guess: ProfileGuess,
  companyName: string,
  sicCodes: readonly string[],
): ProfileGuess {
  const sicText = sicCodes.join(' ')
  let { keywords, scope, businessType } = guess
  let forbidFood: boolean | null = null

  for (const g of SIC_GUARDS) {
    if (g.pattern.test(sicText)) {
      scope = g.scope
      forbidFood = g.forbidFood
      // A veto guard also decides what the business is when the answer
      // contradicts it (a holding company always; finance when called food).
      if (g.veto && (g.businessType.startsWith('corporate') || [...FOOD_TERMS].some((f) => businessType.toLowerCase().includes(f)))) {
        businessType = g.businessType
      }
      keywords = keywords.length ? dedupe([...keywords, ...g.keywords]) : g.keywords
      break
    }
  }

  // Food is allowed only when the SIC code or the name actually says food.
  const saysFood = /\b56\d{3}\b/.test(sicText) || /\b(restaurant|takeaway|pizza|kebab|burger|cafe|coffee|bakery|food)\b/i.test(companyName)
  if (forbidFood || (forbidFood === null && !saysFood)) {
    keywords = keywords.filter((k) => !FOOD_TERMS.has(k.toLowerCase()))
  }

  keywords = dedupe(keywords).slice(0, 10)
  if (keywords.length === 0) {
    const fallback = classifyByRules(companyName, sicCodes)
    return { ...fallback, confidence: Math.min(guess.confidence, fallback.confidence) }
  }
  return { ...guess, businessType, keywords, scope }
}

/** A sensible default radius for local discovery by scope. */
export function defaultRadiusKm(scope: Scope): number {
  return scope === 'local' ? 8 : scope === 'hybrid' ? 25 : 50
}

/** Bare host from a URL or a typed domain. Null when it is not a usable public host. */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`
  let host: string
  try {
    host = new URL(s).hostname
  } catch {
    return null
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  if (/^\d+(\.\d+){3}$/.test(host)) return null
  return host
}

/** UK postcode, normalised to "AB1 2CD". Null when it is not one. */
export function normalisePostcode(input: string | null | undefined): string | null {
  const raw = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = raw.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/)
  return m ? `${m[1]} ${m[2]}` : null
}

const POSTCODE_IN_TEXT = /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/i

export function postcodeIn(address: string | null | undefined): string | null {
  const m = (address ?? '').match(POSTCODE_IN_TEXT)
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null
}
