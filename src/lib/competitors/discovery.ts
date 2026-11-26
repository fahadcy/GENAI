/**
 * Discovery, the pure half: merge what the sources found, drop what is not a
 * competitor, and rank the rest.
 *
 * Ported from `classify_competitors2`, `unique_google_competitors` and the
 * local/virtual re-weighting in the prototype's `/company` route, with two
 * additions the prototype could not make because it only had Google Maps:
 *
 *  - A business that ranks or advertises on the same searches is a
 *    competitor even if its name and Maps category say nothing. That is
 *    usually the competitor that matters most online.
 *  - The same business found by Maps, by search and on the register is one
 *    competitor, not three.
 *
 * No I/O. The collectors in `./sources` produce candidates; this decides.
 */

import { dedupe, normaliseDomain } from './profile'
import type {
  Candidate,
  CandidateVerification,
  ClassifiedCandidate,
  CompanyProfile,
  CompetitorKind,
  CompetitorTier,
  DiscoverySource,
} from './types'

/**
 * Hosts that list businesses rather than being one. A directory ranking for
 * "plumber Leeds" is not a plumber.
 */
export const EXCLUDED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'quora.com',
  'wikipedia.org',
  'yelp.com',
  'yelp.co.uk',
  'tripadvisor.co.uk',
  'tripadvisor.com',
  'opentable.co.uk',
  'foursquare.com',
  'google.com',
  'google.co.uk',
  'goo.gl',
  'maps.app.goo.gl',
  'ubereats.com',
  'deliveroo.co.uk',
  'just-eat.co.uk',
  'yell.com',
  'thomsonlocal.com',
  'checkatrade.com',
  'trustatrader.com',
  'mybuilder.com',
  'ratedpeople.com',
  'bark.com',
  'trustpilot.com',
  'uk.trustpilot.com',
  'reviews.co.uk',
  'feefo.com',
  'find-and-update.company-information.service.gov.uk',
  'company-information.service.gov.uk',
  'companieshouse.gov.uk',
  'gov.uk',
  'nhs.uk',
  'endole.co.uk',
  'companycheck.co.uk',
  'opencorporates.com',
  'bizdb.co.uk',
  'cylex-uk.co.uk',
  'scoot.co.uk',
  'freeindex.co.uk',
  'hotfrog.co.uk',
  'indeed.com',
  'indeed.co.uk',
  'glassdoor.co.uk',
  'glassdoor.com',
  'reed.co.uk',
  'totaljobs.com',
  'amazon.co.uk',
  'amazon.com',
  'ebay.co.uk',
  'bbc.co.uk',
  'theguardian.com',
  'which.co.uk',
  'moneysavingexpert.com',
  'citizensadvice.org.uk',

  // Company-data aggregators and business-for-sale listings. These ranked for
  // "insolvency practitioner" and were being suggested as rivals.
  'companiesintheuk.co.uk',
  'kompass.com',
  'mapquest.com',
  'wheree.com',
  'beauhurst.com',
  'business-sale.com',
  'creditsafe.co.uk',
  'creditsafe.com',
  'dnb.com',
  'crunchbase.com',
  'zoominfo.com',
  'apollo.io',
  'globaldatabase.com',
  'companiesinuk.co.uk',
  'bizstats.co.uk',
  'companydirectorcheck.com',
  '192.com',
  'thomsonlocal.co.uk',

  // Statutory notices, regulators and professional bodies. They publish the
  // appointments, they do not compete for the work.
  'thegazette.co.uk',
  'london-gazette.co.uk',
  'insolvencydirect.bis.gov.uk',
  'r3.org.uk',
  'icaew.com',
  'accaglobal.com',
  'cipfa.org',
  'iplsupport.co.uk',
  'insolvency-practitioners.org.uk',

  // Trade press and advice publishers.
  'accountingweb.co.uk',
  'economia.icaew.com',
  'ft.com',
  'telegraph.co.uk',
  'thetimes.co.uk',
  'dailymail.co.uk',
  'businessmatters.co.uk',
  'startups.co.uk',
  'simplybusiness.co.uk',
  'stepchange.org',
  'nationaldebtline.org',
  'businessdebtline.org',
] as const

const EXCLUDED = new Set<string>(EXCLUDED_DOMAINS)

export function isExcludedDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  const d = domain.toLowerCase().replace(/^www\./, '')
  if (EXCLUDED.has(d)) return true
  for (const x of EXCLUDED) if (d.endsWith(`.${x}`)) return true
  // Government and public bodies are context, not competition.
  return /\.(gov|nhs|police|ac|sch)\.uk$/.test(d)
}

const NAME_NOISE = new Set([
  'ltd',
  'limited',
  'llp',
  'plc',
  'uk',
  'the',
  'and',
  'co',
  'company',
  'group',
  'holdings',
  'services',
  'solutions',
  'international',
])

