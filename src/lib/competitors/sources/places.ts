import 'server-only'
import { env } from '@/lib/env'
import { emptyCandidate } from '../discovery'
import { normaliseDomain, postcodeIn } from '../profile'
import type { Candidate, ReviewSummary } from '../types'
import { apiJson } from './http'

/**
 * Google Places API (New).
 *
 * The prototype used the legacy `textsearch/json` endpoint, which Google has
 * closed to new projects. The New API prices by field mask, so the masks
 * below ask for exactly what discovery uses: identity, address, location,
 * rating, review count, website and category. Reviews are a more expensive
 * SKU and are only requested per competitor, at scan time.
 */

const BASE = 'https://places.googleapis.com/v1'

const SEARCH_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.types',
  'places.businessStatus',
  'nextPageToken',
].join(',')

type PlacesSearch = {
  places?: {
    id: string
    displayName?: { text?: string }
    formattedAddress?: string
    location?: { latitude: number; longitude: number }
    rating?: number
    userRatingCount?: number
    websiteUri?: string
    types?: string[]
    businessStatus?: string
  }[]
  nextPageToken?: string
}

function key(): string {
  const k = env().GOOGLE_PLACES_API_KEY
  if (!k) throw new Error('GOOGLE_PLACES_API_KEY is not set')
  return k
}

/**
 * Text search. With `near`, results are biased to a circle around the
 * business (local discovery); without it, UK-wide (the prototype's "virtual"
 * competitors for national and hybrid businesses).
 */
export async function placesTextSearch(
  textQuery: string,
  near: { lat: number; lng: number; radiusKm: number } | null,
  opts: { pages?: number } = {},
): Promise<Candidate[]> {
  const pages = Math.max(1, Math.min(3, opts.pages ?? 1))
  const out: Candidate[] = []
  let pageToken: string | undefined
  for (let page = 0; page < pages; page++) {
    const body: Record<string, unknown> = {
      textQuery,
      regionCode: 'GB',
      languageCode: 'en-GB',
      pageSize: 20,
    }
    if (near) {
      body.locationBias = {
        circle: {
          center: { latitude: near.lat, longitude: near.lng },
          radius: Math.min(50_000, Math.max(500, near.radiusKm * 1000)),
        },
      }
    }
    if (pageToken) body.pageToken = pageToken
    const data = await apiJson<PlacesSearch>('Google Places', `${BASE}/places:searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': SEARCH_MASK },
      body: JSON.stringify(body),
    })
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue
      const c = emptyCandidate(p.displayName?.text ?? '', near ? 'places_local' : 'places_national')
      c.placeId = p.id
      c.address = p.formattedAddress ?? null
      c.postcode = postcodeIn(p.formattedAddress)
      c.lat = p.location?.latitude ?? null
      c.lng = p.location?.longitude ?? null
      c.rating = typeof p.rating === 'number' ? p.rating : null
      c.reviewCount = p.userRatingCount ?? 0
      c.domain = normaliseDomain(p.websiteUri)
      c.types = (p.types ?? []).map((t) => t.toLowerCase())
      c.matchedKeywords = [textQuery]
      if (c.name) out.push(c)
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  return out
}

type PlaceDetails = {
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
  reviews?: {
    rating?: number
    text?: { text?: string }
    originalText?: { text?: string }
    publishTime?: string
  }[]
}

/**
 * Rating, count and up to five recent reviews. Author names and photos are
 * deliberately not requested: the analysis needs what customers said, not who
 * said it, and storing reviewers' names would make this personal data.
 */
export async function placeReviews(placeId: string): Promise<ReviewSummary> {
  const data = await apiJson<PlaceDetails>('Google Places', `${BASE}/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': key(),
      // `reviews` is the documented field; author details come with it and are dropped below.
      'X-Goog-FieldMask': 'rating,userRatingCount,googleMapsUri,reviews',
    },
  })
  return {
    source: 'google',
    rating: typeof data.rating === 'number' ? data.rating : null,
    count: data.userRatingCount ?? 0,
    url: data.googleMapsUri ?? null,
    samples: (data.reviews ?? [])
      .map((r) => ({
        rating: r.rating ?? 0,
        text: (r.originalText?.text ?? r.text?.text ?? '').slice(0, 600),
        publishedAt: r.publishTime ?? null,
        source: 'Google',
      }))
      .filter((r) => r.text),
  }
}
