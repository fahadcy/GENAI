import 'server-only'
import {
  extractPage,
  feedLinks,
  jsonLd,
  keyPages,
  links,
  looksLikePost,
  parseFeed,
  parseSitemap,
  socialLinks,
  structuredFacts,
  trustSignals,
  visibleText,
  type StructuredFacts,
} from '../html'
import type { BlogPost, PageExtract, SocialNetwork } from '../types'
import { fetchPublic, robotsAllows, robotsFor, sleep, type RobotsRules } from './http'

/**
 * Reads a business's own website the way a careful person would: home page
 * first, then the handful of pages that say what they sell and for how much,
 * then the blog feed. Obeys robots.txt and its crawl delay, waits between
 * requests, and stops at six pages.
 *
 * Stores extracts, never whole pages: the analysis needs what a competitor
 * says about itself, and keeping copies of other people's sites would be both
 * unnecessary and a copyright question.
 */

export type WebsiteRead = {
  status: 'ok' | 'blocked' | 'unreachable'
  note: string
  pages: PageExtract[]
  structured: StructuredFacts
  trustSignals: string[]
  socials: { network: SocialNetwork; url: string; handle: string }[]
  feedUrl: string | null
  posts: BlogPost[]
  ms: number
}

const EMPTY_FACTS: StructuredFacts = {
  types: [],
  foundingYear: null,
  areaServed: [],
  priceRange: null,
  sameAs: [],
  offers: [],
  name: null,
}

function pathOf(url: string): string {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}

export async function readWebsite(domain: string, opts: { maxPages?: number } = {}): Promise<WebsiteRead> {
  const started = Date.now()
  const maxPages = Math.max(1, Math.min(8, opts.maxPages ?? 6))
  const origin = `https://${domain}`
  const blank = (status: WebsiteRead['status'], note: string): WebsiteRead => ({
    status,
    note,
    pages: [],
    structured: EMPTY_FACTS,
    trustSignals: [],
    socials: [],
    feedUrl: null,
    posts: [],
    ms: Date.now() - started,
  })

  let robots: RobotsRules
  try {
    robots = await robotsFor(origin)
  } catch (e) {
    return blank('unreachable', (e as Error).message)
  }
  if (robots.unreachable) return blank('unreachable', 'The site could not be reached (robots.txt did not load).')
  if (!robotsAllows(robots, '/')) return blank('blocked', 'robots.txt asks automated readers not to read this site.')
  const delayMs = Math.min(5000, Math.max(400, (robots.crawlDelay ?? 0) * 1000))

  let home
  try {
    home = await fetchPublic(origin)
    if (!home) home = await fetchPublic(`http://${domain}`)
  } catch (e) {
    return blank('unreachable', (e as Error).message)
  }
  if (!home) return blank('unreachable', 'The home page did not load.')
  if (!/html/i.test(home.contentType) && !/<html/i.test(home.text.slice(0, 2000))) {
    return blank('unreachable', 'The home page is not HTML.')
  }

  // A redirect to another host (example.co.uk → www.example.com) means that
  // host's robots.txt is the one that applies to everything we read next.
  const finalOrigin = new URL(home.url).origin
  if (finalOrigin !== origin) {
    try {
      robots = await robotsFor(finalOrigin)
    } catch (e) {
      return blank('unreachable', (e as Error).message)
    }
    if (robots.unreachable || !robotsAllows(robots, pathOf(home.url))) {
      return blank('blocked', `robots.txt on ${new URL(home.url).hostname} asks automated readers not to read this site.`)
    }
  }

  const pages: PageExtract[] = [extractPage(home.text, home.url)]
  const allLinks = links(home.text, home.url)
  const ld = jsonLd(home.text)
  const texts = [visibleText(home.text)]

  for (const url of keyPages(allLinks, home.url, maxPages - 1)) {
    if (!robotsAllows(robots, pathOf(url))) continue
    await sleep(delayMs)
    try {
      const res = await fetchPublic(url)
      if (!res || !/html/i.test(res.contentType)) continue
      pages.push(extractPage(res.text, res.url))
      ld.push(...jsonLd(res.text))
      texts.push(visibleText(res.text))
    } catch {
      /* one bad page does not spoil the read */
    }
  }

  const structured = structuredFacts(ld)
  const socials = socialLinks([...structured.sameAs, ...allLinks.map((l) => l.href)])
  const signals = trustSignals(texts.join('\n'))

  const blog = await readBlog(home.text, home.url, robots, delayMs, allLinks.map((l) => l.href))

  return {
    status: 'ok',
    note: `Read ${pages.length} page${pages.length === 1 ? '' : 's'}${blog.posts.length ? ` and ${blog.posts.length} recent posts` : ''}.`,
    pages,
    structured,
    trustSignals: signals,
    socials,
    feedUrl: blog.feedUrl,
    posts: blog.posts,
    ms: Date.now() - started,
  }
}

