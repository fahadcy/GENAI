import 'server-only'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { env } from '@/lib/env'

/**
 * Outbound HTTP for competitor intelligence.
 *
 * Two kinds of call go through here. API calls to a provider we chose
 * (Companies House, Google, DataForSEO…) and reads of a competitor's public
 * website. The second kind is fetching a URL that came from outside — a search
 * result, a Maps listing, something a person typed — so it gets the full
 * treatment:
 *
 *  - Server-side request forgery. A "competitor" at http://169.254.169.254/ or
 *    a domain that resolves to 10.0.0.5 would have the server read its own
 *    cloud metadata or internal network. Every hop, including redirects, is
 *    resolved and refused if it lands on a private, loopback or link-local
 *    address.
 *  - robots.txt is obeyed, per host, before any page is read.
 *  - The reader identifies itself and says where to complain.
 *  - Size and time are capped, so one slow or enormous site cannot hold a scan.
 */

export class FetchRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchRefused'
  }
}

export function userAgent(): string {
  const app = (() => {
    try {
      return env().APP_URL
    } catch {
      return 'http://localhost:3000'
    }
  })()
  return `GenAIBot/1.0 (+${app}; competitor research, respects robots.txt)`
}

/* ------------------------------------------------------------------ SSRF */

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** Eight 16-bit groups from any textual IPv6 form, including an embedded dotted IPv4 tail. */
export function ipv6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const dotted = x.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const o = dotted.slice(1).map(Number)
    if (o.some((n) => n > 255)) return null
    x = x.slice(0, -dotted[0].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = x.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const all = [...head, ...Array(fill).fill('0'), ...tail]
  if (all.length !== 8) return null
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return groups.some((g) => Number.isNaN(g)) ? null : groups
}

/**
 * True for addresses a public website can never legitimately resolve to.
 * IPv6 forms that embed an IPv4 address — mapped (::ffff:a.b.c.d, in either
 * notation), compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4
 * (2002::/16) — are unwrapped and judged as the IPv4 address they carry.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ''))
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return ipv4Private(a, b)
  }
  if (v !== 6) return true
  const g = ipv6Groups(ip)
  if (!g) return true
  const v4 = (hi: number, lo: number) => ipv4Private(hi >> 8, hi & 0xff) || (hi === 0 && lo === 0)
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (g.every((x) => x === 0)) return true // ::
  if (zeros(7) && g[7] === 1) return true // ::1
  if (zeros(5) && g[5] === 0xffff) return v4(g[6], g[7]) // IPv4-mapped
  if (zeros(6)) return v4(g[6], g[7]) // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]) // NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]) // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true // site-local fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  return false
}

/** Refuses URLs that are not plain public http(s) on a standard port. Address checks happen at connect time. */
export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FetchRefused(`Not a valid web address: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchRefused('Only http and https are read.')
  if (url.username || url.password) throw new FetchRefused('Addresses with credentials are not read.')
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchRefused('Only standard web ports are read.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.example')) {
    throw new FetchRefused(`Not a public host: ${host}`)
  }
  if (isIP(host) && isPrivateAddress(host)) throw new FetchRefused(`Private address refused: ${host}`)
  return url
}

/**
 * A DNS lookup that refuses private answers. Passed to the socket itself, so
 * the address checked is the address connected to — a hostname that resolves
 * to something public for the check and something private for the request
 * (DNS rebinding) is refused at the second lookup too.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4)
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[]
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new FetchRefused(`${hostname} resolves to a private address`) as NodeJS.ErrnoException, '', 4)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

/* ------------------------------------------------------------ public fetch */

export type PublicResponse = { url: string; status: number; contentType: string; text: string }

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer }

function requestOnce(url: URL, opts: { timeoutMs: number; maxBytes: number; accept: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: isIP(host) ? undefined : guardedLookup,
        servername: isIP(host) ? undefined : host,
        timeout: opts.timeoutMs,
        headers: {
          'user-agent': userAgent(),
          accept: opts.accept,
          'accept-language': 'en-GB,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
        const stream =
          enc === 'gzip' || enc === 'x-gzip'
            ? res.pipe(createGunzip())
            : enc === 'br'
              ? res.pipe(createBrotliDecompress())
              : enc === 'deflate'
                ? res.pipe(createInflate())
                : res
        const chunks: Buffer[] = []
        let total = 0
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })
        }
        stream.on('data', (c: Buffer) => {
          if (done) return
          const room = opts.maxBytes - total
          chunks.push(room < c.length ? c.subarray(0, room) : c)
          total += Math.min(c.length, room)
          if (total >= opts.maxBytes) {
            finish()
            req.destroy()
          }
        })
        stream.on('end', finish)
        stream.on('error', (e) => (done ? undefined : reject(e)))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${opts.timeoutMs} ms`)))
    req.on('error', (e) => reject(e instanceof FetchRefused ? e : (e as Error).message.includes('private address') ? new FetchRefused(e.message) : e))
    req.end()
  })
}

