import type { AdAssetRow, AuctionRow, MatchType, OrganicRow, SearchTermRow } from './types'

/**
 * Live data mapping.
 *
 * The engines take plain rows; these are the queries that fetch them and the
 * pure functions that turn API responses into rows. Aurea already has a
 * version-pinned Google Ads REST client with a GAQL `search` method (see the
 * platform handover); these plug into it. Search Console needs one OAuth
 * scope, `https://www.googleapis.com/auth/webmasters.readonly`.
 */

// ───────────────────────────── Google Ads (GAQL)

export function searchTermsQuery(start: string, end: string): string {
  return `
    SELECT segments.date, campaign.id, ad_group.id,
           segments.keyword.ad_group_criterion, segments.keyword.info.text, segments.keyword.info.match_type,
           search_term_view.search_term,
           metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND campaign.advertising_channel_type = 'SEARCH'
      AND metrics.impressions > 0`
    .replace(/\s+/g, ' ')
    .trim()
}

export function assetQuery(): string {
  return `
    SELECT ad_group.id, ad_group_ad.ad.id, asset.id, asset.text_asset.text,
           ad_group_ad_asset_view.field_type,
           metrics.impressions, metrics.clicks, metrics.conversions
    FROM ad_group_ad_asset_view
    WHERE ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')
      AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
      AND ad_group_ad_asset_view.enabled = TRUE`
    .replace(/\s+/g, ' ')
    .trim()
}

/** GAQL rows arrive as nested camelCase JSON from the REST `search` endpoint. */
export interface GaqlSearchTermRow {
  segments: {
    date: string
    keyword?: { adGroupCriterion?: string; info?: { text?: string; matchType?: string } }
  }
  campaign: { id: string }
  adGroup: { id: string }
  searchTermView: { searchTerm: string }
  metrics: {
    impressions?: string
    clicks?: string
    costMicros?: string
    conversions?: number
    conversionsValue?: number
  }
}

export function mapSearchTerm(r: GaqlSearchTermRow): SearchTermRow {
  const crit = r.segments.keyword?.adGroupCriterion ?? ''
  return {
    date: r.segments.date,
    campaignId: r.campaign.id,
    adGroupId: r.adGroup.id,
    // resource name "customers/1/adGroupCriteria/{adGroupId}~{criterionId}"
    keywordId: crit.split('~')[1] ?? crit,
    searchTerm: r.searchTermView.searchTerm,
    impressions: Number(r.metrics.impressions ?? 0),
    clicks: Number(r.metrics.clicks ?? 0),
    costMicros: Number(r.metrics.costMicros ?? 0),
    conversions: Number(r.metrics.conversions ?? 0),
    conversionValue: Number(r.metrics.conversionsValue ?? 0),
  }
}

export function mapMatchType(t: string | undefined): MatchType {
  return t === 'EXACT' ? 'EXACT' : t === 'PHRASE' ? 'PHRASE' : 'BROAD'
}

export interface GaqlAssetRow {
  adGroup: { id: string }
  adGroupAd: { ad: { id: string } }
  asset: { id: string; textAsset?: { text?: string } }
  adGroupAdAssetView: { fieldType: string }
  metrics: { impressions?: string; clicks?: string; conversions?: number }
}

export function mapAsset(r: GaqlAssetRow): AdAssetRow | null {
  const field = r.adGroupAdAssetView.fieldType
  if (field !== 'HEADLINE' && field !== 'DESCRIPTION') return null
  return {
    adGroupId: r.adGroup.id,
    adId: r.adGroupAd.ad.id,
    assetId: r.asset.id,
    field,
    text: r.asset.textAsset?.text ?? '',
    impressions: Number(r.metrics.impressions ?? 0),
    clicks: Number(r.metrics.clicks ?? 0),
    conversions: Number(r.metrics.conversions ?? 0),
  }
}

/**
 * Auction insights. The API exposes these metrics only to allowlisted
 * developer tokens, so the default path is the keyword-level CSV export from
 * the Google Ads UI (Keywords → Auction insights → Download). Percentages
 * arrive as "42.18%" or "< 10%"; "< 10%" is read as 5%.
 */
export function mapAuctionCsv(keywordId: string, rows: Record<string, string>[]): AuctionRow[] {
  const pctOf = (s: string | undefined) => {
    if (!s) return 0
    if (s.trim().startsWith('<')) return 0.05
    const n = parseFloat(s.replace(/[%,\s]/g, ''))
    return Number.isFinite(n) ? n / 100 : 0
  }
  return rows
    .filter((r) => (r['Display URL domain'] ?? '').toLowerCase() !== 'you')
    .map((r) => ({
      keywordId,
      competitorDomain: (r['Display URL domain'] ?? '').trim(),
      overlapRate: pctOf(r['Overlap rate']),
    }))
    .filter((r) => r.competitorDomain.length > 0)
}

// ───────────────────────────── Search Console

export const GSC_ROW_LIMIT = 25_000

export function gscRequest(start: string, end: string, startRow = 0) {
  return {
    startDate: start,
    endDate: end,
    dimensions: ['date', 'query', 'page'],
    type: 'web',
    dataState: 'final',
    rowLimit: GSC_ROW_LIMIT,
    startRow,
  } as const
}

export function gscEndpoint(siteUrl: string): string {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`
}

export interface GscRow {
  keys: [string, string, string]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export function mapGsc(r: GscRow): OrganicRow {
  const [date, query, page] = r.keys
  return { date, query, page, clicks: r.clicks, impressions: r.impressions, position: r.position }
}
