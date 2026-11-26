/**
 * The competitor simulator.
 *
 * Used for any part of discovery or a scan that has no configured source, so
 * the whole module — discovery, scans, the landscape, plays, the context fed
 * to the generators — can be demonstrated and tested with no keys and no
 * spend. Every business it invents is fictional, lives on a `.example` domain
 * (which the reader refuses to fetch), and is labelled simulated wherever it
 * appears.
 *
 * Deterministic: the same profile produces the same competitors and the same
 * evidence, so demos are reproducible and tests are stable. Each competitor
 * is built from an archetype — the price leader, the authority, the fast one,
 * the content publisher… — so the landscape has real contrasts to find.
 *
 * Pure: no I/O.
 */

import type { Claim } from '@/lib/serptwin/claims'
import { extractClaims } from '@/lib/serptwin/claims'
import { emptyCandidate } from './discovery'
import { researchLinks } from './links'
import type {
  AdCopy,
  BlogPost,
  Candidate,
  CompanyProfile,
  OrganicHit,
  PageExtract,
  PresenceSnapshot,
  ReviewSample,
  SocialProfile,
} from './types'

export function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length]

export type Archetype =
  | 'price_leader'
  | 'authority'
  | 'speed'
  | 'local_favourite'
  | 'content_publisher'
  | 'ad_heavy'
  | 'review_champion'
  | 'generalist'

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  price_leader: 'Competes on price',
  authority: 'Competes on credentials',
  speed: 'Competes on speed',
  local_favourite: 'The local favourite',
  content_publisher: 'Wins with content',
  ad_heavy: 'Buys its traffic',
  review_champion: 'Wins on reviews',
  generalist: 'Generalist',
}

const ORDER: Archetype[] = [
  'ad_heavy',
  'authority',
  'price_leader',
  'content_publisher',
  'speed',
  'review_champion',
  'local_favourite',
  'generalist',
]

const PREFIX = [
  'Northgate',
  'Harbourside',
  'Kingsway',
  'Meridian',
  'Oakfield',
  'Sterling',
  'Brightwater',
  'Ashcombe',
  'Redwood',
  'Albion',
  'Clearview',
  'Fairhaven',
  'Larkspur',
  'Thornbury',
]
const SUFFIX = ['Partners', '& Co', 'Group', 'Associates', 'Direct', 'Specialists', 'Advisory', 'Services']

