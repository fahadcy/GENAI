/**
 * What a trade actually sells, and what the trade next door sells.
 *
 * Discovery's old failure was structural: Google Places, asked for
 * "insolvency practitioner" near Stoke, returns accountants — and nothing
 * downstream ever checked. A chartered accountant two streets away with a
 * five-star profile outscored Begbies Traynor, because proximity and reviews
 * were weighted like relevance while relevance itself was never measured.
 *
 * The fix is to measure it. A business is a competitor when its own website
 * says it sells what you sell, and the cheapest reliable way to know that is
 * a vocabulary: the words a firm in that trade cannot avoid using, and the
 * words that mark the adjacent trade it is easy to confuse with.
 *
 * Everything here is pure data and pure functions, so the judgement that
 * decides who competes with you is reproducible, free to run, and testable
 * without a network. The model is used later, and only to break ties.
 */

/** A term and what it is worth. Phrases beat single words, so they score higher. */
export type Term = { term: string; weight: number }

export type TradeVocabulary = {
  id: string
  label: string
  /** Terms that, on a homepage, settle it. */
  strong: Term[]
  /** Terms consistent with the trade but not proof on their own. */
  supporting: Term[]
  /**
   * The neighbouring trade. For an insolvency practitioner this is
   * accountancy: a firm whose site is all payroll, VAT and self-assessment is
   * a referral partner, not a rival, however close it is.
   */
  adjacent: Term[]
  /** Words in a business name that nearly always mean the adjacent trade. */
  adjacentNameHints: string[]
  /**
   * What a customer actually types. A profile with one keyword starves the
   * search signal — and worse, makes a single page-one appearance look like
   * total search dominance — so discovery tops the list up from here.
   */
  searchTerms: string[]
}

const t = (term: string, weight: number): Term => ({ term, weight })

/* ------------------------------------------------------------- insolvency */

const INSOLVENCY: TradeVocabulary = {
  id: 'insolvency',
  label: 'Insolvency and corporate recovery',
  strong: [
    t('licensed insolvency practitioner', 6),
    t('insolvency practitioner', 5),
    t('creditors voluntary liquidation', 5),
    t('members voluntary liquidation', 5),
    t('compulsory liquidation', 4),
    t('company voluntary arrangement', 5),
    t('winding up petition', 5),
    t('winding-up petition', 5),
    t('pre-pack administration', 5),
    t('pre pack administration', 5),
    t('administration order', 4),
    t('company liquidation', 4),
    t('business rescue', 4),
    t('corporate recovery', 4),
    t('corporate insolvency', 4),
    t('individual voluntary arrangement', 4),
    t('bankruptcy petition', 4),
    t('insolvency service', 3),
    t('liquidator', 4),
    t('liquidation', 3),
    t('insolvency', 3),
  ],
  supporting: [
    t('cvl', 2),
    t('mvl', 2),
    t('cva', 2),
    t('iva', 2),
    t('company closure', 2),
    t('close my company', 2),
    t('strike off', 2),
    t('striking off', 2),
    t('receivership', 2),
    t('administrator', 1),
    t('turnaround', 2),
    t('restructuring', 2),
    t('debt relief order', 2),
    t('creditor pressure', 2),
    t('hmrc debt', 2),
    t('bounce back loan', 2),
    t('director duties', 1),
    t('wrongful trading', 2),
    t('r3', 1),
    t('insolvency act', 2),
  ],
  adjacent: [
    t('chartered accountant', 3),
    t('certified accountant', 3),
    t('chartered certified', 3),
    t('bookkeeping', 3),
    t('book-keeping', 3),
    t('payroll', 3),
    t('vat return', 3),
    t('vat returns', 3),
    t('self assessment', 3),
    t('self-assessment', 3),
    t('tax return', 2),
    t('corporation tax', 2),
    t('management accounts', 3),
    t('annual accounts', 2),
    t('year end accounts', 3),
    t('tax planning', 2),
    t('tax adviser', 3),
    t('tax advisor', 3),
    t('capital allowance', 3),
    t('r&d tax', 3),
    t('research and development tax', 3),
    t('xero', 2),
    t('quickbooks', 2),
    t('freeagent', 2),
    t('sage accounting', 2),
    t('making tax digital', 3),
    t('cis returns', 2),
    t('company formation', 1),
    t('audit services', 2),
  ],
  adjacentNameHints: [
    'accountant',
    'accountants',
    'accountancy',
    'bookkeeping',
    'book-keeping',
    'tax solutions',
    'tax advisers',
    'tax advisors',
    'tax consultants',
    'payroll',
    'chartered certified',
  ],
  searchTerms: [
    'insolvency practitioner',
    'company liquidation',
    'creditors voluntary liquidation',
    'company administration',
    'company voluntary arrangement',
    'winding up petition',
    'business rescue',
    'close my limited company',
  ],
}

/* ------------------------------------------------------------ the library */

const LIBRARY: TradeVocabulary[] = [INSOLVENCY]

