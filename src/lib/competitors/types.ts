/**
 * Competitor intelligence — shared types.
 *
 * Pure module: no I/O, no `server-only`, so client components can import the
 * shapes they render. Everything the module stores is one of these types,
 * written once and read back verbatim, so what a person sees on screen is what
 * the analysis produced.
 *
 * Two rules run through the whole module and are encoded in the types:
 *
 *  1. Every observation carries its source and whether it was simulated. A
 *     competitor's ad copy read from a live SERP and one invented by the
 *     simulator must never look the same.
 *  2. Every insight cites evidence. An AI-written "their advantage is speed"
 *     points at the ad, page or review it came from, so a reviewer can check
 *     it rather than trust it.
 */

import type { Claim } from '@/lib/serptwin/claims'

/* ------------------------------------------------------------ the business */

/** How far afield a business competes. Decides local vs national discovery. */
export type Scope = 'local' | 'hybrid' | 'national'

export type CompanyProfile = {
  companyName: string
  /** Companies House number, when the company was picked from the register. */
  companyNumber: string | null
  sicCodes: string[]
  /** The company's own site, bare host. Crawled like a competitor so comparisons are like for like. */
  domain: string | null
  postcode: string | null
  locality: string | null
  lat: number | null
  lng: number | null
  businessType: string
  /** Search terms a customer would type to find this kind of business. */
  keywords: string[]
  scope: Scope
  /** 0–1, how sure the classifier was. Below 0.5 the setup screen asks a person to check. */
  confidence: number
  /** Radius for local discovery. */
  radiusKm: number
  /** Where the business type and keywords came from. */
  source: 'ai' | 'rules' | 'manual'
}

/* -------------------------------------------------------------- discovery */

export type DiscoverySource =
  | 'places_local'
  | 'places_national'
  | 'organic'
  | 'paid'
  | 'companies_house'
  | 'dataforseo'
  | 'manual'
  | 'simulated'

export const DISCOVERY_SOURCE_LABEL: Record<DiscoverySource, string> = {
  places_local: 'Google Maps nearby',
  places_national: 'Google Maps UK-wide',
  organic: 'Ranks on Google for your searches',
  paid: 'Advertises on your searches',
  companies_house: 'Companies House (same SIC code)',
  dataforseo: 'Shares your search keywords',
  manual: 'Added by a person',
  simulated: 'Simulated',
}

/** One business found by discovery, before it is classified. */
export type Candidate = {
  /** Identity used to merge the same business found by several sources. */
  key: string
  name: string
  domain: string | null
  placeId: string | null
  companyNumber: string | null
  address: string | null
  postcode: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  reviewCount: number
  /** Google place types, lower-case. */
  types: string[]
  sources: DiscoverySource[]
  /** Which of the profile's keywords surfaced this business. */
  matchedKeywords: string[]
  /** Number of the profile's keywords this business ranks on page one for. */
  organicHits: number
  /** Number of the profile's keywords this business advertises on. */
  paidHits: number
  bestPosition: number | null
  /** Shared-keyword count from a keyword database, when one is configured. */
  sharedKeywords: number
}

/**
 * `referral` is the trade next door — an accountant to an insolvency
 * practitioner. Discovery finds them because they rank for the same searches
 * and sit on the same high street, but a customer never chooses between them,
 * so they must never take a tracked slot.
 */
export type CompetitorKind = 'direct' | 'indirect' | 'referral'
export type CompetitorTier = 'local' | 'national'

/** What reading the candidate's own website proved. */
export type CandidateVerification = {
  verdict: 'match' | 'weak' | 'adjacent' | 'unrelated' | 'unknown'
  /** 0–100 confidence that this business sells what you sell. */
  confidence: number
  note: string
  decidedBy: 'website' | 'model' | 'name' | 'skipped'
  serviceTerms: string[]
  otherTradeTerms: string[]
}

export type ClassifiedCandidate = Candidate & {
  kind: CompetitorKind
  tier: CompetitorTier
  distanceKm: number | null
  /** 0–100. How much this business competes for the same customers. */
  relevance: number
  /** Plain-English reasons, shown under the score. */
  reasons: string[]
  /** Null when discovery ran before verification existed. */
  verification?: CandidateVerification | null
}

