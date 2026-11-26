import 'server-only'
import { classifyCandidates, emptyCandidate, isExcludedDomain, mergeCandidates } from './discovery'
import { simulatedCandidates } from './simulator'
import { configured, serpProvider } from './sources/config'
import { placesTextSearch } from './sources/places'
import { sameSicCompanies } from './sources/register'
import { googleSearch, sharedKeywordCompetitors, type SerpResult } from './sources/serp'
import type { Candidate, CandidateVerification, ClassifiedCandidate, CompanyProfile, SourceRun } from './types'
import { cachedSerp } from './serp-cache'
import { judgeWeakMatch, verifyAll } from './verify'
import { resolveVocabulary } from './vocab-generate'

/**
 * Discovery, the impure half: ask every configured source who competes for
 * this profile, then hand the lot to `classifyCandidates`.
 *
 * Mirrors the prototype's flow — local Maps search around the postcode for
 * every keyword, UK-wide Maps search when the business is hybrid or national,
 * same-SIC companies from the register — and adds the two signals that find
 * online competitors: who ranks on Google for the profile's searches, and who
 * advertises on them.
 *
 * When no discovery source is configured at all, the simulator supplies a
 * fictional market and every row is marked simulated.
 */

export type DiscoveryResult = {
  direct: ClassifiedCandidate[]
  indirect: ClassifiedCandidate[]
  /** The trade next door: found by the same searches, but never a rival. */
  referral: ClassifiedCandidate[]
  /** How many candidates had their website read. */
  verified: number
  simulated: boolean
  runs: SourceRun[]
  /** SERPs fetched during discovery, reused by the scans that follow. */
  serps: SerpResult[]
}

const MAX_KEYWORDS = 6

/** How many candidate websites one discovery run may read. */
const MAX_VERIFY = 45

/** What a business calls itself in a search result title: "Fees | Smith & Co" → "Smith & Co". */
export function brandFromTitle(title: string, domain: string): string {
  const parts = title
    .split(/\s[|\-–—:·]\s/)
    .map((p) => p.trim())
    .filter(Boolean)
  const label = domain.split('.')[0].replace(/-/g, ' ')
  const fromDomain = label.replace(/\b\w/g, (c) => c.toUpperCase())
  if (parts.length < 2) return fromDomain
  const last = parts[parts.length - 1]
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  // Prefer the segment that looks like the domain.
  const match = parts.find((p) => squash(p).includes(squash(label)) || squash(label).includes(squash(p)))
  const pickPart = match ?? last
  return pickPart.length <= 48 ? pickPart : fromDomain
}

function searchQuery(keyword: string, profile: CompanyProfile): string {
  // A local business competes on "plumber Leeds", not on "plumber".
  return profile.scope === 'local' && profile.locality ? `${keyword} ${profile.locality}` : keyword
}

export function candidatesFromSerp(serp: SerpResult, profileKeyword: string): Candidate[] {
  const out: Candidate[] = []
  for (const o of serp.organic.filter((x) => x.position <= 10)) {
    if (!o.domain || isExcludedDomain(o.domain)) continue
    const c = emptyCandidate(brandFromTitle(o.title, o.domain), 'organic')
    c.domain = o.domain
    c.organicHits = 1
    c.bestPosition = o.position
    c.matchedKeywords = [profileKeyword]
    out.push(c)
  }
  for (const a of serp.ads) {
    if (!a.domain || isExcludedDomain(a.domain)) continue
    const c = emptyCandidate(brandFromTitle(a.headline, a.domain), 'paid')
    c.domain = a.domain
    c.paidHits = 1
    c.matchedKeywords = [profileKeyword]
    out.push(c)
  }
  for (const l of serp.local) {
    if (!l.title) continue
    const c = emptyCandidate(l.title, 'places_local')
    c.domain = l.domain
    c.rating = l.rating
    c.reviewCount = l.reviews
    c.matchedKeywords = [profileKeyword]
    out.push(c)
  }
  return out
}

async function timed<T>(
  source: SourceRun['source'],
  provider: string,
  fn: () => Promise<T>,
  count: (v: T) => number,
  runs: SourceRun[],
): Promise<T | null> {
  const started = Date.now()
  try {
    const v = await fn()
    runs.push({ source, status: 'ok', provider, note: '', items: count(v), ms: Date.now() - started })
    return v
  } catch (e) {
    runs.push({ source, status: 'error', provider, note: (e as Error).message.slice(0, 300), items: 0, ms: Date.now() - started })
    return null
  }
}

