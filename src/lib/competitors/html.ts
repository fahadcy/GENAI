/**
 * Reading a web page without a DOM.
 *
 * Deliberately small and dependency-free: we need the title, description,
 * headings, visible copy, links, prices, JSON-LD and feed links of a
 * marketing page, not a browser. Regular expressions over HTML are wrong in
 * general and fine for this — the inputs are ordinary marketing sites, the
 * outputs are extracts a person reads, and a missed heading costs nothing.
 *
 * Pure: no I/O. Tested against fixtures in tests/competitors-*.test.ts.
 */

import type { PageExtract, SocialNetwork } from './types'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  euro: '€',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })
}

export function clean(s: string | null | undefined): string {
  return decodeEntities((s ?? '').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Every function here runs on pages a competitor controls, so all of them are
 * linear in the input. Two rules make that true: input is capped, and paired
 * tags are found by scanning with indexOf rather than with lazy regular
 * expressions, which go quadratic on unclosed tags.
 */
export const MAX_HTML = 400_000
export const capHtml = (html: string) => (html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html)

export type Element = { tag: string; attrs: string; inner: string; start: number; end: number }

/** `<tag …>inner</tag>` blocks, in order. Nested same-name tags are not descended into. */
export function elements(html: string, tags: readonly string[]): Element[] {
  const lower = html.toLowerCase()
  const open = new RegExp(`<(${tags.join('|')})\\b([^<>]*)>`, 'gi')
  const unclosed = new Set<string>()
  const out: Element[] = []
  let m: RegExpExecArray | null
  while ((m = open.exec(html))) {
    const tag = m[1].toLowerCase()
    if (unclosed.has(tag)) continue
    if (m[2].trimEnd().endsWith('/')) continue // <tag/> has no body
    const close = lower.indexOf(`</${tag}`, open.lastIndex)
    if (close === -1) {
      // No later close for this tag anywhere: never search for it again.
      unclosed.add(tag)
      continue
    }
    const closeEnd = html.indexOf('>', close)
    const end = closeEnd === -1 ? html.length : closeEnd + 1
    out.push({ tag, attrs: m[2], inner: html.slice(open.lastIndex, close), start: m.index, end })
    open.lastIndex = end
  }
  return out
}

function removeElements(html: string, tags: readonly string[]): string {
  const parts: string[] = []
  let at = 0
  for (const e of elements(html, tags)) {
    parts.push(html.slice(at, e.start), ' ')
    at = e.end
  }
  parts.push(html.slice(at))
  return parts.join('')
}

function removeComments(html: string): string {
  const parts: string[] = []
  let at = 0
  while (true) {
    const open = html.indexOf('<!--', at)
    if (open === -1) break
    const close = html.indexOf('-->', open + 4)
    parts.push(html.slice(at, open), ' ')
    if (close === -1) return parts.join('')
    at = close + 3
  }
  parts.push(html.slice(at))
  return parts.join('')
}

/** Remove the parts of a page nobody reads: comments, scripts, styles. */
export function stripNoise(html: string): string {
  return removeElements(removeComments(capHtml(html)), ['script', 'style', 'noscript', 'svg', 'template', 'iframe'])
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null
}

export function metaContent(html: string, key: string): string {
  const re = /<meta\b[^<>]*>/gi
  for (const m of capHtml(html).matchAll(re)) {
    const tag = m[0]
    const n = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase()
    if (n === key.toLowerCase()) return clean(attr(tag, 'content'))
  }
  return ''
}

export function titleOf(html: string): string {
  return clean(elements(stripNoise(html), ['title'])[0]?.inner)
}

export function headings(html: string, level: 1 | 2 | 3): string[] {
  const out: string[] = []
  for (const e of elements(stripNoise(html), [`h${level}`])) {
    const t = clean(e.inner)
    if (t && t.length <= 160 && !out.includes(t)) out.push(t)
  }
  return out
}

/** Visible text of the main content, roughly: header, nav and footer removed. */
export function visibleText(html: string): string {
  const body = removeElements(stripNoise(html), ['nav', 'header', 'footer', 'form']).replace(
    /<(br|\/p|\/div|\/li|\/h\d)\b[^<>]*>/gi,
    '\n',
  )
  return clean(body)
}

export type Link = { href: string; text: string }

export function links(html: string, base: string): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()
  for (const e of elements(capHtml(html), ['a'])) {
    const m = [e.start, e.attrs, e.inner] as const
    const href = attr(m[1], 'href')
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue
    let abs: string
    try {
      abs = new URL(href, base).toString()
    } catch {
      continue
    }
    const key = abs.replace(/#.*$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ href: key, text: clean(m[2]).slice(0, 120) })
  }
  return out
}

const CTA_WORDS =
  /\b(get|book|call|contact|request|start|try|buy|shop|order|download|claim|speak|talk|enquire|apply|join|sign up|subscribe|free|quote|consultation|demo)\b/i

/** Button-like phrases: short link or button texts that ask for an action. */
export function ctas(html: string): string[] {
  const out: string[] = []
  for (const e of elements(stripNoise(html), ['a', 'button'])) {
    const text = clean(e.inner)
    const cls = (attr(e.attrs, 'class') ?? '').toLowerCase()
    const buttonish = e.tag === 'button' || /btn|button|cta/.test(cls)
    if (text.length >= 3 && text.length <= 40 && (buttonish || CTA_WORDS.test(text)) && CTA_WORDS.test(text)) {
      if (!out.some((x) => x.toLowerCase() === text.toLowerCase())) out.push(text)
    }
  }
  return out.slice(0, 12)
}

/** "£1,499", "from £99 + VAT", "£25/month". Context kept so a price is not read without its terms. */
export function prices(text: string): string[] {
  const out: string[] = []
  const re =
    /((?:from|only|just|starting at|fixed fee of|fee of)\s+)?£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?:\s?(?:k|m))?(?:\s?(?:\+\s?vat|inc\.?\s?vat|ex\.?\s?vat|per (?:month|year|hour|day|week)|\/\s?(?:mo|month|yr|year|hr|hour)|pcm|a month|a year))?/gi
  for (const m of text.matchAll(re)) {
    const p = m[0].replace(/\s+/g, ' ').trim()
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p)
  }
  return out.slice(0, 15)
}