/** "The Smith & Jones Group Ltd" → "smith jones". Used to merge and to spot the business itself. */
export function normaliseName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(' ')
}

/** Strongest identity first. Capped to the column width so an absurd name cannot fail an insert. */
export function candidateKey(c: Pick<Candidate, 'domain' | 'placeId' | 'companyNumber' | 'name'>): string {
  const k = c.domain
    ? `d:${c.domain}`
    : c.placeId
      ? `p:${c.placeId}`
      : c.companyNumber
        ? `c:${c.companyNumber}`
        : `n:${normaliseName(c.name)}`
  return k.slice(0, 200)
}

/** A blank candidate, for collectors to fill in. */
export function emptyCandidate(name: string, source: DiscoverySource): Candidate {
  return {
    key: '',
    name: name.trim(),
    domain: null,
    placeId: null,
    companyNumber: null,
    address: null,
    postcode: null,
    lat: null,
    lng: null,
    rating: null,
    reviewCount: 0,
    types: [],
    sources: [source],
    matchedKeywords: [],
    organicHits: 0,
    paidHits: 0,
    bestPosition: null,
    sharedKeywords: 0,
  }
}

function pickBetter<T>(a: T | null, b: T | null): T | null {
  return a ?? b ?? null
}

function mergeTwo(a: Candidate, b: Candidate): Candidate {
  // Prefer the richer record for display fields; add up the evidence.
  const name = a.domain || a.placeId ? a.name : b.domain || b.placeId ? b.name : a.name
  return {
    key: a.key,
    name,
    domain: pickBetter(a.domain, b.domain),
    placeId: pickBetter(a.placeId, b.placeId),
    companyNumber: pickBetter(a.companyNumber, b.companyNumber),
    address: pickBetter(a.address, b.address),
    postcode: pickBetter(a.postcode, b.postcode),
    lat: pickBetter(a.lat, b.lat),
    lng: pickBetter(a.lng, b.lng),
    rating: a.rating !== null && b.rating !== null ? Math.max(a.rating, b.rating) : pickBetter(a.rating, b.rating),
    reviewCount: Math.max(a.reviewCount, b.reviewCount),
    types: dedupe([...a.types, ...b.types]),
    sources: Array.from(new Set([...a.sources, ...b.sources])),
    matchedKeywords: dedupe([...a.matchedKeywords, ...b.matchedKeywords]),
    organicHits: a.organicHits + b.organicHits,
    paidHits: a.paidHits + b.paidHits,
    bestPosition:
      a.bestPosition !== null && b.bestPosition !== null
        ? Math.min(a.bestPosition, b.bestPosition)
        : pickBetter(a.bestPosition, b.bestPosition),
    sharedKeywords: Math.max(a.sharedKeywords, b.sharedKeywords),
  }
}

/**
 * One candidate per business. Merges on the strongest identity first (domain,
 * then Maps place, then register number), then folds records with no domain
 * into a domain record with the same normalised name — the register entry for
 * "Smith & Jones Ltd" and the Maps listing for "Smith and Jones" are the same
 * firm.
 */
export function mergeCandidates(list: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const raw of list) {
    const c: Candidate = { ...raw, domain: normaliseDomain(raw.domain) }
    c.key = candidateKey(c)
    const prev = byKey.get(c.key)
    byKey.set(c.key, prev ? mergeTwo(prev, c) : c)
  }

  // Same place id under two keys (one record had a domain, the other not).
  const byPlace = new Map<string, string>()
  for (const [key, c] of [...byKey]) {
    if (!c.placeId) continue
    const owner = byPlace.get(c.placeId)
    if (owner && owner !== key) {
      const keep = byKey.get(owner)!
      const merged = keep.domain ? mergeTwo(keep, c) : mergeTwo({ ...c, key: owner }, keep)
      byKey.set(owner, { ...merged, key: owner })
      byKey.delete(key)
    } else byPlace.set(c.placeId, key)
  }

  // Fold domain-less records into a named twin that has a domain.
  const named = new Map<string, string>()
  for (const [key, c] of byKey) {
    const n = normaliseName(c.name)
    if (n && c.domain && !named.has(n)) named.set(n, key)
  }
  for (const [key, c] of [...byKey]) {
    if (c.domain) continue
    const twin = named.get(normaliseName(c.name))
    if (twin && twin !== key && byKey.has(twin)) {
      byKey.set(twin, mergeTwo(byKey.get(twin)!, c))
      byKey.delete(key)
    }
  }
  // Re-key from what the merged record now knows, so the same business gets
  // the same key whatever order the sources answered in.
  const final = new Map<string, Candidate>()
  for (const c of byKey.values()) {
    const k = candidateKey(c)
    const prev = final.get(k)
    final.set(k, prev ? { ...mergeTwo(prev, c), key: k } : { ...c, key: k })
  }
  return [...final.values()]
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