/** "insolvency practitioner" → "Insolvency"; "plumber" → "Plumbing". */
export function tradeNoun(profile: Pick<CompanyProfile, 'businessType' | 'keywords'>): string {
  const t = (profile.businessType || profile.keywords[0] || 'Business').toLowerCase()
  const map: [RegExp, string][] = [
    [/insolv|liquidat|recovery|restructur/, 'Insolvency'],
    [/plumb/, 'Plumbing'],
    [/electric/, 'Electrical'],
    [/account|tax|bookkeep/, 'Accountancy'],
    [/solicitor|law|legal/, 'Legal'],
    [/software|web|app|it /, 'Digital'],
    [/marketing|seo|ppc|agency/, 'Marketing'],
    [/dent/, 'Dental'],
    [/estate|letting|property/, 'Property'],
    [/restaurant|takeaway|cafe|food/, 'Kitchen'],
    [/payment|merchant|finance/, 'Payments'],
  ]
  for (const [re, noun] of map) if (re.test(t)) return noun
  const w = t.split(/\s+/)[0] ?? 'Business'
  return w[0].toUpperCase() + w.slice(1)
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export type SimulatedCompetitor = {
  name: string
  domain: string
  archetype: Archetype
  tier: 'local' | 'national'
  rating: number
  reviews: number
  /** km from the business, for local ones. */
  distanceKm: number | null
}

/** The fictional market for a profile. Always the same eight for the same profile. */
export function simulatedMarket(profile: CompanyProfile): SimulatedCompetitor[] {
  const r = rng(`market:${profile.companyName}:${profile.businessType}:${profile.keywords.join('|')}`)
  const noun = tradeNoun(profile)
  const usedPrefix = new Set<string>()
  return ORDER.map((archetype, i) => {
    let prefix = pick(r, PREFIX)
    while (usedPrefix.has(prefix)) prefix = PREFIX[(PREFIX.indexOf(prefix) + 1) % PREFIX.length]
    usedPrefix.add(prefix)
    const name = `${prefix} ${noun} ${pick(r, SUFFIX)}`
    const local =
      profile.scope === 'local' ? i !== 0 && i !== 3 : profile.scope === 'hybrid' ? i % 2 === 0 : i >= 6
    const baseRating =
      archetype === 'review_champion' ? 4.9 : archetype === 'price_leader' ? 3.6 : archetype === 'ad_heavy' ? 3.9 : 4.2 + r() * 0.6
    return {
      name,
      domain: `${slug(`${prefix}-${noun}`)}.example`,
      archetype,
      tier: local ? 'local' : 'national',
      rating: Math.round(Math.min(5, baseRating) * 10) / 10,
      reviews: archetype === 'review_champion' ? 640 : Math.round(20 + r() * 380),
      distanceKm: local ? Math.round((1 + r() * Math.max(2, profile.radiusKm - 1)) * 10) / 10 : null,
    }
  })
}

/** Simulated discovery: candidates with the search presence their archetype implies. */
export function simulatedCandidates(profile: CompanyProfile): Candidate[] {
  const market = simulatedMarket(profile)
  const kws = profile.keywords.length ? profile.keywords : [profile.businessType]
  return market.map((m, i) => {
    const c = emptyCandidate(m.name, 'simulated')
    c.domain = m.domain
    c.rating = m.rating
    c.reviewCount = m.reviews
    c.types = [slug(profile.businessType).replace(/-/g, '_')]
    if (m.tier === 'local' && profile.lat !== null && profile.lng !== null && m.distanceKm !== null) {
      // Place them on a ring around the business, at their distance.
      const angle = (i / market.length) * 2 * Math.PI
      const dLat = (m.distanceKm / 111) * Math.cos(angle)
      const dLng = (m.distanceKm / (111 * Math.cos((profile.lat * Math.PI) / 180))) * Math.sin(angle)
      c.lat = profile.lat + dLat
      c.lng = profile.lng + dLng
      c.address = `${10 + i} High Street, ${profile.locality ?? 'Town Centre'}`
      c.sources.push('places_local')
    } else c.sources.push('places_national')
    const presence = searchPresence(m.archetype, kws.length)
    c.organicHits = presence.organic
    c.paidHits = presence.paid
    c.bestPosition = presence.organic ? presence.best : null
    c.matchedKeywords = kws.slice(0, Math.max(1, presence.organic))
    if (presence.organic) c.sources.push('organic')
    if (presence.paid) c.sources.push('paid')
    return c
  })
}

function searchPresence(a: Archetype, n: number): { organic: number; paid: number; best: number } {
  switch (a) {
    case 'content_publisher':
      return { organic: Math.max(1, Math.ceil(n * 0.8)), paid: 0, best: 1 }
    case 'ad_heavy':
      return { organic: Math.ceil(n * 0.2), paid: Math.max(1, Math.ceil(n * 0.9)), best: 7 }
    case 'authority':
      return { organic: Math.ceil(n * 0.6), paid: Math.ceil(n * 0.4), best: 2 }
    case 'price_leader':
      return { organic: Math.ceil(n * 0.3), paid: Math.ceil(n * 0.6), best: 5 }
    case 'speed':
      return { organic: Math.ceil(n * 0.3), paid: Math.ceil(n * 0.3), best: 4 }
    case 'review_champion':
      return { organic: Math.ceil(n * 0.4), paid: 0, best: 3 }
    case 'local_favourite':
      return { organic: Math.ceil(n * 0.2), paid: 0, best: 6 }
    default:
      return { organic: Math.ceil(n * 0.1), paid: 0, best: 9 }
  }
}

/* --------------------------------------------------------------- copy */

type Voice = {
  headlines: string[]
  descriptions: string[]
  h1: string
  promise: string
  prices: string[]
  signals: string[]
  ctas: string[]
  posts: number
  complaints: string[]
  praise: string[]
  social: SocialProfile['network'][]
}

function voice(a: Archetype, noun: string, kw: string, locality: string): Voice {
  const K = kw.replace(/\b\w/g, (c) => c.toUpperCase())
  switch (a) {
    case 'price_leader':
      return {
        headlines: [`${K} From £495`, `Fixed Fee ${noun} Help`, 'No Hidden Fees, Ever'],
        descriptions: [
          `Low-cost ${kw} with a fixed fee agreed up front. Get a free quote online today.`,
          `Why pay more? Fixed-fee ${kw} from £495 + VAT. Call now for a quote.`,
        ],
        h1: `Affordable ${kw}`,
        promise: `The UK’s low-cost ${kw} — fixed fees from £495 + VAT, no hidden costs.`,
        prices: ['from £495 + VAT', '£95 a month'],
        signals: ['No hidden fees', 'Fixed fee'],
        ctas: ['Get a free quote', 'Call now'],
        posts: 1,
        complaints: [
          'Cheap up front but extra charges kept appearing on the invoice.',
          'Hard to get anyone on the phone once I had paid.',
          'Felt rushed and like just a number.',
        ],
        praise: ['Good value for money.', 'Price was exactly as quoted.'],
        social: ['facebook'],
      }
    case 'authority':
      return {
        headlines: [`Licensed ${noun} Experts`, '30+ Years Experience', `Award-Winning ${K}`],
        descriptions: [
          `Accredited specialists in ${kw}. Over 30 years’ experience and thousands of cases.`,
          `Regulated, award-winning ${kw} advice from senior experts. Book a consultation.`,
        ],
        h1: `${K} specialists you can trust`,
        promise: `Senior, accredited experts in ${kw} with more than 30 years’ experience.`,
        prices: [],
        signals: ['30+ years of experience', 'Award-winning', 'Accredited'],
        ctas: ['Book a consultation'],
        posts: 4,
        complaints: ['Very expensive compared to others.', 'Took a while to get an appointment with a partner.'],
        praise: ['Clearly experts, explained everything.', 'Professional from start to finish.'],
        social: ['linkedin', 'x'],
      }
    case 'speed':
      return {
        headlines: [`Same-Day ${noun} Help`, `${K} In 24 Hours`, 'Call Back In 15 Minutes'],
        descriptions: [
          `Fast ${kw}. Speak to an adviser today and get started within 24 hours.`,
          `Need ${kw} now? Same-day response, 7 days a week.`,
        ],
        h1: `Fast ${kw}, today`,
        promise: `Same-day ${kw}: an adviser calls back within 15 minutes.`,
        prices: [],
        signals: ['Same-day response', '7 days a week'],
        ctas: ['Request a call back', 'Get help today'],
        posts: 1,
        complaints: ['Fast to start but then went quiet for weeks.', 'Felt pressured to sign quickly.'],
        praise: ['Called back within minutes.', 'Sorted the same day.'],
        social: ['facebook', 'instagram'],
      }
    case 'local_favourite':
      return {
        headlines: [],
        descriptions: [],
        h1: `Your local ${kw} in ${locality}`,
        promise: `Family-run ${kw} serving ${locality} for over 20 years.`,
        prices: [],
        signals: ['Family run', 'Over 20 years in business'],
        ctas: ['Contact us'],
        posts: 0,
        complaints: ['Website is out of date and hard to book through.', 'Only open office hours.'],
        praise: ['Friendly local team who know the area.', 'Personal service.'],
        social: ['facebook'],
      }
    case 'content_publisher':
      return {
        headlines: [],
        descriptions: [],
        h1: `The complete guide to ${kw}`,
        promise: `Free guides and calculators on ${kw}, then expert help when you need it.`,
        prices: ['from £1,250'],
        signals: ['10,000+ readers a month'],
        ctas: ['Read the guide', 'Download the free checklist'],
        posts: 14,
        complaints: ['Lots of information but slow to actually help me.', 'Generic advice, not specific to my situation.'],
        praise: ['Their guides answered most of my questions.', 'Very clear explanations.'],
        social: ['linkedin', 'youtube', 'x'],
      }
    case 'ad_heavy':
      return {
        headlines: [`${K} — Get Help Now`, `Free ${noun} Consultation`, `Rated 4.8 Stars`],
        descriptions: [
          `Free, no-obligation ${kw} consultation. Thousands helped. Call our team now.`,
          `Speak to a ${kw} expert today. Free consultation, nationwide service.`,
        ],
        h1: `${K} — free consultation`,
        promise: `Nationwide ${kw} with a free, no-obligation consultation.`,
        prices: [],
        signals: ['Free consultation', 'Thousands helped'],
        ctas: ['Get a free consultation', 'Call now'],
        posts: 2,
        complaints: [
          'Turned out to be a call centre that passed me to another firm.',
          'Lots of follow-up calls and emails after one enquiry.',
          'The free consultation was a sales pitch.',
        ],
        praise: ['Quick to respond.'],
        social: ['facebook', 'instagram', 'tiktok'],
      }
    case 'review_champion':
      return {
        headlines: [],
        descriptions: [],
        h1: `${K}, rated 4.9★ by 600+ clients`,
        promise: `Rated 4.9 stars by more than 600 clients for ${kw}.`,
        prices: [],
        signals: ['600+ five-star reviews', 'Rated 4.9 on Google'],
        ctas: ['Read our reviews', 'Book a free call'],
        posts: 2,
        complaints: ['Waiting list of two weeks.'],
        praise: ['Kept me updated at every step.', 'Honest and transparent about the costs.', 'Explained everything in plain English.'],
        social: ['facebook', 'linkedin', 'instagram'],
      }
    default:
      return {
        headlines: [],
        descriptions: [],
        h1: `${K} and more`,
        promise: `A wide range of business services including ${kw}.`,
        prices: [],
        signals: [],
        ctas: ['Contact us'],
        posts: 0,
        complaints: ['Not specialists, had to be referred elsewhere.'],
        praise: ['Helpful staff.'],
        social: [],
      }
  }
}

const TOPICS = [
  (kw: string) => `How much does ${kw} cost in ${new Date().getUTCFullYear()}?`,
  (kw: string) => `${cap(kw)}: a step-by-step guide`,
  (kw: string) => `What to expect from ${kw}`,
  (kw: string) => `${cap(kw)} vs the alternatives: which is right for you?`,
  (kw: string) => `10 questions to ask before choosing ${kw}`,
  (kw: string) => `Common mistakes with ${kw} and how to avoid them`,
  (kw: string) => `How long does ${kw} take?`,
  (kw: string) => `Is ${kw} worth it? Pros and cons`,
  (kw: string) => `${cap(kw)} checklist (free download)`,
  (kw: string) => `Case study: ${kw} for a ${pick(rng(kw), ['small business', 'family firm', 'growing company'])}`,
]

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function daysAgo(n: number, now: Date): string {
  return new Date(now.getTime() - n * 86_400_000).toISOString()
}

/**
 * A full simulated snapshot for a simulated competitor. `now` is passed in so
 * tests and demos do not drift with the calendar.
 */
export function simulatedSnapshot(
  sim: SimulatedCompetitor,
  profile: CompanyProfile,
  now: Date = new Date(),
): PresenceSnapshot {
  const noun = tradeNoun(profile)
  const kws = profile.keywords.length ? profile.keywords : [profile.businessType]
  const kw = kws[0].toLowerCase()
  const v = voice(sim.archetype, noun, kw, profile.locality ?? 'your area')
  const r = rng(`snap:${sim.domain}`)
  const presence = searchPresence(sim.archetype, kws.length)

  const pages: PageExtract[] = [
    {
      url: `https://${sim.domain}/`,
      kind: 'home',
      title: `${v.h1} | ${sim.name}`,
      description: v.promise,
      h1: [v.h1],
      h2: ['How it works', 'Why choose us', ...(v.prices.length ? ['Our fees'] : []), 'What our clients say'],
      excerpt: `${v.promise} ${v.signals.join('. ')}.`,
      ctas: v.ctas,
      prices: v.prices,
      wordCount: 600 + Math.round(r() * 900),
    },
  ]
  if (v.prices.length) {
    pages.push({
      url: `https://${sim.domain}/fees`,
      kind: 'pricing',
      title: `Fees | ${sim.name}`,
      description: `Our ${kw} fees, explained.`,
      h1: ['Our fees'],
      h2: ['What is included', 'Optional extras'],
      excerpt: `Fees ${v.prices.join(', ')}.`,
      ctas: v.ctas.slice(0, 1),
      prices: v.prices,
      wordCount: 400,
    })
  }

  const ads: AdCopy[] =
    presence.paid > 0
      ? kws.slice(0, presence.paid).map((k, i) => {
          const headline = v.headlines[i % Math.max(1, v.headlines.length)] ?? `${cap(k)} Help`
          const description = v.descriptions[i % Math.max(1, v.descriptions.length)] ?? v.promise
          return {
            keyword: k,
            position: 1 + (i % 3),
            headline,
            description,
            displayUrl: `${sim.domain}/${slug(k)}`,
            finalUrl: `https://${sim.domain}/${slug(k)}`,
            claims: extractClaims(`${headline} ${description}`) as Claim[],
          }
        })
      : []

  const organic: OrganicHit[] = kws.slice(0, presence.organic).map((k, i) => ({
    keyword: k,
    position: Math.min(10, presence.best + i),
    url: `https://${sim.domain}/${slug(k)}`,
    title: `${cap(k)} | ${sim.name}`,
    snippet: v.promise,
  }))

  const posts: BlogPost[] = Array.from({ length: Math.min(10, v.posts * 3) }, (_, i) => {
    const topicKw = kws[i % kws.length].toLowerCase()
    const title = TOPICS[(i + sim.archetype.length) % TOPICS.length](topicKw)
    return {
      title,
      url: `https://${sim.domain}/blog/${slug(title)}`,
      publishedAt: daysAgo(Math.round((i + 1) * (30 / Math.max(1, v.posts)) + r() * 3), now),
      summary: null,
    }
  })
  const postsLast90Days = posts.filter((p) => p.publishedAt && now.getTime() - Date.parse(p.publishedAt) <= 90 * 86_400_000).length

  const samples: ReviewSample[] = [
    ...v.praise.map((text, i) => ({ rating: 5, text, publishedAt: daysAgo(10 + i * 9, now), source: 'Google' })),
    ...v.complaints.map((text, i) => ({ rating: i === 0 ? 1 : 2, text, publishedAt: daysAgo(15 + i * 11, now), source: 'Google' })),
  ]

  const social: SocialProfile[] = v.social.map((network) => ({
    network,
    url: `https://${network === 'x' ? 'x' : network}.com/${slug(sim.name)}`,
    handle: slug(sim.name),
    followers: Math.round(200 + r() * (network === 'youtube' ? 4000 : 2500)),
    posts: network === 'youtube' ? Math.round(10 + r() * 60) : null,
    recent:
      network === 'youtube'
        ? posts.slice(0, 3).map((p) => ({ title: p.title, url: p.url, publishedAt: p.publishedAt, views: Math.round(100 + r() * 3000) }))
        : [],
    depth: network === 'youtube' ? 'posts' : 'link',
  }))

  return {
    name: sim.name,
    domain: sim.domain,
    collectedAt: now.toISOString(),
    simulated: true,
    sources: [{ source: 'simulator', status: 'simulated', provider: 'Simulator', note: 'Fictional competitor. Every item below is simulated.', items: 1, ms: 0 }],
    pages,
    structured: {
      types: ['LocalBusiness'],
      foundingYear: sim.archetype === 'authority' ? '1994' : sim.archetype === 'local_favourite' ? '2003' : String(2008 + Math.round(r() * 14)),
      areaServed: sim.tier === 'local' ? [profile.locality ?? 'Local area'] : ['United Kingdom'],
      priceRange: v.prices[0] ?? null,
    },
    trustSignals: v.signals,
    offers: v.prices,
    blog: { feedUrl: posts.length ? `https://${sim.domain}/feed` : null, posts, postsLast90Days },
    ads,
    organic,
    topKeywords: [],
    reviews: [
      {
        source: 'google',
        rating: sim.rating,
        count: sim.reviews,
        samples,
        url: null,
      },
    ],
    social,
    news: [],
    company: null,
    links: researchLinks({ name: sim.name, domain: null }),
  }
}

/** Find the simulated competitor behind a domain, if it is one. */
export function simulatedByDomain(profile: CompanyProfile, domain: string | null): SimulatedCompetitor | null {
  if (!domain || !domain.endsWith('.example')) return null
  return simulatedMarket(profile).find((m) => m.domain === domain) ?? null
}