/** Trust signals worth quoting: years in business, accreditations, review counts, guarantees. */
export function trustSignals(text: string): string[] {
  const patterns: RegExp[] = [
    /\b(?:over |more than )?\d{1,3}\+?\s+years?(?:'|’)?\s+(?:of\s+)?(?:experience|in business|trading|helping)[^.!?\n]{0,40}/gi,
    /\b(?:established|founded|since|est\.?)\s+(?:in\s+)?(?:19|20)\d{2}\b/gi,
    /\b\d[\d,]{0,15}\+?\s+(?:happy |satisfied )?(?:clients|customers|businesses|companies|reviews|cases|projects)\b[^.!?\n]{0,30}/gi,
    /\b(?:ISO\s?\d{4,5}|ICO registered|FCA (?:regulated|authorised)|SRA regulated|ICAEW|ACCA|IPA|R3|Gas Safe|NICEIC|TrustMark|Which\? Trusted Trader|Cyber Essentials|Living Wage Employer|B Corp|Chartered)\b[^.!?\n]{0,40}/g,
    /\b(?:award[- ]winning|winner of|finalist|as seen (?:in|on))\b[^.!?\n]{0,50}/gi,
    /\b(?:money[- ]back|no win,? no fee|fixed[- ]fee|no hidden (?:fees|costs|charges)|free (?:initial )?consultation|price match|guarantee[d]?)\b[^.!?\n]{0,40}/gi,
  ]
  const out: string[] = []
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const s = m[0].replace(/\s+/g, ' ').trim().replace(/[,;:\-–]+$/, '')
      if (s.length >= 4 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
    }
  }
  return out.slice(0, 15)
}