/**
 * Which vocabulary fits this business. Matched on the business type and the
 * profile's own search terms, so a workspace that calls itself "corporate
 * recovery" lands on the same list as one that says "insolvency".
 */
export function vocabularyFor(businessType: string, keywords: readonly string[]): TradeVocabulary | null {
  const hay = `${businessType} ${keywords.join(' ')}`.toLowerCase()
  for (const v of LIBRARY) {
    // Whole-word matching, for the same reason as `found` below: a dental
    // practice whose keywords include "private dentist" was being handed the
    // insolvency vocabulary, because "iva" hides inside "pr-iva-te". Every
    // candidate then scored zero and the whole list came back as unrelated.
    if (v.strong.some((x) => found(hay, x.term)) || v.supporting.some((x) => found(hay, x.term))) return v
  }
  return null
}

/**
 * A vocabulary built from the profile itself, for trades the library does not
 * cover yet. Weaker than a curated list — it cannot know the adjacent trade —
 * but far better than no check at all.
 */
export function genericVocabulary(businessType: string, keywords: readonly string[]): TradeVocabulary {
  const phrases = new Set<string>()
  const words = new Set<string>()
  for (const raw of [businessType, ...keywords]) {
    const k = raw.toLowerCase().trim()
    if (k.length >= 5 && k.includes(' ')) phrases.add(k)
    for (const w of k.split(/[^a-z0-9]+/)) {
      if (w.length >= 5 && !GENERIC_STOP.has(w)) words.add(w)
    }
  }
  return {
    id: 'generic',
    label: businessType || 'Your trade',
    strong: [...phrases].map((p) => t(p, 5)),
    supporting: [...words].map((w) => t(w, 2)),
    adjacent: [],
    adjacentNameHints: [],
    searchTerms: [...phrases].slice(0, 8),
  }
}

const GENERIC_STOP = new Set([
  'about',
  'above',
  'after',
  'business',
  'companies',
  'company',
  'group',
  'limited',
  'local',
  'other',
  'professional',
  'service',
  'services',
  'solutions',
  'their',
  'there',
  'these',
  'those',
  'which',
  'while',
  'your',
])

/* --------------------------------------------------------------- scoring */

export type TradeEvidence = {
  /** Sum of matched strong and supporting weights, with headline matches doubled. */
  score: number
  /** Sum of matched adjacent weights. */
  adjacentScore: number
  /** The strong terms found, for the "why" shown to a person. */
  strongHits: string[]
  supportingHits: string[]
  adjacentHits: string[]
  /** True when a strong term appears in the title, headings or meta description. */
  inHeadline: boolean
}

const BOUNDARY = new Map<string, RegExp>()

/**
 * Match on a word boundary, not a bare substring.
 *
 * The first run of this check put Deloitte, Trading Standards and a revision
 * website in the results because "iva" appears inside "pr-iva-te". Anchoring
 * the start of the term fixes that while still matching plurals and suffixes,
 * so "liquidation" continues to find "liquidations".
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function found(hay: string, term: string): boolean {
  let re = BOUNDARY.get(term)
  if (!re) {
    re = new RegExp(`\\b${escapeRe(term)}`, 'i')
    BOUNDARY.set(term, re)
  }
  return re.test(hay)
}

/**
 * Score a block of page text against a vocabulary.
 *
 * `headline` is the title, meta description and H1/H2 text. A firm that puts
 * "Licensed Insolvency Practitioners" in its H1 has settled the question; the
 * same phrase buried once in a footer has not, so headline matches count
 * double and set `inHeadline`.
 */
export function scoreTrade(
  vocab: TradeVocabulary,
  body: string,
  headline: string,
  name = '',
): TradeEvidence {
  const b = ` ${body.toLowerCase()} `
  const h = ` ${headline.toLowerCase()} `
  const n = ` ${name.toLowerCase()} `

  let score = 0
  let inHeadline = false
  const strongHits: string[] = []
  const supportingHits: string[] = []
  const adjacentHits: string[] = []

  for (const { term, weight } of vocab.strong) {
    const inH = found(h, term) || found(n, term)
    const inB = found(b, term)
    if (!inH && !inB) continue
    strongHits.push(term)
    score += inH ? weight * 2 : weight
    if (inH) inHeadline = true
  }
  for (const { term, weight } of vocab.supporting) {
    const inH = found(h, term) || found(n, term)
    const inB = found(b, term)
    if (!inH && !inB) continue
    supportingHits.push(term)
    score += inH ? weight * 2 : weight
  }

  let adjacentScore = 0
  for (const { term, weight } of vocab.adjacent) {
    const inH = found(h, term) || found(n, term)
    const inB = found(b, term)
    if (!inH && !inB) continue
    adjacentHits.push(term)
    adjacentScore += inH ? weight * 2 : weight
  }
  for (const hint of vocab.adjacentNameHints) {
    if (found(n, hint)) {
      adjacentScore += 6
      if (!adjacentHits.includes(hint)) adjacentHits.push(hint)
    }
  }

  return { score, adjacentScore, strongHits, supportingHits, adjacentHits, inHeadline }
}