const KEYWORD_STOP = new Set(['services', 'service', 'company', 'near', 'local', 'best', 'the', 'and', 'for', 'with', 'emergency', 'advice', 'help'])

function keywordTokens(keywords: readonly string[]): string[] {
  const out = new Set<string>()
  for (const k of keywords) {
    for (const t of k.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 4 && !KEYWORD_STOP.has(t)) out.add(t)
    }
  }
  return [...out]
}

/** True when the business's name or Maps categories say it does what the profile does. */
export function matchesTrade(c: Pick<Candidate, 'name' | 'types'>, keywords: readonly string[]): boolean {
  const tokens = keywordTokens(keywords)
  if (tokens.length === 0) return false
  const hay = `${c.name} ${c.types.join(' ').replace(/_/g, ' ')}`.toLowerCase()
  // Stem-ish: "liquidation" should match "liquidators".
  return tokens.some((t) => hay.includes(t.slice(0, Math.max(4, t.length - 3))))
}

/** Whether a candidate is the business itself. Discovery finds you too. */
export function isSelf(c: Pick<Candidate, 'domain' | 'name' | 'companyNumber'>, profile: CompanyProfile): boolean {
  if (profile.domain && c.domain && c.domain === profile.domain) return true
  if (profile.companyNumber && c.companyNumber && c.companyNumber === profile.companyNumber) return true
  const a = normaliseName(c.name)
  const b = normaliseName(profile.companyName)
  return Boolean(a && b && a === b)
}

export type ClassifyOptions = {
  /** Keys a person has already dismissed; they are never suggested again. */
  dismissed?: ReadonlySet<string>
  /** Cap per kind, so a dense city does not produce 200 suggestions. */
  maxDirect?: number
  maxIndirect?: number
  maxReferral?: number
  /** What reading each candidate's website proved, by candidate key. */
  verified?: ReadonlyMap<string, CandidateVerification>
  /**
   * How many searches were actually run. Discovery tops a thin profile up
   * from the trade vocabulary, so this is usually more than the profile's own
   * keyword count — and it is the honest denominator for "ranks for N of
   * your searches".
   */
  keywordCount?: number
}

/**
 * Score and split.
 *
 * The weighting answers the question the old version got wrong. Relevance —
 * does this firm sell what you sell — is worth more than every other signal
 * combined, because it is the only thing that makes a business a competitor.
 * Being nearby and being well reviewed are tie-breakers between firms that
 * already qualify, not reasons to qualify.
 *
 *   sells the same service     up to 55
 *   wins the same searches     up to 25
 *   market standing            up to 10
 *   proximity                  up to  8
 *   same SIC code              up to  4
 *
 * A candidate whose own website shows the neighbouring trade is classed
 * `referral` however close or well reviewed it is, and a candidate with no
 * relevance evidence cannot be `direct` on search presence alone — which is
 * exactly what used to let one page-one appearance promote an accountant.
 */
