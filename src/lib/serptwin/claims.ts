/**
 * The claim taxonomy.
 *
 * A headline is not a unit of meaning; a claim is. "Book a demo in 2 minutes"
 * and "Setup takes minutes, not weeks" are different words making the same
 * SPEED promise. Scoring claims instead of strings lets evidence pool across
 * every ad group, and lets a finding from paid be carried into an organic
 * title, which never shares a single string with the ad.
 */

export type Claim =
  | 'price'
  | 'speed'
  | 'proof'
  | 'risk_reversal'
  | 'outcome'
  | 'authority'
  | 'specificity'
  | 'urgency'
  | 'audience'
  | 'cta'
  | 'feature'

export const CLAIM_LABEL: Record<Claim, string> = {
  price: 'Price / value',
  speed: 'Speed',
  proof: 'Social proof',
  risk_reversal: 'Risk reversal',
  outcome: 'Outcome',
  authority: 'Authority',
  specificity: 'Specific number',
  urgency: 'Urgency',
  audience: 'Audience fit',
  cta: 'Call to action',
  feature: 'Feature',
}

/** Plain-English definition shown beside each claim in the UI. */
export const CLAIM_DEFINITION: Record<Claim, string> = {
  price: 'Mentions cost, savings, or a price point.',
  speed: 'Promises something happens fast.',
  proof: 'Points to other customers, ratings, or reviews.',
  risk_reversal: 'Removes the cost of being wrong — no contract, cancel anytime, free trial.',
  outcome: 'Names the result the buyer gets.',
  authority: 'Borrows credibility — certified, partner, award-winning.',
  specificity: 'Contains a concrete number.',
  urgency: 'Asks the reader to act now.',
  audience: 'Names who it is for.',
  cta: 'Tells the reader what to do.',
  feature: 'Describes what the product has.',
}

const PATTERNS: Record<Claim, RegExp> = {
  price:
    /(£|\$|€)\s?\d|\b(price|pricing|cost|cheap|affordable|save|savings|budget|per month|\/mo|low cost|no hidden fees)\b/,
  speed:
    /\b(fast|faster|quick|quickly|instant|instantly|minutes?|same[- ]day|today|in \d+ (days?|hours?|weeks?)|overnight|rapid|real[- ]time)\b/,
  // "review" alone is usually a verb ("review and publish"), so only review *counts* and sites count.
  proof:
    /\b(trusted by|rated|★|\d(\.\d)? stars?|\d[\d,]*\+? (reviews|reviewers|customers|clients|brands|teams|companies|marketers)|reviews? on|case stud(y|ies)|g2|capterra|trustpilot)\b/,
  risk_reversal:
    /\b(no contract|cancel anytime|free (\d+[- ]day )?trial|money[- ]back|no card|no credit card|risk[- ]free|guarantee[d]? refund|try (it )?free|no setup fee|month[- ]to[- ]month|free (confidential |initial |no[- ]obligation )?(consultation|advice)|no[- ]obligation)\b/,
  outcome:
    /\b(grow|growth|increase|more (leads|sales|revenue|pipeline|demos)|boost|double|roi|results|convert|conversions|pipeline|revenue)\b/,
  authority:
    /\b(certified|partner|official|award[- ]winning|accredited|expert|experts|leading|premier|iso ?27001|gdpr[- ]compliant|soc ?2|licensed|regulated|ipa|r3|\d+\+? years'?( of)? experience)\b/,
  // A digit that starts a token: "£49", "1,200+", "14-day" — not the 2 in "B2B".
  specificity: /(^|[\s£$€(])\d/,
  urgency: /\b(now|today only|limited|ends|hurry|last chance|this week|don't miss|before)\b/,
  audience:
    /\b(for (teams|b2b|smbs?|agencies|startups|enterprises?|marketers|heads of marketing|small business(es)?|uk (businesses|companies))|b2b|uk[- ]based|built for)\b/,
  cta: /^(book|get|start|try|see|request|claim|join|download|schedule|talk|contact|discover|compare)\b/,
  feature:
    /\b(ai|automate|automation|automated|dashboard|integrations?|workflows?|templates?|analytics|reporting|crm|api|drag[- ]and[- ]drop)\b/,
}

export const ALL_CLAIMS = Object.keys(PATTERNS) as Claim[]

export function extractClaims(text: string): Claim[] {
  const t = text.toLowerCase().trim()
  return ALL_CLAIMS.filter((c) => PATTERNS[c].test(t))
}

/**
 * Claims that must be substantiated on the landing page before they can be
 * written into an organic title. Google's snippet policy and the ASA both
 * treat an unsubstantiated price or guarantee in a title as misleading.
 */
export const NEEDS_SUBSTANTIATION: ReadonlySet<Claim> = new Set([
  'price',
  'proof',
  'risk_reversal',
  'specificity',
])

/**
 * Claims never transferred into organic titles: urgency decays (a title is
 * cached for weeks) and a bare CTA wastes organic title space.
 */
export const NOT_TRANSFERABLE: ReadonlySet<Claim> = new Set(['urgency', 'cta'])