export type TradeVerdict = 'match' | 'weak' | 'adjacent' | 'unrelated' | 'unknown'

/**
 * Turn evidence into a verdict.
 *
 * The thresholds encode one rule: selling the service beats being nearby.
 * A firm whose headline names the service is a match even if it also does
 * accounts; a firm whose site is accountancy with one passing mention of
 * insolvency is adjacent, which is to say a referral partner.
 */
export function verdictFrom(e: TradeEvidence): TradeVerdict {
  const net = e.score - e.adjacentScore * 0.6
  if (e.inHeadline && e.score >= 8) return 'match'
  if (e.score >= 12 && net >= 4) return 'match'
  if (e.score >= 6 && net >= 2) return 'weak'
  if (e.adjacentScore >= 6 && e.score < 6) return 'adjacent'
  if (e.score > 0) return 'weak'
  return 'unrelated'
}

/** One short line a person can read, explaining the verdict. */
export function evidenceLine(e: TradeEvidence, verdict: TradeVerdict): string {
  const top = [...e.strongHits, ...e.supportingHits].slice(0, 3)
  if (verdict === 'match') {
    return top.length
      ? `Website sells ${top.join(', ')}${e.inHeadline ? ' — said in the page headline' : ''}`
      : 'Website matches your services'
  }
  if (verdict === 'weak') {
    return top.length ? `Website mentions ${top.join(', ')}, but not prominently` : 'Only a weak match on the website'
  }
  if (verdict === 'adjacent') {
    const adj = e.adjacentHits.slice(0, 3)
    return `Looks like the trade next door${adj.length ? ` (${adj.join(', ')})` : ''} — a referral partner rather than a rival`
  }
  if (verdict === 'unknown') return 'Could not read the website'
  return 'Website does not sell what you sell'
}

/* ------------------------------------------- generated vocabularies */

/**
 * Words too common to prove anything. A strong term of "services" matches
 * every business on earth, which would make every candidate a competitor —
 * the exact failure this module exists to prevent.
 */
const BANNED = new Set([
  'about',
  'business',
  'businesses',
  'client',
  'clients',
  'companies',
  'company',
  'consultancy',
  'consultant',
  'consulting',
  'contact',
  'customer',
  'customers',
  'experience',
  'expert',
  'experts',
  'firm',
  'group',
  'help',
  'limited',
  'local',
  'ltd',
  'management',
  'online',
  'partner',
  'partners',
  'people',
  'price',
  'pricing',
  'professional',
  'quality',
  'quote',
  'service',
  'services',
  'solution',
  'solutions',
  'specialist',
  'specialists',
  'support',
  'team',
  'trusted',
  'uk',
  'work',
])

/** Three- and four-letter words that are not terms of art. */
const SHORT_NOISE = new Set(['and', 'are', 'for', 'from', 'has', 'have', 'into', 'its', 'not', 'our', 'out', 'the', 'this', 'that', 'was', 'were', 'who', 'will', 'with', 'you', 'your'])

export const clean = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Drop what cannot carry weight: banned generics, anything under four
 * characters, and duplicates. Multi-word phrases are kept at three characters
 * per word because "cva" and "mvl" are real terms of art — they survive
 * because `scoreTrade` matches on word boundaries.
 */
function sanitise(terms: readonly string[], allowShortAcronyms: boolean): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of terms) {
    const t = clean(raw)
    if (!t || seen.has(t)) continue
    if (BANNED.has(t)) continue
    const acronym = allowShortAcronyms && /^[a-z]{3,4}$/.test(t) && !SHORT_NOISE.has(t)
    if (t.length < 4 && !acronym) continue
    // A phrase made only of banned words is just as useless as one banned word.
    if (t.includes(' ') && t.split(' ').every((w) => BANNED.has(w))) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Phrases earn more than single words: they are far harder to match by accident. */
const weigh = (t: string, phraseWeight: number, wordWeight: number): Term => ({
  term: t,
  weight: t.includes(' ') ? phraseWeight : wordWeight,
})

/** The shape a generated vocabulary arrives in, before it is trusted. */
export type RawVocabulary = {
  strong: string[]
  supporting: string[]
  adjacent: string[]
  adjacentNameHints: string[]
  searchTerms: string[]
}

export function buildVocabulary(
  id: string,
  label: string,
  raw: RawVocabulary,
): TradeVocabulary | null {
  const strong = sanitise(raw.strong, true).map((t) => weigh(t, 5, 3))
  const supporting = sanitise(raw.supporting, true).map((t) => weigh(t, 2, 1))
  const adjacent = sanitise(raw.adjacent, false).map((t) => weigh(t, 3, 2))
  const adjacentNameHints = sanitise(raw.adjacentNameHints, false)
  const searchTerms = sanitise(raw.searchTerms, false).filter((t) => t.includes(' ')).slice(0, 8)

  // Too thin to judge anything. Better to fall back than to score everything
  // at zero and call every competitor "unrelated".
  if (strong.length < 3) return null

  return { id, label, strong, supporting, adjacent, adjacentNameHints, searchTerms }
}