/* ---------------------------------------------------------------- sources */

export type SourceId =
  | 'website'
  | 'blog'
  | 'serp'
  | 'places'
  | 'reviews'
  | 'youtube'
  | 'news'
  | 'companies_house'
  | 'keywords'
  | 'simulator'

/** What one collector did for one competitor. Shown in the "where this came from" panel. */
export type SourceRun = {
  source: SourceId
  /** `skipped` = no key configured or nothing to look up. `blocked` = robots.txt said no. */
  status: 'ok' | 'skipped' | 'blocked' | 'error' | 'simulated'
  provider: string
  note: string
  items: number
  ms: number
}

/* ------------------------------------------------------- what we observed */

export type PageExtract = {
  url: string
  kind: 'home' | 'about' | 'pricing' | 'services' | 'contact' | 'other'
  title: string
  description: string
  h1: string[]
  h2: string[]
  /** First ~1,200 characters of visible body copy. Stored as an extract, never the page. */
  excerpt: string
  ctas: string[]
  prices: string[]
  wordCount: number
}

export type SocialNetwork = 'linkedin' | 'facebook' | 'instagram' | 'x' | 'youtube' | 'tiktok' | 'pinterest'

export type SocialProfile = {
  network: SocialNetwork
  url: string
  handle: string | null
  followers: number | null
  posts: number | null
  /** Recent posts or uploads, where a legitimate API exposes them. */
  recent: { title: string; url: string; publishedAt: string | null; views: number | null }[]
  /** `link` = only the profile link is known; there is no legitimate API to read it. */
  depth: 'link' | 'stats' | 'posts'
}

export type BlogPost = { title: string; url: string; publishedAt: string | null; summary: string | null }

export type AdCopy = {
  keyword: string
  position: number | null
  headline: string
  description: string
  displayUrl: string | null
  finalUrl: string | null
  /** Claims detected in the ad with the same taxonomy the PPC & SEO module uses. */
  claims: Claim[]
}

export type OrganicHit = {
  keyword: string
  position: number
  url: string
  title: string
  snippet: string
}

export type ReviewSample = { rating: number; text: string; publishedAt: string | null; source: string }

export type ReviewSummary = {
  source: 'google' | 'trustpilot'
  rating: number | null
  count: number
  samples: ReviewSample[]
  url: string | null
}

export type NewsItem = { title: string; url: string; source: string; publishedAt: string | null }

export type CompanyFacts = {
  companyNumber: string
  name: string
  status: string | null
  incorporatedOn: string | null
  sicCodes: string[]
  /** e.g. "micro-entity", "full" — a rough size signal. */
  accountsType: string | null
}

/** Links to public libraries that have no API for UK ads, opened by a person. */
export type ResearchLinks = {
  website: string | null
  googleAdsTransparency: string
  metaAdLibrary: string
  googleMaps: string | null
  trustpilot: string | null
  linkedinSearch: string
  tiktokSearch: string
}

/** Everything collected about one business at one moment. Stored whole, with a hash. */
export type PresenceSnapshot = {
  name: string
  domain: string | null
  collectedAt: string
  /** True when any part of the snapshot came from the simulator. */
  simulated: boolean
  sources: SourceRun[]
  pages: PageExtract[]
  /** Organisation facts from JSON-LD: founding year, area served, price range… */
  structured: { types: string[]; foundingYear: string | null; areaServed: string[]; priceRange: string | null }
  trustSignals: string[]
  offers: string[]
  blog: { feedUrl: string | null; posts: BlogPost[]; postsLast90Days: number }
  ads: AdCopy[]
  organic: OrganicHit[]
  /** Top keywords from a keyword database, when one is configured. */
  topKeywords: { keyword: string; position: number; volume: number | null }[]
  reviews: ReviewSummary[]
  social: SocialProfile[]
  news: NewsItem[]
  company: CompanyFacts | null
  links: ResearchLinks
}

/* ---------------------------------------------------------------- analysis */

/** A sentence and the snapshot items it rests on, e.g. `ad:2`, `page:0`, `review:google:3`. */
export type Insight = { text: string; evidence: string[] }

