import { describe, expect, it } from './expect'
import {
  assetQuery,
  gscEndpoint,
  gscRequest,
  mapAsset,
  mapAuctionCsv,
  mapGsc,
  mapSearchTerm,
  searchTermsQuery,
} from '../src/lib/serptwin/connectors'

describe('live data mapping', () => {
  it('builds a date-bounded GAQL query on search_term_view', () => {
    const q = searchTermsQuery('2026-08-03', '2026-09-27')
    expect(q).toMatch(/FROM search_term_view/)
    expect(q).toMatch(/BETWEEN '2026-08-03' AND '2026-09-27'/)
    expect(assetQuery()).toMatch(/FROM ad_group_ad_asset_view/)
  })

  it('maps a REST search-term row, including the criterion id from its resource name', () => {
    const row = mapSearchTerm({
      segments: {
        date: '2026-09-01',
        keyword: {
          adGroupCriterion: 'customers/123/adGroupCriteria/456~789',
          info: { text: 'marketing automation', matchType: 'BROAD' },
        },
      },
      campaign: { id: '11' },
      adGroup: { id: '456' },
      searchTermView: { searchTerm: 'marketing automation jobs' },
      metrics: {
        impressions: '40',
        clicks: '3',
        costMicros: '10500000',
        conversions: 0,
        conversionsValue: 0,
      },
    })
    expect(row).toMatchObject({ keywordId: '789', impressions: 40, clicks: 3, costMicros: 10_500_000 })
  })

  it('maps RSA asset rows and ignores other field types', () => {
    const base = {
      adGroup: { id: '1' },
      adGroupAd: { ad: { id: '2' } },
      asset: { id: '3', textAsset: { text: 'Cancel Anytime' } },
      metrics: { impressions: '100', clicks: '5', conversions: 1 },
    }
    expect(mapAsset({ ...base, adGroupAdAssetView: { fieldType: 'HEADLINE' } })?.text).toBe('Cancel Anytime')
    expect(mapAsset({ ...base, adGroupAdAssetView: { fieldType: 'SITELINK' } })).toBeNull()
  })

  it("reads the auction-insights CSV, dropping 'You' and reading '< 10%'", () => {
    const rows = mapAuctionCsv('k1', [
      { 'Display URL domain': 'You', 'Overlap rate': '--' },
      { 'Display URL domain': 'pipeloop.example', 'Overlap rate': '42.18%' },
      { 'Display URL domain': 'tiny.example', 'Overlap rate': '< 10%' },
    ])
    expect(rows).toEqual([
      { keywordId: 'k1', competitorDomain: 'pipeloop.example', overlapRate: 0.4218 },
      { keywordId: 'k1', competitorDomain: 'tiny.example', overlapRate: 0.05 },
    ])
  })

  it('builds a paged Search Console request and maps its rows', () => {
    expect(gscRequest('2026-08-03', '2026-09-27', 25_000)).toMatchObject({
      dimensions: ['date', 'query', 'page'],
      startRow: 25_000,
    })
    expect(gscEndpoint('sc-domain:cygroup.example')).toContain('sc-domain%3Acygroup.example')
    expect(
      mapGsc({
        keys: ['2026-09-01', 'cy group', 'https://x/'],
        clicks: 3,
        impressions: 10,
        ctr: 0.3,
        position: 1.2,
      }),
    ).toEqual({
      date: '2026-09-01',
      query: 'cy group',
      page: 'https://x/',
      clicks: 3,
      impressions: 10,
      position: 1.2,
    })
  })
})
