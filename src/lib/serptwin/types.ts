/**
 * SERP Twin — shared types.
 *
 * Every input row mirrors a real report so the live connectors are a mapping
 * exercise, not a redesign:
 *   SearchTermRow  ← Google Ads `search_term_view` (GAQL), segmented by date
 *   AdAssetRow     ← Google Ads `ad_group_ad_asset_view` (RSA asset metrics)
 *   AuctionRow     ← Google Ads auction insights, per keyword
 *   OrganicRow     ← Search Console `searchanalytics.query`, dims [date, query, page]
 *   PageMeta       ← the site's own <title> / <meta name="description">
 */

export type Iso = string // YYYY-MM-DD

export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD'

export type Intent =
  'transactional' | 'commercial' | 'informational' | 'navigational' | 'careers' | 'free_seeker'

export const INTENTS: readonly Intent[] = [
  'transactional',
  'commercial',
  'informational',
  'navigational',
  'careers',
  'free_seeker',
] as const

export interface KeywordRow {
  keywordId: string
  adGroupId: string
  campaignId: string
  text: string
  matchType: MatchType
}

export interface AdGroupRow {
  adGroupId: string
  campaignId: string
  name: string
}

export interface SearchTermRow {
  date: Iso
  campaignId: string
  adGroupId: string
  keywordId: string
  searchTerm: string
  impressions: number
  clicks: number
  costMicros: number
  conversions: number
  conversionValue: number
}

export type AssetField = 'HEADLINE' | 'DESCRIPTION'

export interface AdAssetRow {
  adGroupId: string
  adId: string
  assetId: string
  field: AssetField
  text: string
  impressions: number
  clicks: number
  conversions: number
}

export interface AuctionRow {
  keywordId: string
  competitorDomain: string
  /** Share of your auctions in which this competitor also showed (0–1). */
  overlapRate: number
}

export interface OrganicRow {
  date: Iso
  query: string
  page: string
  impressions: number
  clicks: number
  /** Search Console average position for the row (1 = top). */
  position: number
}

export interface PageMeta {
  url: string
  title: string
  metaDescription: string
  /** The page's main heading, when known. Used to write a unique title if titles are duplicated. */
  h1?: string
}

export interface SerpTwinInput {
  workspace: string
  brand: { name: string; terms: string[] }
  keywords: KeywordRow[]
  adGroups: AdGroupRow[]
  searchTerms: SearchTermRow[]
  assets: AdAssetRow[]
  auction: AuctionRow[]
  organic: OrganicRow[]
  pages: PageMeta[]
  /** Workspace guardrails; the same banned-terms list the Content Studio uses. */
  bannedTerms?: string[]
  /** True when the rows came from the simulator, not a live account. */
  simulated: boolean
  /** What in this data is real and what is simulated, in a sentence. */
  dataNote?: string
  /** What the business sells, what each sale is worth and what it can deliver. Enables engines 5–7. */
  business?: BusinessProfile
  /** Enquiries and what became of them. */
  leads?: Lead[]
}

export interface SerpTwinSettings {
  currency: 'GBP' | 'USD' | 'EUR'
  /**
   * Value of a conversion when the account does not report conversion value.
   * A money assumption, so it lives in settings — never inferred by a model.
   */
  fallbackValuePerConversion: number
  /** Minimum paid clicks in the window before a query is judged at all. */
  minQueryClicks: number
  /** Days at the end of the window treated as "recent" by the drift engine. */
  recentDays: number
  /** Maximum length of a proposed pause experiment before it is called untestable. */
  maxExperimentDays: number
}

export const DEFAULT_SETTINGS: SerpTwinSettings = {
  currency: 'GBP',
  fallbackValuePerConversion: 180,
  minQueryClicks: 10,
  recentDays: 14,
  maxExperimentDays: 56,
}

// ───────────────────────────── The business behind the ads

/**
 * One thing the business sells. Everything the lead, budget and SEO engines
 * know about profit and capacity comes from here — stated by a person, never
 * inferred — because a campaign that brings cheap enquiries for a service the
 * team cannot deliver this month is not a good campaign.
 */