export function classifyCandidates(
  candidates: readonly Candidate[],
  profile: CompanyProfile,
  options: ClassifyOptions = {},
): { direct: ClassifiedCandidate[]; indirect: ClassifiedCandidate[]; referral: ClassifiedCandidate[] } {
  const maxDirect = options.maxDirect ?? 15
  const maxIndirect = options.maxIndirect ?? 12
  const maxReferral = options.maxReferral ?? 8
  const verified = options.verified
  // Guard the denominator: with a single keyword the old formula turned one
  // page-one hit into a perfect search score.
  const kwCount = Math.max(3, options.keywordCount ?? profile.keywords.length)
  const home = profile.lat !== null && profile.lng !== null ? { lat: profile.lat, lng: profile.lng } : null

  const out: ClassifiedCandidate[] = []
  for (const c of mergeCandidates(candidates)) {
    if (isExcludedDomain(c.domain)) continue
    if (isSelf(c, profile)) continue
    if (options.dismissed?.has(c.key)) continue
    if (!c.name) continue

    const manual = c.sources.includes('manual')
    const v = verified?.get(c.key) ?? null
    const reasons: string[] = []
    let score = 0

    /* ------------------------------------------ does it sell what you sell */
    const trade = matchesTrade(c, profile.keywords)
    let relevant = false
    if (manual) {
      relevant = true
      score += 55
      reasons.push('Added by you')
    } else if (v) {
      if (v.verdict === 'match') {
        relevant = true
        score += 40 + Math.round(Math.min(15, (v.confidence / 100) * 15))
        reasons.push(v.note)
      } else if (v.verdict === 'weak') {
        score += 16
        reasons.push(v.note)
      } else if (v.verdict === 'unknown') {
        score += 6
        reasons.push('Website could not be read, so this is unconfirmed')
      } else {
        reasons.push(v.note)
      }
    } else if (trade) {
      score += 14
      reasons.push('Name or Google category matches your trade')
    }

    /* ---------------------------------------- does it win the same searches */
    let searchScore = 0
    if (c.organicHits > 0) {
      searchScore += Math.min(20, Math.round((c.organicHits / kwCount) * 24))
      if (c.bestPosition && c.bestPosition <= 3) searchScore += 3
      reasons.push(
        `On page one for ${c.organicHits} of your ${kwCount} searches` +
          (c.bestPosition ? ` (best: position ${c.bestPosition})` : ''),
      )
    }
    if (c.paidHits > 0) {
      searchScore += Math.min(10, c.paidHits * 5)
      reasons.push(`Pays to advertise on ${c.paidHits} of your searches`)
    }
    if (c.sharedKeywords > 0) {
      searchScore += Math.min(8, Math.round(Math.log10(1 + c.sharedKeywords) * 4))
      reasons.push(`Shares ${c.sharedKeywords} search keywords with you`)
    }
    score += Math.min(25, searchScore)

    /* ------------------------------------------------- tie-breakers only */
    if (c.rating !== null && c.reviewCount > 0) {
      const weight = Math.min(1, Math.log10(1 + c.reviewCount) / 2.5)
      score += Math.round((c.rating / 5) * weight * 10)
      reasons.push(`${c.rating.toFixed(1)}★ from ${c.reviewCount} Google reviews`)
    }

    let distanceKm: number | null = null
    if (home && c.lat !== null && c.lng !== null) {
      distanceKm = Math.round(haversineKm(home, { lat: c.lat, lng: c.lng }) * 10) / 10
    }
    const isNearby = distanceKm !== null && distanceKm <= profile.radiusKm
    if (profile.scope !== 'national' && isNearby && distanceKm !== null) {
      score += Math.max(2, Math.round(8 * (1 - distanceKm / Math.max(1, profile.radiusKm))))
      reasons.push(`${distanceKm} km away`)
    }

    if (c.sources.includes('companies_house') && c.sources.length === 1) {
      score += 4
      reasons.push('Registered under the same SIC code nearby')
    }
    if (c.sources.includes('simulated')) reasons.push('Simulated competitor')

    /*
     * No verification for this candidate: the crawler is off, the market is
     * simulated, or the run hit its fetch budget. Fall back to the signals
     * this module was built on — ranking or paying for your searches is
     * evidence of competition even when the website could not be read. The
     * strict rule above applies only where there is something better to go on.
     */
    if (!v && !manual && (trade || c.organicHits > 0 || c.paidHits > 0 || c.sharedKeywords >= 10)) {
      relevant = true
    }

    /* -------------------------------------------------------- the verdict */
    const tier: CompetitorTier =
      isNearby || (c.sources.includes('places_local') && distanceKm === null) ? 'local' : 'national'

    let kind: CompetitorKind
    if (manual) kind = 'direct'
    else if (v && (v.verdict === 'adjacent' || v.verdict === 'unrelated')) kind = 'referral'
    else if (relevant) kind = 'direct'
    else kind = 'indirect'

    // The trade next door never competes, so it is capped below every
    // verified competitor however good its reviews are.
    if (kind === 'referral') score = Math.min(score, 25)

    out.push({
      ...c,
      kind,
      tier,
      distanceKm,
      relevance: Math.max(0, Math.min(100, score)),
      reasons,
      verification: v,
    })
  }

  // Relevance decides the order outright. A blanket local bias would
  // reintroduce the original bug, so locality only breaks ties.
  const sorted = out.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      Number(b.tier === 'local') - Number(a.tier === 'local') ||
      b.reviewCount - a.reviewCount ||
      a.name.localeCompare(b.name),
  )

  /*
   * A candidate with no trade evidence and no search presence is not a weak
   * competitor, it is a stranger: Google Places returns a few of these for
   * any query. Suggesting them wastes the reader's attention, so they are
   * dropped rather than ranked last.
   */
  const worthShowing = (x: ClassifiedCandidate) =>
    x.relevance >= 12 ||
    x.organicHits > 0 ||
    x.paidHits > 0 ||
    // Same SIC code on the register is thin, but it is a real signal and the
    // reader can see where it came from. Google Places' stray results are not.
    x.sources.includes('companies_house') ||
    (x.verification != null && x.verification.verdict === 'weak')

  return {
    direct: sorted.filter((x) => x.kind === 'direct').slice(0, maxDirect),
    indirect: sorted.filter((x) => x.kind === 'indirect' && worthShowing(x)).slice(0, maxIndirect),
    referral: sorted.filter((x) => x.kind === 'referral' && worthShowing(x)).slice(0, maxReferral),
  }
}
