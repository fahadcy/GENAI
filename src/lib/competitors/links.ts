/**
 * Research links a person opens in their own browser.
 *
 * Some of the most useful competitor evidence has no legitimate API for the
 * UK: Meta's Ad Library API only returns UK ads about politics and social
 * issues, Google's Ads Transparency Center has no official API, and LinkedIn
 * and TikTok offer no way to read another company's posts. Scraping them would
 * breach their terms. So the module does the next most useful thing: it builds
 * the exact filtered link, one click from the evidence. Pure.
 */

import type { ResearchLinks } from './types'

export function researchLinks(input: {
  name: string
  domain: string | null
  placeId?: string | null
}): ResearchLinks {
  const name = input.name.trim()
  const q = encodeURIComponent(name)
  return {
    website: input.domain ? `https://${input.domain}` : null,
    googleAdsTransparency: input.domain
      ? `https://adstransparency.google.com/?region=GB&domain=${encodeURIComponent(input.domain)}`
      : `https://adstransparency.google.com/?region=GB`,
    metaAdLibrary: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=GB&q=${q}&search_type=keyword_unordered&media_type=all`,
    googleMaps: input.placeId
      ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(input.placeId)}`
      : `https://www.google.com/maps/search/${q}`,
    trustpilot: input.domain ? `https://uk.trustpilot.com/review/${encodeURIComponent(input.domain)}` : null,
    linkedinSearch: `https://www.linkedin.com/search/results/companies/?keywords=${q}`,
    tiktokSearch: `https://www.tiktok.com/search/user?q=${q}`,
  }
}
