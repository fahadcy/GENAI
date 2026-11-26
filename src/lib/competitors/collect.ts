import 'server-only'
import { env } from '@/lib/env'
import { researchLinks } from './links'
import { normaliseDomain } from './profile'
import { simulatedByDomain, simulatedSnapshot } from './simulator'
import { configured, serpProvider } from './sources/config'
import { FetchRefused } from './sources/http'
import { placeReviews, placesTextSearch } from './sources/places'
import { companyProfile } from './sources/register'
import { adClaims, googleSearch, newsFor, topKeywordsFor, type SerpResult } from './sources/serp'
import { readWebsite } from './sources/website'
import { youtubeChannel } from './sources/youtube'
import { cachedSerp } from './serp-cache'
import type { CompanyProfile, PresenceSnapshot, ReviewSummary, SocialProfile, SourceRun } from './types'

/**
 * One business's online presence, read from every configured source.
 *
 * Each collector is independent and fails alone: a site that blocks readers
 * still gets its ads and reviews read, and a provider outage leaves one
 * section empty with the reason recorded in `sources`, not a failed scan.
 *
 * The same function reads the business's own presence (`target` = the
 * profile's company), so every comparison is like for like.
 */

export type ScanTarget = {
  name: string
  domain: string | null
  placeId: string | null
  companyNumber: string | null
}

const MAX_KEYWORDS = 6