export async function discover(
  profile: CompanyProfile,
  opts: { dismissed?: ReadonlySet<string>; workspaceId?: string; userId?: string | null } = {},
): Promise<DiscoveryResult> {
  const runs: SourceRun[] = []
  const found: Candidate[] = []
  const serps: SerpResult[] = []
  /*
   * A thin profile is topped up from the trade vocabulary. One keyword is not
   * enough to tell a competitor from a passer-by: it narrows what discovery
   * looks for, and it makes the organic-hit ratio meaningless, because one
   * appearance out of one search reads as total dominance.
   */
  const { vocab, source: vocabSource } = await resolveVocabulary({
    workspaceId: opts.workspaceId ?? '',
    userId: opts.userId ?? null,
    profile,
  })
  const extra = vocab.searchTerms.filter(
    (t) => !profile.keywords.some((k) => k.toLowerCase().includes(t) || t.includes(k.toLowerCase())),
  )
  const keywords = [...profile.keywords, ...extra].slice(0, MAX_KEYWORDS)

  /* Google Maps: local around the postcode, UK-wide when the business is not purely local. */
  if (configured('places') && keywords.length) {
    const near =
      profile.lat !== null && profile.lng !== null ? { lat: profile.lat, lng: profile.lng, radiusKm: profile.radiusKm } : null
    if (near) {
      const local = await timed(
        'places',
        'Google Places (nearby)',
        async () => (await Promise.all(keywords.map((k) => placesTextSearch(k, near)))).flat(),
        (v) => v.length,
        runs,
      )
      if (local) found.push(...local)
    }
    if (profile.scope !== 'local' || !near) {
      const national = await timed(
        'places',
        'Google Places (UK-wide)',
        async () =>
          (await Promise.all(keywords.map((k) => placesTextSearch(k, null, { pages: profile.scope === 'national' ? 2 : 1 })))).flat(),
        (v) => v.length,
        runs,
      )
      if (national) found.push(...national)
    }
  } else {
    runs.push({ source: 'places', status: 'skipped', provider: 'Google Places', note: 'GOOGLE_PLACES_API_KEY is not set.', items: 0, ms: 0 })
  }

  /* Google search: who ranks and who advertises on the same searches. */
  const provider = serpProvider()
  if (provider && keywords.length) {
    const res = await timed(
      'serp',
      provider === 'dataforseo' ? 'DataForSEO' : provider === 'serpapi' ? 'SerpApi' : 'Serper',
      async () => {
        const out: SerpResult[] = []
        for (const k of keywords) {
          const r = await cachedSerp(searchQuery(k, profile), () => googleSearch(searchQuery(k, profile)))
          if (r) out.push({ ...r, keyword: k })
        }
        return out
      },
      (v) => v.reduce((a, r) => a + r.organic.length + r.ads.length, 0),
      runs,
    )
    for (const r of res ?? []) {
      serps.push(r)
      found.push(...candidatesFromSerp(r, r.keyword))
    }
  } else {
    runs.push({
      source: 'serp',
      status: 'skipped',
      provider: 'Google search',
      note: 'No search provider set (DATAFORSEO_LOGIN, SERPAPI_API_KEY or SERPER_API_KEY).',
      items: 0,
      ms: 0,
    })
  }

  /* Keyword database: domains that share the most keywords with ours. */
  if (profile.domain && configured('dataforseo')) {
    const shared = await timed('keywords', 'DataForSEO Labs', () => sharedKeywordCompetitors(profile.domain!), (v) => v?.length ?? 0, runs)
    for (const s of shared ?? []) {
      if (isExcludedDomain(s.domain)) continue
      const c = emptyCandidate(s.domain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase()), 'dataforseo')
      c.domain = s.domain
      c.sharedKeywords = s.shared
      found.push(c)
    }
  }

  /* The register: same SIC codes, same locality. Breadth, weakly weighted. */
  if (configured('companies_house') && profile.sicCodes.length) {
    const ch = await timed(
      'companies_house',
      'Companies House',
      () => sameSicCompanies(profile.sicCodes, profile.scope === 'national' ? null : profile.locality),
      (v) => v.length,
      runs,
    )
    if (ch) found.push(...ch)
  } else if (!configured('companies_house')) {
    runs.push({ source: 'companies_house', status: 'skipped', provider: 'Companies House', note: 'COMPANIES_HOUSE_API_KEY is not set.', items: 0, ms: 0 })
  }

  /* Nothing real to go on: a fictional market, clearly marked. */
  const realFinds = found.filter((c) => !c.sources.includes('companies_house'))
  const simulated = realFinds.length === 0
  if (simulated) {
    found.push(...simulatedCandidates(profile))
    runs.push({
      source: 'simulator',
      status: 'simulated',
      provider: 'Simulator',
      note: 'No discovery source returned results, so a fictional market was generated. Add a Places or search key for real competitors, or add competitors by web address.',
      items: 8,
      ms: 0,
    })
  }

  /*
   * Verification. Every candidate's own website is read and checked against
   * the trade vocabulary before anything is called a competitor. This is the
   * step whose absence let Google Places' loose local matching fill the list
   * with accountants: they are near, they are well reviewed, and their pages
   * mention closing a company — but their websites sell accounts and payroll.
   *
   * Candidates already dismissed are skipped, so the fetches are spent only
   * on businesses that could still end up on the list.
   */
  const verifiable = mergeCandidates(found).filter(
    (c) => !isExcludedDomain(c.domain) && !opts.dismissed?.has(c.key) && !c.sources.includes('simulated'),
  )
  /*
   * Bound the work. Reading a hundred websites takes longer than a serverless
   * function is allowed to live, so the cheap signals pick which ones are
   * worth a fetch. Anything not read stays `unknown`, which can be suggested
   * but never auto-tracked — the safe direction to fail in.
   */
  const preScore = (c: Candidate) =>
    c.organicHits * 10 +
    c.paidHits * 8 +
    (c.sources.includes('manual') ? 100 : 0) +
    (c.domain ? 5 : 0) +
    Math.min(5, Math.log10(1 + c.reviewCount) * 2)
  const toVerify = [...verifiable].sort((a, b) => preScore(b) - preScore(a)).slice(0, MAX_VERIFY)
  const started = Date.now()
  const checked = await verifyAll(toVerify, vocab)

  /* The model breaks only the ties the vocabulary could not. */
  if (opts.workspaceId) {
    const weak = [...checked.entries()].filter(([, v]) => v.verdict === 'weak').slice(0, 8)
    for (const [key, v] of weak) {
      const cand = toVerify.find((c) => c.key === key)
      if (!cand) continue
      try {
        checked.set(
          key,
          await judgeWeakMatch({
            workspaceId: opts.workspaceId,
            userId: opts.userId ?? null,
            profile,
            candidate: cand,
            verification: v,
          }),
        )
      } catch {
        /* Keep the website verdict when the model is unavailable. */
      }
    }
  }

  const verified: Map<string, CandidateVerification> = new Map(
    [...checked.entries()].map(([k, v]) => [
      k,
      {
        verdict: v.verdict,
        confidence: v.confidence,
        note: v.note,
        decidedBy: v.decidedBy,
        serviceTerms: v.evidence ? [...v.evidence.strongHits, ...v.evidence.supportingHits].slice(0, 8) : [],
        otherTradeTerms: v.evidence ? v.evidence.adjacentHits.slice(0, 8) : [],
      },
    ]),
  )
  const read = [...checked.values()].filter((v) => v.decidedBy === 'website' || v.decidedBy === 'model').length
  runs.push({
    source: 'website',
    status: read > 0 ? 'ok' : 'skipped',
    provider: 'Website check',
    note:
      (read > 0
        ? `Read ${read} of ${verifiable.length} candidate websites to confirm they sell what you sell. `
        : 'No candidate websites could be read; relevance is unconfirmed. ') +
      (vocabSource === 'curated'
        ? 'Judged against the built-in vocabulary for your trade.'
        : vocabSource === 'generated'
          ? `Judged against a vocabulary written for "${profile.businessType}" and reused from here on.`
          : 'Judged against your own business type and search terms.'),
    items: read,
    ms: Date.now() - started,
  })

  const { direct, indirect, referral } = classifyCandidates(found, profile, {
    dismissed: opts.dismissed,
    verified,
    keywordCount: keywords.length,
  })
  return { direct, indirect, referral, simulated, runs, serps, verified: read }
}
