import 'server-only'
import { env } from '@/lib/env'
import { extractClaims } from '@/lib/serptwin/claims'
import { normaliseDomain } from '../profile'
import type { NewsItem } from '../types'
import { apiJson } from './http'
import { serpProvider } from './config'

/**
 * Google results for a search, from whichever provider is configured.
 *
 * Organic results say who wins the search for free; paid results say who is
 * paying to win it and with what words. Serper returns no ads at all, which is
 * why it is the last choice and why the screen says "no ad data" rather than
 * "no ads" when it is the only provider.
 *
 * The three response parsers are exported and pure, so they are tested
 * against recorded response shapes without a network.
 */

export type SerpOrganic = { position: number; title: string; url: string; domain: string; snippet: string }
export type SerpAd = {
  position: number
  headline: string
  description: string
  url: string
  domain: string
  displayUrl: string | null
}
export type SerpLocal = { title: string; domain: string | null; rating: number | null; reviews: number }

export type SerpResult = {
  keyword: string
  provider: 'dataforseo' | 'serpapi' | 'serper'
  organic: SerpOrganic[]
  ads: SerpAd[]
  /** False when the provider cannot return ads (Serper). */
  adsSupported: boolean
  local: SerpLocal[]
}

export async function googleSearch(keyword: string): Promise<SerpResult | null> {
  const provider = serpProvider()
  if (!provider) return null
  const e = env()
  if (provider === 'dataforseo') {
    const auth = Buffer.from(`${e.DATAFORSEO_LOGIN}:${e.DATAFORSEO_PASSWORD}`).toString('base64')
    const data = await apiJson<unknown>('DataForSEO', 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ keyword, location_code: 2826, language_code: 'en', device: 'desktop', depth: 20 }]),
      timeoutMs: 45_000,
    })
    assertDataForSeoOk(data)
    return parseDataForSeo(keyword, data)
  }
  if (provider === 'serpapi') {
    const q = new URLSearchParams({
      engine: 'google',
      q: keyword,
      gl: 'uk',
      hl: 'en',
      google_domain: 'google.co.uk',
      location: 'United Kingdom',
      api_key: e.SERPAPI_API_KEY!,
    })
    const data = await apiJson<unknown>('SerpApi', `https://serpapi.com/search.json?${q}`, { timeoutMs: 45_000 })
    return parseSerpApi(keyword, data)
  }
  const data = await apiJson<unknown>('Serper', 'https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': e.SERPER_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ q: keyword, gl: 'uk', hl: 'en', num: 20 }),
  })
  return parseSerper(keyword, data)
}

/* --------------------------------------------------------------- parsers */

type Obj = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The result's own URL first; a display string ("https://x.co.uk › fees") only as a fallback. */
function domainOf(url: string, fallback?: unknown): string {
  const alt = str(fallback).split(/[\s›>]/)[0]
  return normaliseDomain(url) ?? normaliseDomain(alt) ?? ''
}

/**
 * DataForSEO reports most errors inside an HTTP 200: a top-level and a
 * per-task `status_code`, where 20000 is success. Without this check an
 * unpaid account or a bad field looks exactly like "no results".
 */
export function assertDataForSeoOk(data: unknown): void {
  const d = (data ?? {}) as Obj
  const top = num(d.status_code)
  if (top !== null && top !== 20000) throw new Error(`DataForSEO ${top}: ${str(d.status_message)}`)
  const task = (d.tasks as Obj[] | undefined)?.[0]
  const code = num(task?.status_code)
  if (code !== null && code !== 20000) throw new Error(`DataForSEO ${code}: ${str(task?.status_message)}`)
}

export function parseDataForSeo(keyword: string, data: unknown): SerpResult {
  const items = ((((data as Obj)?.tasks as Obj[] | undefined)?.[0]?.result as Obj[] | undefined)?.[0]?.items ??
    []) as Obj[]
  const organic: SerpOrganic[] = []
  const ads: SerpAd[] = []
  const local: SerpLocal[] = []
  for (const it of items) {
    const type = str(it.type)
    if (type === 'organic') {
      const url = str(it.url)
      organic.push({
        position: num(it.rank_group) ?? organic.length + 1,
        title: str(it.title),
        url,
        domain: domainOf(url, it.domain),
        snippet: str(it.description),
      })
    } else if (type === 'paid') {
      const url = str(it.url)
      ads.push({
        position: num(it.rank_group) ?? ads.length + 1,
        headline: str(it.title),
        description: str(it.description),
        url,
        domain: domainOf(url, it.domain),
        displayUrl: str(it.breadcrumb) || null,
      })
    } else if (type === 'local_pack') {
      const rating = it.rating as Obj | undefined
      local.push({
        title: str(it.title),
        domain: normaliseDomain(str(it.domain) || str(it.url)),
        rating: num(rating?.value),
        reviews: num(rating?.votes_count) ?? 0,
      })
    }
  }
  return { keyword, provider: 'dataforseo', organic, ads, adsSupported: true, local }
}

