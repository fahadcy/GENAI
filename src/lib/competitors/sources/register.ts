import 'server-only'
import { env } from '@/lib/env'
import { emptyCandidate } from '../discovery'
import { normalisePostcode, parseSicCodes } from '../profile'
import type { Candidate, CompanyFacts } from '../types'
import { ApiError, apiJson } from './http'

/**
 * Companies House and postcodes.io.
 *
 * Companies House authenticates with HTTP Basic: the key is the username and
 * the password is empty. 600 requests per five minutes; going over locks the
 * key out for the rest of the window, so discovery makes a handful of calls,
 * not hundreds.
 */

const CH = 'https://api.company-information.service.gov.uk'

function chHeaders(): HeadersInit {
  const key = env().COMPANIES_HOUSE_API_KEY
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY is not set')
  return { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json' }
}

export type RegisterHit = {
  companyNumber: string
  name: string
  status: string | null
  address: string | null
  incorporatedOn: string | null
}

type ChSearch = {
  items?: {
    company_number: string
    title: string
    company_status?: string
    address_snippet?: string
    date_of_creation?: string
  }[]
}

export async function searchCompanies(query: string, size = 10): Promise<RegisterHit[]> {
  const q = new URLSearchParams({ q: query, items_per_page: String(size) })
  const data = await apiJson<ChSearch>('Companies House', `${CH}/search/companies?${q}`, { headers: chHeaders() })
  return (data.items ?? []).map((c) => ({
    companyNumber: c.company_number,
    name: c.title,
    status: c.company_status ?? null,
    address: c.address_snippet ?? null,
    incorporatedOn: c.date_of_creation ?? null,
  }))
}

type ChProfile = {
  company_number: string
  company_name: string
  company_status?: string
  date_of_creation?: string
  sic_codes?: string[]
  registered_office_address?: {
    address_line_1?: string
    address_line_2?: string
    locality?: string
    region?: string
    postal_code?: string
  }
  accounts?: { last_accounts?: { type?: string } }
}

export type RegisterProfile = CompanyFacts & {
  address: string | null
  postcode: string | null
  locality: string | null
}

export async function companyProfile(companyNumber: string): Promise<RegisterProfile> {
  const n = encodeURIComponent(companyNumber.trim().toUpperCase())
  const c = await apiJson<ChProfile>('Companies House', `${CH}/company/${n}`, { headers: chHeaders() })
  const a = c.registered_office_address ?? {}
  return {
    companyNumber: c.company_number,
    name: c.company_name,
    status: c.company_status ?? null,
    incorporatedOn: c.date_of_creation ?? null,
    sicCodes: parseSicCodes(c.sic_codes ?? []),
    accountsType: c.accounts?.last_accounts?.type ?? null,
    address: [a.address_line_1, a.address_line_2, a.locality, a.postal_code].filter(Boolean).join(', ') || null,
    postcode: normalisePostcode(a.postal_code),
    locality: a.locality ?? null,
  }
}

type ChAdvanced = {
  items?: {
    company_number: string
    company_name: string
    company_status?: string
    date_of_creation?: string
    sic_codes?: string[]
    registered_office_address?: { locality?: string; postal_code?: string; address_line_1?: string }
  }[]
}

/**
 * Active companies with the same SIC codes in the same locality. Breadth, not
 * precision: a SIC code covers whole industries, so these arrive as weak
 * candidates and usually land as indirect competitors unless another source
 * corroborates them.
 */
export async function sameSicCompanies(sicCodes: string[], locality: string | null, size = 40): Promise<Candidate[]> {
  if (sicCodes.length === 0) return []
  const q = new URLSearchParams({ company_status: 'active', size: String(size) })
  for (const s of sicCodes.slice(0, 3)) q.append('sic_codes', s)
  if (locality) q.set('location', locality)
  let data: ChAdvanced
  try {
    data = await apiJson<ChAdvanced>('Companies House', `${CH}/advanced-search/companies?${q}`, { headers: chHeaders() })
  } catch (e) {
    // Advanced search answers "no matches" with a 404.
    if (e instanceof ApiError && e.status === 404) return []
    throw e
  }
  return (data.items ?? []).map((c) => {
    const x = emptyCandidate(c.company_name, 'companies_house')
    const a = c.registered_office_address ?? {}
    x.companyNumber = c.company_number
    x.address = [a.address_line_1, a.locality, a.postal_code].filter(Boolean).join(', ') || null
    x.postcode = normalisePostcode(a.postal_code)
    return x
  })
}

/* ------------------------------------------------------------ postcodes.io */

type PostcodeResult = {
  status: number
  result?: { postcode: string; latitude: number | null; longitude: number | null; admin_district?: string | null; region?: string | null }
}

/** Free, UK-only, no key. Returns null for an unknown postcode rather than throwing. */
export async function geocodePostcode(
  postcode: string,
): Promise<{ lat: number; lng: number; locality: string | null } | null> {
  const pc = normalisePostcode(postcode)
  if (!pc) return null
  try {
    const data = await apiJson<PostcodeResult>('postcodes.io', `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, {
      timeoutMs: 8000,
    })
    const r = data.result
    if (!r || r.latitude === null || r.longitude === null) return null
    return { lat: r.latitude, lng: r.longitude, locality: r.admin_district ?? r.region ?? null }
  } catch {
    return null
  }
}