/**
 * Recent posts. Feed first (it has dates); otherwise the sitemap, filtered to
 * article-looking URLs; otherwise article links on the home page, undated.
 */
async function readBlog(
  html: string,
  base: string,
  robots: RobotsRules,
  delayMs: number,
  homeLinks: string[],
): Promise<{ feedUrl: string | null; posts: BlogPost[] }> {
  const origin = new URL(base).origin
  const candidates = [...feedLinks(html, base), `${origin}/feed`, `${origin}/blog/feed`, `${origin}/rss.xml`, `${origin}/feed.xml`]
  for (const feedUrl of Array.from(new Set(candidates)).slice(0, 4)) {
    if (!robotsAllows(robots, pathOf(feedUrl))) continue
    try {
      await sleep(delayMs)
      const res = await fetchPublic(feedUrl, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml', maxBytes: 800_000 })
      if (!res || !/<(rss|feed|rdf:RDF)\b/i.test(res.text.slice(0, 3000))) continue
      const posts = parseFeed(res.text, res.url).slice(0, 20)
      if (posts.length) return { feedUrl: res.url, posts }
    } catch {
      /* try the next */
    }
  }

  const sitemaps = robots.sitemaps.length ? robots.sitemaps.slice(0, 2) : [`${origin}/sitemap.xml`]
  for (const sm of sitemaps) {
    try {
      await sleep(delayMs)
      const res = await fetchPublic(sm, { accept: 'application/xml,text/xml', maxBytes: 2_000_000 })
      if (!res) continue
      let parsed = parseSitemap(res.text)
      if (parsed.index) {
        const child =
          parsed.urls.find((u) => /post|blog|news|article|insight/i.test(u.loc)) ?? parsed.urls[0]
        if (!child) continue
        await sleep(delayMs)
        const sub = await fetchPublic(child.loc, { accept: 'application/xml,text/xml', maxBytes: 2_000_000 })
        if (!sub) continue
        parsed = parseSitemap(sub.text)
      }
      const posts = parsed.urls
        .filter((u) => looksLikePost(u.loc))
        .sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''))
        .slice(0, 20)
        .map((u) => ({ title: titleFromSlug(u.loc), url: u.loc, publishedAt: u.lastmod, summary: null }))
      if (posts.length) return { feedUrl: null, posts }
    } catch {
      /* fall through */
    }
  }

  const fromHome = homeLinks
    .filter(looksLikePost)
    .slice(0, 10)
    .map((u) => ({ title: titleFromSlug(u), url: u, publishedAt: null, summary: null }))
  return { feedUrl: null, posts: fromHome }
}

/** "/blog/how-much-does-a-cvl-cost/" → "How much does a cvl cost". */
export function titleFromSlug(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const words = decodeURIComponent(seg).replace(/\.(html?|php)$/, '').replace(/[-_]+/g, ' ').trim()
    return words ? words[0].toUpperCase() + words.slice(1) : url
  } catch {
    return url
  }
}