export interface ServiceDef {
  id: string
  name: string
  /** Words that mean someone wants this service ("migration", "boiler repair"). */
  keywords: string[]
  /** Ad groups that promote it. Spend is attributed through these. */
  adGroupIds: string[]
  /** Gross profit from one new customer, in account currency. */
  marginPerCustomer: number
  /** New customers the team can take on per week. Null = no practical limit. */
  weeklyCapacity: number | null
  /** Already booked or committed for the coming week. */
  bookedThisWeek: number
  /** Pages that sell it. */
  landingPages: string[]
  /** A service the business wants to grow gets priority in SEO work. */
  growthPriority: 'grow' | 'maintain' | 'reduce'
}

export interface BusinessProfile {
  services: ServiceDef[]
  /**
   * Where the business can deliver: ISO country codes ("GB", "IE") or a UK
   * postcode area written with its country ("GB:M", "GB:SK"). Empty = anywhere.
   */
  serviceAreas: string[]
  /** Phrases for things the business does not do ("personal debt", "email lists"). */
  notOffered: string[]
  /** Working hours within which a new enquiry should get a first reply. */
  followUpSlaHours: number
  /** Contact attempts after which a silent lead counts as unreachable, not bad. */
  unreachableAfterAttempts: number
  /** Largest weekly budget move the engine may propose, as a fraction (0.2 = ±20%). */
  maxWeeklyBudgetChange: number
}

export type LeadSource = 'ppc' | 'organic' | 'direct' | 'referral'
export type LeadOutcome = 'open' | 'won' | 'lost' | 'unqualified' | 'spam'

export interface Lead {
  id: string
  receivedAt: string // ISO timestamp
  source: LeadSource
  /** Google click id, present on paid enquiries; what an offline conversion is keyed on. */
  gclid?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  searchTerm?: string | null
  landingPage?: string | null
  /** The service the enquirer picked on the form, if the form asks. */
  serviceId?: string | null
  message: string
  email?: string | null
  phone?: string | null
  /** Where the enquiry came from: ISO country code, plus UK postcode area when known ("M", "SK"). */
  location?: { country: string; area?: string | null } | null
  /** Form-level signals. All optional; the engine uses whichever are present. */
  signals?: {
    secondsToSubmit?: number
    honeypotFilled?: boolean
    disposableEmail?: boolean
    phoneValid?: boolean
  }
  firstResponseAt?: string | null
  contactAttempts: number
  outcome: LeadOutcome
  /** In the salesperson's own words. The engine reads it; it never has to be a dropdown. */
  lostReason?: string | null
  value?: number | null
}

// ───────────────────────────── Evidence & recommendations

export interface Evidence {
  label: string
  value: string
}

export type Engine = 'overlap' | 'genome' | 'transfer' | 'drift' | 'leads' | 'capacity' | 'demand'

export type Confidence = 'measured' | 'estimated' | 'hypothesis'

export interface ProposedAction {
  /** Machine-readable verb the GenAI worker understands. */
  kind:
    | 'start_pause_experiment'
    | 'add_negative_keywords'
    | 'update_page_meta'
    | 'pin_headline'
    | 'add_headline'
    | 'replace_headline'
    | 'create_content_brief'
    | 'keep_paid_coverage'
    | 'adjust_budget'
    | 'add_location_exclusions'
    | 'upload_offline_conversions'
    | 'fix_follow_up'
    | 'enable_form_checks'
    | 'clarify_landing_page'
  /** Human description, shown on the approval screen. */
  description: string
  payload: Record<string, unknown>
  /** Exact inverse, captured before anything mutates. `null` = nothing to undo. */
  undo: Record<string, unknown> | null
  /** Touches money or a live surface, so it goes through the approval engine. */
  requiresApproval: boolean
}

export interface Recommendation {
  id: string
  engine: Engine
  title: string
  summary: string
  /** Signed monthly impact in account currency. Positive = money saved or earned. */
  monthlyImpact: number
  confidence: Confidence
  evidence: Evidence[]
  actions: ProposedAction[]
  /** The assumptions the figure depends on, stated so they can be challenged. */
  assumptions: string[]
}