/** Every JSON-LD block on the page, parsed; malformed blocks are skipped. */
export function jsonLd(html: string): unknown[] {
  const out: unknown[] = []
  for (const e of elements(capHtml(html), ['script'])) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(e.attrs)) continue
    try {
      const v = JSON.parse(e.inner.trim())
      if (Array.isArray(v)) out.push(...v)
      else if (v && typeof v === 'object' && Array.isArray((v as { '@graph'?: unknown[] })['@graph'])) {
        out.push(...(v as { '@graph': unknown[] })['@graph'])
      } else out.push(v)
    } catch {
      /* malformed JSON-LD is common; ignore it */
    }
  }
  return out
}

export type StructuredFacts = {
  types: string[]
  foundingYear: string | null
  areaServed: string[]
  priceRange: string | null
  sameAs: string[]
  offers: string[]
  name: string | null
}

export function structuredFacts(blocks: unknown[]): StructuredFacts {
  const facts: StructuredFacts = { types: [], foundingYear: null, areaServed: [], priceRange: null, sameAs: [], offers: [], name: null }
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 4) return
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1))
    const o = node as Record<string, unknown>
    const type = o['@type']
    for (const t of Array.isArray(type) ? type : type ? [type] : []) {
      if (typeof t === 'string' && !facts.types.includes(t)) facts.types.push(t)
    }
    if (!facts.name && typeof o.name === 'string' && /Organization|LocalBusiness|Corporation|Store|Service/i.test(String(type))) {
      facts.name = o.name
    }
    if (!facts.foundingYear && (typeof o.foundingDate === 'string' || typeof o.foundingDate === 'number')) {
      facts.foundingYear = String(o.foundingDate).slice(0, 4)
    }
    if (!facts.priceRange && typeof o.priceRange === 'string') facts.priceRange = o.priceRange
    const area = o.areaServed
    for (const a of Array.isArray(area) ? area : area ? [area] : []) {
      const name = typeof a === 'string' ? a : typeof (a as { name?: unknown })?.name === 'string' ? (a as { name: string }).name : null
      if (name && !facts.areaServed.includes(name)) facts.areaServed.push(name)
    }
    const same = o.sameAs
    for (const s of Array.isArray(same) ? same : same ? [same] : []) {
      if (typeof s === 'string' && !facts.sameAs.includes(s)) facts.sameAs.push(s)
    }
    const offers = o.offers ?? o.makesOffer
    for (const off of Array.isArray(offers) ? offers : offers ? [offers] : []) {
      if (!off || typeof off !== 'object') continue
      const x = off as Record<string, unknown>
      const label = [x.name, (x.itemOffered as { name?: unknown } | undefined)?.name].find((v) => typeof v === 'string') as string | undefined
      const price = x.price ?? (x.priceSpecification as { price?: unknown } | undefined)?.price
      const cur = (x.priceCurrency as string | undefined) ?? 'GBP'
      const s = [label, price !== undefined ? `${cur === 'GBP' ? '£' : cur + ' '}${price}` : null].filter(Boolean).join(' — ')
      if (s && !facts.offers.includes(s)) facts.offers.push(s)
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v, depth + 1)
  }
  visit(blocks, 0)
  facts.areaServed = facts.areaServed.slice(0, 10)
  facts.offers = facts.offers.slice(0, 10)
  return facts
}

/* ---------------------------------------------------------- social links */