export async function collectSnapshot(
  target: ScanTarget,
  profile: CompanyProfile,
  opts: { now?: Date } = {},
): Promise<PresenceSnapshot> {
  const now = opts.now ?? new Date()
  const domain = normaliseDomain(target.domain)

  const sim = simulatedByDomain(profile, domain)
  if (sim) return simulatedSnapshot(sim, profile, now)

  const runs: SourceRun[] = []
  const snap: PresenceSnapshot = {
    name: target.name,
    domain,
    collectedAt: now.toISOString(),
    simulated: false,
    sources: runs,
    pages: [],
    structured: { types: [], foundingYear: null, areaServed: [], priceRange: null },
    trustSignals: [],
    offers: [],
    blog: { feedUrl: null, posts: [], postsLast90Days: 0 },
    ads: [],
    organic: [],
    topKeywords: [],
    reviews: [],
    social: [],
    news: [],
    company: null,
    links: researchLinks({ name: target.name, domain, placeId: target.placeId }),
  }

  const run = async (source: SourceRun['source'], provider: string, fn: () => Promise<{ items: number; note?: string; status?: SourceRun['status'] }>) => {
    const started = Date.now()
    try {
      const r = await fn()
      runs.push({ source, provider, status: r.status ?? 'ok', note: r.note ?? '', items: r.items, ms: Date.now() - started })
    } catch (e) {
      const blocked = e instanceof FetchRefused
      runs.push({
        source,
        provider,
        status: blocked ? 'blocked' : 'error',
        note: (e as Error).message.slice(0, 300),
        items: 0,
        ms: Date.now() - started,
      })
    }
  }
  const skip = (source: SourceRun['source'], provider: string, note: string) =>
    runs.push({ source, provider, status: 'skipped', note, items: 0, ms: 0 })

  /* Website and blog ---------------------------------------------------- */
  const tasks: Promise<void>[] = []
  if (!domain) skip('website', 'Website', 'No website known for this business.')
  else if (env().COMPETITOR_CRAWL === 'off') skip('website', 'Website', 'Reading websites is switched off (COMPETITOR_CRAWL).')
  else {
    tasks.push(
      run('website', 'Website reader', async () => {
        const w = await readWebsite(domain)
        if (w.status !== 'ok') return { items: 0, note: w.note, status: w.status === 'blocked' ? 'blocked' : 'error' }
        snap.pages = w.pages
        snap.structured = {
          types: w.structured.types.slice(0, 8),
          foundingYear: w.structured.foundingYear,
          areaServed: w.structured.areaServed,
          priceRange: w.structured.priceRange,
        }
        snap.trustSignals = w.trustSignals
        snap.offers = Array.from(new Set([...w.pages.flatMap((p) => p.prices), ...w.structured.offers])).slice(0, 12)
        snap.blog = {
          feedUrl: w.feedUrl,
          posts: w.posts,
          postsLast90Days: w.posts.filter((p) => p.publishedAt && now.getTime() - Date.parse(p.publishedAt) <= 90 * 86_400_000).length,
        }
        snap.social = w.socials.map(
          (s): SocialProfile => ({ network: s.network, url: s.url, handle: s.handle, followers: null, posts: null, recent: [], depth: 'link' }),
        )
        return { items: w.pages.length + w.posts.length, note: w.note }
      }),
    )
  }

  /* Google search: their ads and rankings on the profile's searches ------ */
  const provider = serpProvider()
  const keywords = profile.keywords.slice(0, MAX_KEYWORDS)
  if (!provider) skip('serp', 'Google search', 'No search provider configured, so ads and rankings are not read.')
  else if (!domain) skip('serp', 'Google search', 'No website, so their ads and rankings cannot be matched.')
  else {
    tasks.push(
      run('serp', provider === 'dataforseo' ? 'DataForSEO' : provider === 'serpapi' ? 'SerpApi' : 'Serper', async () => {
        const serps: SerpResult[] = []
        for (const k of keywords) {
          const q = profile.scope === 'local' && profile.locality ? `${k} ${profile.locality}` : k
          const r = await cachedSerp(q, () => googleSearch(q))
          if (r) serps.push({ ...r, keyword: k })
        }
        const mine = (d: string) => d === domain || d.endsWith(`.${domain}`)
        for (const r of serps) {
          for (const o of r.organic) {
            if (mine(o.domain) && !snap.organic.some((x) => x.keyword === r.keyword)) {
              snap.organic.push({ keyword: r.keyword, position: o.position, url: o.url, title: o.title, snippet: o.snippet })
            }
          }
          for (const a of r.ads) {
            if (mine(a.domain)) {
              snap.ads.push({
                keyword: r.keyword,
                position: a.position,
                headline: a.headline,
                description: a.description,
                displayUrl: a.displayUrl,
                finalUrl: a.url || null,
                claims: adClaims(a.headline, a.description),
              })
            }
          }
        }
        const adsNote = serps.some((s) => !s.adsSupported) ? ' This provider does not return ads.' : ''
        return { items: snap.organic.length + snap.ads.length, note: `${serps.length} searches read.${adsNote}` }
      }),
    )
  }

  /* Keyword database ------------------------------------------------------ */
  if (domain && configured('dataforseo')) {
    tasks.push(
      run('keywords', 'DataForSEO Labs', async () => {
        snap.topKeywords = (await topKeywordsFor(domain)) ?? []
        return { items: snap.topKeywords.length }
      }),
    )
  }

  /* Reviews --------------------------------------------------------------- */
  if (configured('places')) {
    tasks.push(
      run('reviews', 'Google Places', async () => {
        let placeId = target.placeId
        if (!placeId) {
          const hits = await placesTextSearch(`${target.name}${profile.locality ? ` ${profile.locality}` : ''}`, null)
          placeId = (hits.find((h) => domain && h.domain === domain) ?? (domain ? null : hits[0]))?.placeId ?? null
        }
        if (!placeId) return { items: 0, note: 'No Google Business Profile found for this business.', status: 'skipped' }
        const g: ReviewSummary = await placeReviews(placeId)
        snap.reviews.push(g)
        snap.links = researchLinks({ name: target.name, domain, placeId })
        return { items: g.samples.length, note: g.rating ? `${g.rating}★ from ${g.count}` : '' }
      }),
    )
  } else skip('reviews', 'Google Places', 'GOOGLE_PLACES_API_KEY is not set, so reviews are not read.')

  /* News -------------------------------------------------------------------- */
  if (configured('serper')) {
    tasks.push(
      run('news', 'Serper', async () => {
        snap.news = (await newsFor(`"${target.name}"`)) ?? []
        return { items: snap.news.length }
      }),
    )
  }

  /* The register ------------------------------------------------------------ */
  if (target.companyNumber && configured('companies_house')) {
    tasks.push(
      run('companies_house', 'Companies House', async () => {
        const c = await companyProfile(target.companyNumber!)
        snap.company = {
          companyNumber: c.companyNumber,
          name: c.name,
          status: c.status,
          incorporatedOn: c.incorporatedOn,
          sicCodes: c.sicCodes,
          accountsType: c.accountsType,
        }
        return { items: 1 }
      }),
    )
  }

  await Promise.all(tasks)

  /* YouTube, once the website has told us the channel ------------------------ */
  const yt = snap.social.find((s) => s.network === 'youtube')
  if (yt?.handle && configured('youtube')) {
    await run('youtube', 'YouTube Data API', async () => {
      const ch = await youtubeChannel(yt.handle!, yt.url)
      if (!ch) return { items: 0, note: 'Channel not found.', status: 'skipped' }
      snap.social = snap.social.map((s) => (s.network === 'youtube' ? ch : s))
      return { items: ch.recent.length, note: ch.followers !== null ? `${ch.followers.toLocaleString('en-GB')} subscribers` : '' }
    })
  }

  return snap
}