/**
 * GET a public page. Follows up to four redirects, re-checking each hop.
 * Returns null on 4xx/5xx rather than throwing: a missing /about page is
 * normal, not an error. Bodies are capped (400KB by default) because the
 * extractors run regular expressions over them.
 */
export async function fetchPublic(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<PublicResponse | null> {
  const r = await fetchPublicStatus(raw, opts)
  return r && r.status >= 200 && r.status < 300 ? r : null
}

/** As fetchPublic, but returns error statuses too (robots.txt needs to tell 404 from 503). */
export async function fetchPublicStatus(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<PublicResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 9000
  const maxBytes = opts.maxBytes ?? 400_000
  const accept = opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5'
  let current = raw
  for (let hop = 0; hop < 5; hop++) {
    const url = assertPublicUrl(current)
    const res = await requestOnce(url, { timeoutMs, maxBytes, accept })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location
      if (!location) return null
      current = new URL(location, url).toString()
      continue
    }
    return {
      url: url.toString(),
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      text: new TextDecoder('utf-8', { fatal: false }).decode(res.body),
    }
  }
  return null
}

/* --------------------------------------------------------------- robots */

const robotsCache = new Map<string, { rules: RobotsRules; at: number }>()

export type RobotsRules = {
  allow: string[]
  disallow: string[]
  sitemaps: string[]
  crawlDelay: number | null
  /** robots.txt could not be fetched at all (network failure or 5xx). */
  unreachable?: boolean
}

/**
 * Parse the groups that apply to us: a `GenAIBot` group if there is one,
 * otherwise `*`. Longest match wins, Allow beats Disallow on a tie (RFC 9309).
 */
export function parseRobots(text: string, agent = 'genaibot'): RobotsRules {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim())
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay: number | null }
  const groups: Group[] = []
  const sitemaps: string[] = []
  let cur: Group | null = null
  let lastWasAgent = false
  for (const line of lines) {
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [], delay: null }
        groups.push(cur)
      }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (field === 'allow' && value) cur.allow.push(value)
    else if (field === 'disallow' && value) cur.disallow.push(value)
    else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n)) cur.delay = n
    }
  }
  // RFC 9309: match the product token exactly, case-insensitively.
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && a === agent))
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'))
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    sitemaps,
    crawlDelay: chosen.find((g) => g.delay !== null)?.delay ?? null,
  }
}

function patternLength(p: string): number {
  return p.replace(/\*/g, '').replace(/\$$/, '').length
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path)
}

export function robotsAllows(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null
  for (const p of rules.disallow) {
    if (patternMatches(p, pathWithQuery)) {
      const len = patternLength(p)
      if (!best || len > best.len) best = { len, allow: false }
    }
  }
  for (const p of rules.allow) {
    if (patternMatches(p, pathWithQuery)) {
      const len = patternLength(p)
      if (!best || len >= best.len) best = { len, allow: true }
    }
  }
  return best ? best.allow : true
}

export async function robotsFor(origin: string): Promise<RobotsRules> {
  const hit = robotsCache.get(origin)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.rules
  const allowAll: RobotsRules = { allow: [], disallow: [], sitemaps: [], crawlDelay: null }
  const disallowAll: RobotsRules = { allow: [], disallow: ['/'], sitemaps: [], crawlDelay: null, unreachable: true }
  let rules: RobotsRules
  try {
    const res = await fetchPublicStatus(`${origin}/robots.txt`, { timeoutMs: 6000, maxBytes: 300_000, accept: 'text/plain' })
    // RFC 9309: 4xx means no rules; 5xx or unreachable means assume everything is disallowed.
    if (!res) rules = disallowAll
    else if (res.status >= 200 && res.status < 300) rules = parseRobots(res.text)
    else if (res.status >= 400 && res.status < 500) rules = allowAll
    else rules = disallowAll
  } catch (e) {
    if (e instanceof FetchRefused) throw e
    rules = disallowAll
  }
  robotsCache.set(origin, { rules, at: Date.now() })
  return rules
}

/* -------------------------------------------------------------- API calls */

export class ApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider}: ${message}`)
    this.name = 'ApiError'
  }
}

/** JSON call to a provider API. Throws ApiError with the provider's own message. */
export async function apiJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } | string; message?: string } | null)?.message ??
      (typeof (body as { error?: unknown })?.error === 'string'
        ? ((body as { error: string }).error as string)
        : (body as { error?: { message?: string } })?.error?.message) ??
      text.slice(0, 200) ??
      res.statusText
    throw new ApiError(provider, res.status, `${res.status} ${msg}`)
  }
  return body as T
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
