import 'server-only'
import { env, hasLiveModel } from '@/lib/env'

/**
 * Which outside sources are switched on. Each is independent: a workspace with
 * only a Companies House key gets real register data and simulated
 * everything else, and the screen says exactly that.
 */

export type ProviderId =
  | 'model'
  | 'companies_house'
  | 'places'
  | 'dataforseo'
  | 'serpapi'
  | 'serper'
  | 'youtube'
  | 'crawler'
  | 'postcodes'

export type ProviderStatus = {
  id: ProviderId
  label: string
  provides: string
  configured: boolean
  /** Settings to add to turn it on. Empty when configured or when nothing is needed. */
  missing: string[]
  /** What happens without it. */
  fallback: string
}

export function providerStatus(): ProviderStatus[] {
  const e = env()
  const row = (
    id: ProviderId,
    label: string,
    provides: string,
    vars: [string, string | undefined][],
    fallback: string,
  ): ProviderStatus => {
    const missing = vars.filter(([, v]) => !v).map(([k]) => k)
    return { id, label, provides, configured: missing.length === 0, missing, fallback }
  }
  return [
    {
      id: 'crawler',
      label: 'Public websites and blog feeds',
      provides: 'Positioning, services, prices, trust signals, calls to action, social links, blog posts',
      configured: e.COMPETITOR_CRAWL === 'on',
      missing: e.COMPETITOR_CRAWL === 'on' ? [] : ['COMPETITOR_CRAWL'],
      fallback: 'Simulated pages for simulated competitors only',
    },
    {
      id: 'postcodes',
      label: 'postcodes.io',
      provides: 'Turns your postcode into a map location for local discovery',
      configured: true,
      missing: [],
      fallback: '—',
    },
    {
      id: 'model',
      label: 'AI model',
      provides: 'Business type, positioning, competitive advantage and how to win, with evidence',
      configured: hasLiveModel(),
      missing: hasLiveModel() ? [] : [e.AI_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'],
      fallback: 'Rules-based classification and a template analysis built from the same evidence',
    },
    row(
      'companies_house',
      'Companies House',
      'Your company, its SIC codes and age; active companies with the same SIC code',
      [['COMPANIES_HOUSE_API_KEY', e.COMPANIES_HOUSE_API_KEY]],
      'Type your company details in by hand',
    ),
    row(
      'places',
      'Google Places',
      'Businesses near you and UK-wide, with website, rating, review count and recent reviews',
      [['GOOGLE_PLACES_API_KEY', e.GOOGLE_PLACES_API_KEY]],
      'Simulated local competitors',
    ),
    row(
      'dataforseo',
      'DataForSEO',
      'Google results with competitors’ ad copy; shared keywords; each competitor’s top keywords',
      [
        ['DATAFORSEO_LOGIN', e.DATAFORSEO_LOGIN],
        ['DATAFORSEO_PASSWORD', e.DATAFORSEO_PASSWORD],
      ],
      'SerpApi or Serper if set, otherwise simulated search results',
    ),
    row(
      'serpapi',
      'SerpApi',
      'Google results with competitors’ ad copy',
      [['SERPAPI_API_KEY', e.SERPAPI_API_KEY]],
      'Serper if set, otherwise simulated search results',
    ),
    row(
      'serper',
      'Serper',
      'Google organic results and news (no ads)',
      [['SERPER_API_KEY', e.SERPER_API_KEY]],
      'Simulated search results and no news',
    ),
    row(
      'youtube',
      'YouTube Data API',
      'Channel size and latest uploads',
      [['YOUTUBE_API_KEY', e.YOUTUBE_API_KEY]],
      'Channel link only',
    ),
  ]
}

export function configured(id: ProviderId): boolean {
  return providerStatus().find((p) => p.id === id)?.configured ?? false
}

/** The SERP provider to use, best first. Serper has no ads, so it is last. */
export function serpProvider(): 'dataforseo' | 'serpapi' | 'serper' | null {
  if (configured('dataforseo')) return 'dataforseo'
  if (configured('serpapi')) return 'serpapi'
  if (configured('serper')) return 'serper'
  return null
}

/** True when nothing beyond the free sources is configured — discovery will be simulated. */
export function discoveryIsSimulated(): boolean {
  return !configured('places') && serpProvider() === null && !configured('companies_house')
}