export type ChannelKey = 'website' | 'blog' | 'search_ads' | 'seo' | 'reviews' | 'social' | 'video' | 'pr'

export const CHANNEL_KEY_LABEL: Record<ChannelKey, string> = {
  website: 'Website',
  blog: 'Blog',
  search_ads: 'Search ads',
  seo: 'Organic search',
  reviews: 'Reviews',
  social: 'Social',
  video: 'Video',
  pr: 'News & PR',
}

/** 0 none, 1 present, 2 active, 3 strong. Computed from the snapshot, not guessed. */
export type ChannelActivity = Record<ChannelKey, 0 | 1 | 2 | 3>

export type CompetitorAnalysis = {
  /** One sentence: who they are for and what they promise. */
  positioning: string
  audience: string
  /** The single thing that most explains why customers pick them. */
  advantage: Insight
  valueProps: Insight[]
  strengths: Insight[]
  weaknesses: Insight[]
  /** Concrete ways to win customers from them, without naming them in copy. */
  howToWin: Insight[]
  tone: string
  claims: Partial<Record<Claim, number>>
  channels: ChannelActivity
  threat: { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] }
  /** True when the narrative fields came from the simulator rather than a model. */
  simulated: boolean
}

/* --------------------------------------------------------------- landscape */

export type PlayDestination = 'blog' | 'landing_page' | 'google_ads' | 'meta_ads' | 'video' | 'social' | 'email'

export const PLAY_DESTINATION_LABEL: Record<PlayDestination, string> = {
  blog: 'Blog post',
  landing_page: 'Landing page',
  google_ads: 'Google Ads campaign',
  meta_ads: 'Meta ad',
  video: 'Video',
  social: 'Social post',
  email: 'Email',
}

export type PlayKind = 'content_gap' | 'unclaimed_angle' | 'pain_point' | 'search_gap' | 'channel_gap' | 'counter'

/**
 * One thing to make, and why. A play does not publish anything: it opens the
 * right composer prefilled, and whatever comes out goes through the normal
 * scoring and approval gate there.
 */
export type Play = {
  id: string
  kind: PlayKind
  title: string
  why: string
  evidence: string[]
  destinations: PlayDestination[]
  priority: 'high' | 'medium' | 'low'
  brief: {
    title: string
    objective: string
    keyMessages: string[]
    /** Searches the content or ads should target. */
    keywords: string[]
  }
}

export type ClaimRow = {
  claim: Claim
  /** competitor id → number of ads/pages making this claim. */
  byCompetitor: Record<string, number>
  competitorsUsing: number
  /** Whether our own site makes it. null when our site was not readable. */
  us: boolean | null
}

export type SearchCell = { competitorId: string; organic: number | null; paid: boolean }
export type SearchRow = {
  keyword: string
  usOrganic: number | null
  usPaid: boolean
  cells: SearchCell[]
  /** Competitors on page one for this search. */
  crowding: number
}

export type ContentTopic = {
  topic: string
  competitors: string[]
  examples: { title: string; url: string }[]
  weCover: boolean
}

export type PainPoint = {
  theme: string
  label: string
  /** How many low-star reviews across competitors mention it. */
  mentions: number
  competitors: string[]
  quotes: string[]
}

export type LandscapeReport = {
  generatedAt: string
  competitorIds: string[]
  /** id → display name, so the report renders without a join. */
  names: Record<string, string>
  simulated: boolean
  summary: string
  /** What the business can credibly own that competitors do not. */
  differentiators: Insight[]
  claims: ClaimRow[]
  search: SearchRow[]
  shareOfVoice: { competitorId: string | 'us'; name: string; share: number }[]
  content: ContentTopic[]
  painPoints: PainPoint[]
  channels: { channel: ChannelKey; competitorsActive: number; us: 0 | 1 | 2 | 3 }[]
  plays: Play[]
}

/* ---------------------------------------------------------------- changes */

export type ChangeKind =
  | 'new_ads'
  | 'ads_stopped'
  | 'price_change'
  | 'new_posts'
  | 'rating_change'
  | 'new_channel'
  | 'ranking_gain'
  | 'positioning_change'

export type Change = {
  kind: ChangeKind
  summary: string
  detail: string[]
  /** Significant changes notify the team. */
  significant: boolean
}