const SOCIAL_PATTERNS: { network: SocialNetwork; re: RegExp }[] = [
  { network: 'linkedin', re: /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/([^/?#]+)/i },
  { network: 'facebook', re: /^https?:\/\/(www\.|m\.|business\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)(?:pg\/)?([^/?#]+)/i },
  { network: 'instagram', re: /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)([^/?#]+)/i },
  { network: 'x', re: /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\/(?!intent|share|home|search|hashtag)([^/?#]+)/i },
  { network: 'youtube', re: /^https?:\/\/(www\.|m\.)?youtube\.com\/((@[^/?#]+)|channel\/([^/?#]+)|c\/([^/?#]+)|user\/([^/?#]+))/i },
  { network: 'tiktok', re: /^https?:\/\/(www\.)?tiktok\.com\/(@[^/?#]+)/i },
  { network: 'pinterest', re: /^https?:\/\/([a-z]{2}\.|www\.)?pinterest\.(com|co\.uk)\/(?!pin\/)([^/?#]+)/i },
]

export function classifySocial(url: string): { network: SocialNetwork; url: string; handle: string } | null {
  for (const { network, re } of SOCIAL_PATTERNS) {
    const m = url.match(re)
    if (!m) continue
    const parts = m.slice(1).filter(Boolean)
    let handle = parts[parts.length - 1] ?? ''
    try {
      handle = decodeURIComponent(handle)
    } catch {
      /* a malformed escape is kept as written rather than failing the whole read */
    }
    handle = handle.replace(/\/$/, '')
    if (!handle || /^(home|login|sharer\.php|share)$/i.test(handle)) return null
    const canonical = url.replace(/[?#].*$/, '').replace(/\/$/, '')
    return { network, url: canonical, handle }
  }
  return null
}

export function socialLinks(urls: readonly string[]): { network: SocialNetwork; url: string; handle: string }[] {
  const out: { network: SocialNetwork; url: string; handle: string }[] = []
  for (const u of urls) {
    const s = classifySocial(u)
    if (s && !out.some((x) => x.network === s.network)) out.push(s)
  }
  return out
}

/* ------------------------------------------------------------- feeds */

export function feedLinks(html: string, base: string): string[] {
  const out: string[] = []
  for (const m of capHtml(html).matchAll(/<link\b[^<>]*>/gi)) {
    const tag = m[0]
    const type = (attr(tag, 'type') ?? '').toLowerCase()
    const rel = (attr(tag, 'rel') ?? '').toLowerCase()
    if (rel.includes('alternate') && /(rss|atom)\+xml/.test(type)) {
      const href = attr(tag, 'href')
      if (!href) continue
      try {
        const abs = new URL(href, base).toString()
        // Comment feeds tell us nothing about publishing cadence.
        if (!/comments/i.test(abs) && !out.includes(abs)) out.push(abs)
      } catch {
        /* skip */
      }
    }
  }
  return out
}

function tagText(xml: string, tag: string): string | null {
  const e = elements(xml, [tag.replace(':', '\\:')])[0]
  if (!e) return null
  return clean(e.inner.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'))
}

function toIso(s: string | null): string | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** RSS 2.0 and Atom, newest first. */
export function parseFeed(
  rawXml: string,
  base?: string,
): { title: string; url: string; publishedAt: string | null; summary: string | null }[] {
  const xml = capHtml(rawXml)
  // Feed links come from a site we do not control: resolve relative ones and
  // keep only http(s), so nothing like javascript: reaches a rendered link.
  const safe = (href: string | null): string | null => {
    if (!href) return null
    try {
      const u = base ? new URL(href, base) : new URL(href)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
    } catch {
      return null
    }
  }
  const items: { title: string; url: string; publishedAt: string | null; summary: string | null }[] = []
  for (const e of elements(xml, ['item'])) {
    const it = e.inner
    const title = tagText(it, 'title')
    const link = safe(tagText(it, 'link') ?? tagText(it, 'guid'))
    if (title && link) {
      items.push({
        title,
        url: link,
        publishedAt: toIso(tagText(it, 'pubDate') ?? tagText(it, 'dc:date')),
        summary: (tagText(it, 'description') ?? '').slice(0, 280) || null,
      })
    }
  }
  for (const e of elements(xml, ['entry'])) {
    const it = e.inner
    const title = tagText(it, 'title')
    const linkTags = [...it.matchAll(/<link\b[^<>]*>/gi)].map((m) => m[0])
    const linkTag = linkTags.find((t) => /rel\s*=\s*["']alternate["']/i.test(t)) ?? linkTags[0] ?? ''
    const link = safe(attr(linkTag, 'href'))
    if (title && link) {
      items.push({
        title,
        url: link,
        publishedAt: toIso(tagText(it, 'published') ?? tagText(it, 'updated')),
        summary: (tagText(it, 'summary') ?? tagText(it, 'content') ?? '').slice(0, 280) || null,
      })
    }
  }
  return items.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
}

/** <loc> entries of a sitemap, with lastmod. `index` is true for a sitemap index. */
export function parseSitemap(rawXml: string): { index: boolean; urls: { loc: string; lastmod: string | null }[] } {
  const xml = rawXml.length > 2_000_000 ? rawXml.slice(0, 2_000_000) : rawXml
  const index = /<sitemapindex\b/i.test(xml.slice(0, 5000))
  const urls: { loc: string; lastmod: string | null }[] = []
  for (const e of elements(xml, ['url', 'sitemap'])) {
    const loc = tagText(e.inner, 'loc')
    if (loc && /^https?:\/\//i.test(loc)) urls.push({ loc, lastmod: toIso(tagText(e.inner, 'lastmod')) })
  }
  return { index, urls }
}

/** Whether a URL looks like an article rather than a service page. */
export function looksLikePost(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase()
    return /\/(blog|news|insights?|articles?|resources|guides?|knowledge|advice|learn|updates|stories|posts?)\/[^/]+/.test(p) || /\/20\d{2}\/\d{2}\//.test(p)
  } catch {
    return false
  }
}

/* ----------------------------------------------------- page extraction */

export function pageKind(url: string, title: string): PageExtract['kind'] {
  let path = '/'
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    /* keep default */
  }
  if (path === '/' || path === '' || /^\/(index\.(html?|php))?$/.test(path)) return 'home'
  const hay = `${path} ${title.toLowerCase()}`
  if (/pric|fees|cost|plans|packages/.test(hay)) return 'pricing'
  if (/about|who-we-are|our-story|team/.test(hay)) return 'about'
  if (/contact|get-in-touch/.test(hay)) return 'contact'
  if (/service|solutions|what-we-do|products|offer/.test(hay)) return 'services'
  return 'other'
}

export function extractPage(html: string, url: string): PageExtract {
  const title = titleOf(html)
  const description = metaContent(html, 'description') || metaContent(html, 'og:description')
  const text = visibleText(html)
  return {
    url,
    kind: pageKind(url, title),
    title,
    description,
    h1: headings(html, 1).slice(0, 4),
    h2: headings(html, 2).slice(0, 14),
    excerpt: text.slice(0, 1200),
    ctas: ctas(html),
    prices: prices(text),
    wordCount: text ? text.split(/\s+/).length : 0,
  }
}

/** Internal links worth reading for positioning, in priority order. */
export function keyPages(all: readonly Link[], origin: string, max = 5): string[] {
  const host = new URL(origin).hostname.replace(/^www\./, '')
  const internal = all.filter((l) => {
    try {
      const u = new URL(l.href)
      return u.hostname.replace(/^www\./, '') === host && !/\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?)$/i.test(u.pathname)
    } catch {
      return false
    }
  })
  const rank = (l: Link) => {
    const hay = `${new URL(l.href).pathname} ${l.text}`.toLowerCase()
    if (/pric|fees|cost|plans|packages/.test(hay)) return 0
    if (/service|solutions|what-we-do|products/.test(hay)) return 1
    if (/about|who-we-are|why-us|our-story/.test(hay)) return 2
    if (/review|testimonial|case-stud/.test(hay)) return 3
    if (/blog|news|insight|resources|guides/.test(hay)) return 4
    return 9
  }
  const picked: string[] = []
  const seenKinds = new Set<number>()
  for (const l of [...internal].sort((a, b) => rank(a) - rank(b))) {
    const r = rank(l)
    if (r === 9) break
    if (seenKinds.has(r) && r !== 1) continue
    seenKinds.add(r)
    if (!picked.includes(l.href)) picked.push(l.href)
    if (picked.length >= max) break
  }
  return picked
}