export function parseSerpApi(keyword: string, data: unknown): SerpResult {
  const d = (data ?? {}) as Obj
  const organic = ((d.organic_results as Obj[] | undefined) ?? []).map((r, i) => {
    const url = str(r.link)
    return { position: num(r.position) ?? i + 1, title: str(r.title), url, domain: domainOf(url), snippet: str(r.snippet) }
  })
  const ads = ((d.ads as Obj[] | undefined) ?? []).map((a, i) => {
    const url = str(a.link)
    return {
      position: num(a.position) ?? i + 1,
      headline: str(a.title),
      description: str(a.description),
      url,
      domain: domainOf(url, a.displayed_link),
      displayUrl: str(a.displayed_link) || null,
    }
  })
  const lr = d.local_results as Obj | Obj[] | undefined
  const places = (Array.isArray(lr) ? lr : ((lr?.places as Obj[] | undefined) ?? [])) as Obj[]
  const local = places.map((p) => ({
    title: str(p.title),
    domain: normaliseDomain(str((p.links as Obj | undefined)?.website) || str(p.website)),
    rating: num(p.rating),
    reviews: num(p.reviews) ?? 0,
  }))
  return { keyword, provider: 'serpapi', organic, ads, adsSupported: true, local }
}

export function parseSerper(keyword: string, data: unknown): SerpResult {
  const d = (data ?? {}) as Obj
  const organic = ((d.organic as Obj[] | undefined) ?? []).map((r, i) => {
    const url = str(r.link)
    return { position: num(r.position) ?? i + 1, title: str(r.title), url, domain: domainOf(url), snippet: str(r.snippet) }
  })
  const local = ((d.places as Obj[] | undefined) ?? []).map((p) => ({
    title: str(p.title),
    domain: normaliseDomain(str(p.website)),
    rating: num(p.rating),
    reviews: num(p.ratingCount) ?? 0,
  }))
  return { keyword, provider: 'serper', organic, ads: [], adsSupported: false, local }
}

export { extractClaims }

/* ------------------------------------------------------------------ news */

/** Recent news mentions. Serper only; without it, news is left empty rather than simulated. */
export async function newsFor(query: string): Promise<NewsItem[] | null> {
  const key = env().SERPER_API_KEY
  if (!key) return null
  const data = await apiJson<{ news?: Obj[] }>('Serper', 'https://google.serper.dev/news', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'uk', hl: 'en', num: 10, tbs: 'qdr:y' }),
  })
  return (data.news ?? []).slice(0, 8).map((n) => ({
    title: str(n.title),
    url: str(n.link),
    source: str(n.source),
    publishedAt: str(n.date) || null,
  }))
}

/* ------------------------------------------------------ keyword database */

function dfsAuth(): string | null {
  const e = env()
  if (!e.DATAFORSEO_LOGIN || !e.DATAFORSEO_PASSWORD) return null
  return Buffer.from(`${e.DATAFORSEO_LOGIN}:${e.DATAFORSEO_PASSWORD}`).toString('base64')
}

/**
 * Domains that rank for the same keywords as `domain` in the UK, with how many
 * keywords they share. The strongest single signal of an online competitor.
 */
export async function sharedKeywordCompetitors(
  domain: string,
): Promise<{ domain: string; shared: number; avgPosition: number | null }[] | null> {
  const auth = dfsAuth()
  if (!auth) return null
  const data = await apiJson<unknown>('DataForSEO', 'https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live', {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify([{ target: domain, location_code: 2826, language_code: 'en', limit: 25, exclude_top_domains: true }]),
    timeoutMs: 45_000,
  })
  assertDataForSeoOk(data)
  const items = ((((data as Obj)?.tasks as Obj[] | undefined)?.[0]?.result as Obj[] | undefined)?.[0]?.items ??
    []) as Obj[]
  return items
    .map((it) => ({
      domain: normaliseDomain(str(it.domain)) ?? '',
      shared: num(it.intersections) ?? 0,
      avgPosition: num(it.avg_position),
    }))
    .filter((x) => x.domain && x.domain !== domain)
}

/** A domain's best UK keywords by search volume. */
export async function topKeywordsFor(
  domain: string,
): Promise<{ keyword: string; position: number; volume: number | null }[] | null> {
  const auth = dfsAuth()
  if (!auth) return null
  const data = await apiJson<unknown>('DataForSEO', 'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live', {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify([
      {
        target: domain,
        location_code: 2826,
        language_code: 'en',
        limit: 20,
        order_by: ['keyword_data.keyword_info.search_volume,desc'],
        filters: ['ranked_serp_element.serp_item.rank_group', '<=', 20],
      },
    ]),
    timeoutMs: 45_000,
  })
  assertDataForSeoOk(data)
  const items = ((((data as Obj)?.tasks as Obj[] | undefined)?.[0]?.result as Obj[] | undefined)?.[0]?.items ??
    []) as Obj[]
  return items
    .map((it) => {
      const kd = it.keyword_data as Obj | undefined
      const serp = (it.ranked_serp_element as Obj | undefined)?.serp_item as Obj | undefined
      return {
        keyword: str(kd?.keyword),
        position: num(serp?.rank_group) ?? 0,
        volume: num((kd?.keyword_info as Obj | undefined)?.search_volume),
      }
    })
    .filter((k) => k.keyword && k.position > 0)
}

/** Claims in an ad, using the same taxonomy as PPC & SEO so the two modules agree. */
export function adClaims(headline: string, description: string) {
  return extractClaims(`${headline} ${description}`.toLowerCase())
}
