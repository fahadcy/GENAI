/**
 * Competitor intelligence — the pure parts.
 *
 * Profile rules ported from the prototype, discovery merging and scoring,
 * HTML and feed extraction, robots.txt, the SERP parsers, the analysis
 * arithmetic, the change diff and the generator context. No network, no
 * database.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyGuards,
  classifyByRules,
  normaliseDomain,
  normalisePostcode,
  parseSicCodes,
  postcodeIn,
} from '../src/lib/competitors/profile'
import {
  candidateKey,
  classifyCandidates,
  emptyCandidate,
  isExcludedDomain,
  isSelf,
  matchesTrade,
  mergeCandidates,
  normaliseName,
} from '../src/lib/competitors/discovery'
import {
  classifySocial,
  ctas,
  extractPage,
  feedLinks,
  jsonLd,
  keyPages,
  links,
  looksLikePost,
  parseFeed,
  parseSitemap,
  prices,
  structuredFacts,
  trustSignals,
} from '../src/lib/competitors/html'
import { isPrivateAddress, parseRobots, robotsAllows } from '../src/lib/competitors/sources/http'
import { parseDataForSeo, parseSerpApi, parseSerper } from '../src/lib/competitors/sources/serp'
import { brandFromTitle, candidatesFromSerp } from '../src/lib/competitors/discover'
import {
  buildLandscape,
  channelActivity,
  claimsOf,
  diffSnapshots,
  evidenceIndex,
  keepKnownEvidence,
  painPointsFrom,
  threatScore,
  topicOf,
} from '../src/lib/competitors/analysis'
import { simulatedCandidates, simulatedMarket, simulatedSnapshot, simulatedByDomain } from '../src/lib/competitors/simulator'
import { buildVocabulary, genericVocabulary, scoreTrade, verdictFrom, vocabularyFor } from '../src/lib/competitors/vocab'
import { brandTerms, buildContextBlock, competitorNegatives } from '../src/lib/competitors/context'
import { digest, templateAnalysis, templateLandscape } from '../src/lib/competitors/narrative'
import { researchLinks } from '../src/lib/competitors/links'
import type { CompanyProfile, LandscapeReport, PresenceSnapshot } from '../src/lib/competitors/types'

const NOW = new Date('2026-10-01T12:00:00Z')

const profile = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  companyName: 'Currie Young Ltd',
  companyNumber: '01234567',
  sicCodes: ['70221'],
  domain: 'currieyoung.co.uk',
  postcode: 'M2 3AW',
  locality: 'Manchester',
  lat: 53.479,
  lng: -2.245,
  businessType: 'insolvency practitioner',
  keywords: ['insolvency practitioner', 'company liquidation', 'business recovery', 'creditors voluntary liquidation'],
  scope: 'hybrid',
  confidence: 0.8,
  radiusKm: 25,
  source: 'rules',
  ...over,
})

/* ------------------------------------------------------------- profile */

describe('profile rules (ported from the prototype)', () => {
  test('the name beats a generic SIC code', () => {
    const g = classifyByRules('Northern Insolvency Practitioners Ltd', ['82990'])
    assert.equal(g.businessType, 'insolvency practitioner')
    assert.equal(g.scope, 'hybrid')
  })

  test('70221 is read as insolvency, not "financial management"', () => {
    assert.equal(classifyByRules('CY Group', ['70221']).businessType, 'insolvency practitioner')
  })

  test('a holding company is never given payment or food competitors', () => {
    const g = classifyByRules('Acme Holdings', ['64209'])
    assert.equal(g.businessType, 'corporate services / holding')
    assert.ok(!g.keywords.some((k) => /payment|restaurant/.test(k)))
  })

  test('a payments firm never competes with takeaways, whatever the model says', () => {
    const g = applyGuards(
      { businessType: 'payments', keywords: ['restaurant', 'takeaway', 'payment gateway'], scope: 'local', confidence: 0.9, source: 'ai' },
      'Swift Pay Ltd',
      ['64999'],
    )
    assert.ok(!g.keywords.includes('restaurant'))
    assert.ok(!g.keywords.includes('takeaway'))
    assert.ok(g.keywords.includes('payment gateway'))
    assert.equal(g.scope, 'national')
  })

  test('food terms survive only for a food business', () => {
    const food = applyGuards(
      { businessType: 'pizza', keywords: ['pizza', 'takeaway', 'meal delivery'], scope: 'local', confidence: 0.9, source: 'ai' },
      'Mario Pizza Ltd',
      ['56103'],
    )
    assert.ok(food.keywords.includes('pizza'))
    const notFood = applyGuards(
      { businessType: 'consultancy', keywords: ['cafe', 'consultancy', 'advice'], scope: 'local', confidence: 0.9, source: 'ai' },
      'Bright Advisory',
      [],
    )
    assert.ok(!notFood.keywords.includes('cafe'))
  })

  test('an empty model answer falls back to the rules', () => {
    const g = applyGuards({ businessType: 'x', keywords: [], scope: 'local', confidence: 0.9, source: 'ai' }, 'Leeds Plumbing Co', [])
    assert.equal(g.businessType, 'plumber')
  })

  test('SIC codes, domains and postcodes are normalised', () => {
    assert.deepEqual(parseSicCodes('70221 - Financial management, 82990'), ['70221', '82990'])
    assert.equal(normaliseDomain('https://www.Example.co.uk/about?x=1'), 'example.co.uk')
    assert.equal(normaliseDomain('not a domain'), null)
    assert.equal(normaliseDomain('http://10.0.0.1'), null)
    assert.equal(normalisePostcode('m23aw'), 'M2 3AW')
    assert.equal(normalisePostcode('SW1A1AA'), 'SW1A 1AA')
    assert.equal(normalisePostcode('nope'), null)
    assert.equal(postcodeIn('221B Baker Street, London NW1 6XE, UK'), 'NW1 6XE')
  })
})

/* ----------------------------------------------------------- discovery */

describe('discovery', () => {
  test('directories, social sites and government are not competitors', () => {
    for (const d of ['yell.com', 'uk.trustpilot.com', 'www.gov.uk', 'facebook.com', 'insolvency.gov.uk', 'checkatrade.com']) {
      assert.ok(isExcludedDomain(d.replace(/^www\./, '')), d)
    }
    assert.ok(!isExcludedDomain('begbies-traynorgroup.com'))
  })

  test('the same firm found three ways is one competitor', () => {
    const maps = emptyCandidate('Smith and Jones', 'places_local')
    maps.placeId = 'p1'
    maps.domain = 'smithjones.co.uk'
    maps.rating = 4.6
    maps.reviewCount = 80
    const serp = emptyCandidate('Fees | Smith & Jones', 'organic')
    serp.domain = 'www.smithjones.co.uk'
    serp.organicHits = 2
    serp.bestPosition = 3
    const reg = emptyCandidate('SMITH & JONES LIMITED', 'companies_house')
    reg.companyNumber = '0999'
    const merged = mergeCandidates([maps, serp, reg])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].domain, 'smithjones.co.uk')
    assert.equal(merged[0].organicHits, 2)
    assert.equal(merged[0].companyNumber, '0999')
    assert.deepEqual(new Set(merged[0].sources), new Set(['places_local', 'organic', 'companies_house']))
  })

  test('names normalise across punctuation and suffixes', () => {
    assert.equal(normaliseName('The Smith & Jones Group Ltd'), 'smith jones')
    assert.equal(candidateKey({ domain: null, placeId: null, companyNumber: null, name: 'Acme Ltd' }), 'n:acme')
  })

  test('the business itself is never its own competitor', () => {
    assert.ok(isSelf({ domain: 'currieyoung.co.uk', name: 'x', companyNumber: null }, profile()))
    assert.ok(isSelf({ domain: null, name: 'CURRIE YOUNG LIMITED', companyNumber: null }, profile()))
  })

  test('a trade match on name or Google category', () => {
    assert.ok(matchesTrade({ name: 'Northern Liquidators', types: [] }, ['company liquidation']))
    assert.ok(!matchesTrade({ name: 'Pizza Palace', types: ['restaurant'] }, ['company liquidation']))
  })

  test('search competitors are direct even with an unhelpful name', () => {
    const c = emptyCandidate('Begbies Traynor', 'organic')
    c.domain = 'begbies-traynorgroup.com'
    c.organicHits = 3
    c.bestPosition = 1
    const weak = emptyCandidate('Random Holdings', 'companies_house')
    weak.companyNumber = '1'
    const { direct, indirect } = classifyCandidates([c, weak], profile())
    assert.equal(direct[0].name, 'Begbies Traynor')
    assert.ok(direct[0].relevance > 20)
    assert.ok(direct[0].reasons.some((r) => r.includes('page one')))
    assert.equal(indirect[0].name, 'Random Holdings')
  })

  test('local competitors are marked local, with their distance', () => {
    const near = emptyCandidate('Manchester Insolvency Partners', 'places_local')
    near.lat = 53.48
    near.lng = -2.24
    const far = emptyCandidate('London Insolvency Partners', 'places_national')
    far.lat = 51.5
    far.lng = -0.12
    const { direct } = classifyCandidates([near, far], profile())
    const a = direct.find((x) => x.name.startsWith('Manchester'))!
    const b = direct.find((x) => x.name.startsWith('London'))!
    assert.equal(a.tier, 'local')
    assert.ok(a.distanceKm !== null && a.distanceKm < 1)
    assert.equal(b.tier, 'national')
    assert.ok(a.relevance > b.relevance)
  })

  test('dismissed businesses are not suggested again', () => {
    const c = emptyCandidate('Gone Ltd', 'manual')
    c.domain = 'gone.co.uk'
    const { direct } = classifyCandidates([c], profile(), { dismissed: new Set(['d:gone.co.uk']) })
    assert.equal(direct.length, 0)
  })

  test('brand names are read out of result titles', () => {
    assert.equal(brandFromTitle('Company Liquidation | Begbies Traynor', 'begbies-traynorgroup.com'), 'Begbies Traynor')
    assert.equal(brandFromTitle('Leading Insolvency Experts', 'frp-advisory.com'), 'Frp Advisory')
  })
})

/* ---------------------------------------------------------------- HTML */

const HOME = `<!doctype html><html><head>
<title>Company Liquidation Experts | Northgate &amp; Co</title>
<meta name="description" content="Fixed-fee liquidation from &pound;1,499 + VAT. Licensed insolvency practitioners.">
<link rel="alternate" type="application/rss+xml" href="/feed/">
<link rel="alternate" type="application/rss+xml" href="/comments/feed/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Northgate & Co","foundingDate":"1998-01-01","areaServed":[{"@type":"City","name":"Manchester"}],"sameAs":["https://www.linkedin.com/company/northgate-co/","https://www.youtube.com/@northgateco"],"makesOffer":{"@type":"Offer","name":"CVL","price":"1499","priceCurrency":"GBP"}}</script>
<script>var x = "<h1>not a heading</h1>"</script>
<style>h1{color:red}</style>
</head><body>
<nav><a href="/">Home</a><a href="/services/">Services</a><a href="/fees/">Our fees</a><a href="/about-us/">About</a><a href="/blog/">Blog</a></nav>
<h1>Close your company the right way</h1>
<h2>Why choose us</h2><h2>Our fees</h2>
<p>Over 25 years of experience helping directors. Rated 4.9 from 312 reviews. Free initial consultation.</p>
<p>Fees from £1,499 + VAT, or £95 per month.</p>
<a class="btn btn-primary" href="/contact">Book a free consultation</a>
<button>Call now</button>
<footer><a href="https://www.facebook.com/northgateco">Facebook</a><a href="https://twitter.com/intent/tweet?x">Share</a><a href="https://x.com/northgateco">X</a></footer>
</body></html>`

describe('page extraction', () => {
  const page = extractPage(HOME, 'https://northgate.co.uk/')
  test('title, description, headings — not from scripts', () => {
    assert.equal(page.title, 'Company Liquidation Experts | Northgate & Co')
    assert.ok(page.description.includes('£1,499'))
    assert.deepEqual(page.h1, ['Close your company the right way'])
    assert.equal(page.kind, 'home')
  })
  test('prices keep their terms', () => {
    assert.ok(page.prices.includes('from £1,499 + VAT'))
    assert.ok(page.prices.some((p) => p.includes('£95 per month')))
    assert.deepEqual(prices('No price here'), [])
  })
  test('calls to action', () => {
    assert.ok(page.ctas.includes('Book a free consultation'))
    assert.ok(ctas(HOME).includes('Call now'))
  })
  test('trust signals', () => {
    const t = trustSignals('Over 25 years of experience helping directors. Established in 1998. 312 reviews. Free initial consultation. ICAEW regulated.')
    assert.ok(t.some((s) => /25 years/.test(s)))
    assert.ok(t.some((s) => /1998/.test(s)))
    assert.ok(t.some((s) => /free initial consultation/i.test(s)))
    assert.ok(t.some((s) => /ICAEW/.test(s)))
  })
  test('JSON-LD facts and offers', () => {
    const f = structuredFacts(jsonLd(HOME))
    assert.equal(f.foundingYear, '1998')
    assert.deepEqual(f.areaServed, ['Manchester'])
    assert.ok(f.offers.some((o) => o.includes('£1499')))
    assert.ok(f.sameAs.length === 2)
  })
  test('social links, ignoring share buttons', () => {
    assert.equal(classifySocial('https://twitter.com/intent/tweet?x'), null)
    assert.equal(classifySocial('https://x.com/northgateco')?.handle, 'northgateco')
    assert.equal(classifySocial('https://www.youtube.com/@northgateco')?.handle, '@northgateco')
    assert.equal(classifySocial('https://www.linkedin.com/company/northgate-co/')?.network, 'linkedin')
  })
  test('feeds, without comment feeds', () => {
    assert.deepEqual(feedLinks(HOME, 'https://northgate.co.uk/'), ['https://northgate.co.uk/feed/'])
  })
  test('key pages in priority order', () => {
    const picked = keyPages(links(HOME, 'https://northgate.co.uk/'), 'https://northgate.co.uk/')
    assert.equal(picked[0], 'https://northgate.co.uk/fees/')
    assert.ok(picked.includes('https://northgate.co.uk/services/'))
    assert.ok(picked.includes('https://northgate.co.uk/about-us/'))
  })
})

describe('feeds and sitemaps', () => {
  test('RSS, newest first, CDATA unwrapped', () => {
    const rss = `<rss><channel>
      <item><title><![CDATA[How much does a CVL cost?]]></title><link>https://n.co.uk/blog/cvl-cost</link><pubDate>Mon, 01 Sep 2026 09:00:00 GMT</pubDate></item>
      <item><title>Older post</title><link>https://n.co.uk/blog/old</link><pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate></item>
    </channel></rss>`
    const items = parseFeed(rss)
    assert.equal(items[0].title, 'How much does a CVL cost?')
    assert.equal(items[0].publishedAt, '2026-09-01T09:00:00.000Z')
  })
  test('Atom', () => {
    const atom = `<feed><entry><title>Atom post</title><link rel="alternate" href="https://n.co.uk/a"/><updated>2026-08-01T00:00:00Z</updated></entry></feed>`
    assert.equal(parseFeed(atom)[0].url, 'https://n.co.uk/a')
  })
  test('sitemap index and urls', () => {
    const idx = parseSitemap('<sitemapindex><sitemap><loc>https://n.co.uk/post-sitemap.xml</loc></sitemap></sitemapindex>')
    assert.equal(idx.index, true)
    const set = parseSitemap('<urlset><url><loc>https://n.co.uk/blog/x</loc><lastmod>2026-09-01</lastmod></url></urlset>')
    assert.equal(set.urls[0].lastmod, '2026-09-01T00:00:00.000Z')
  })
  test('article URLs are told apart from service pages', () => {
    assert.ok(looksLikePost('https://n.co.uk/blog/how-to-close-a-company'))
    assert.ok(looksLikePost('https://n.co.uk/2026/09/news-item'))
    assert.ok(!looksLikePost('https://n.co.uk/services/cvl'))
  })
})

describe('robots.txt and address safety', () => {
  const rules = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/ok$\nCrawl-delay: 2\n\nUser-agent: BadBot\nDisallow: /\nSitemap: https://n.co.uk/sitemap.xml`)
  test('obeys the * group, longest match wins', () => {
    assert.ok(robotsAllows(rules, '/'))
    assert.ok(!robotsAllows(rules, '/private/x'))
    assert.ok(robotsAllows(rules, '/private/ok'))
    assert.equal(rules.crawlDelay, 2)
    assert.deepEqual(rules.sitemaps, ['https://n.co.uk/sitemap.xml'])
  })
  test('a group naming us takes priority', () => {
    const r = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: AureaBot\nDisallow: /')
    assert.ok(!robotsAllows(r, '/'))
  })
  test('private and metadata addresses are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) {
      assert.ok(isPrivateAddress(ip), ip)
    }
    assert.ok(!isPrivateAddress('8.8.8.8'))
    assert.ok(!isPrivateAddress('2606:4700::1111'))
  })
})

/* ----------------------------------------------------------------- SERP */

describe('SERP parsers', () => {
  test('DataForSEO: organic, paid with copy, local pack', () => {
    const r = parseDataForSeo('cvl', {
      tasks: [
        {
          result: [
            {
              items: [
                { type: 'paid', rank_group: 1, title: 'Fixed Fee CVL From £995', description: 'Licensed IPs. Free consultation.', url: 'https://cheapcvl.co.uk/x', domain: 'www.cheapcvl.co.uk', breadcrumb: 'cheapcvl.co.uk › cvl' },
                { type: 'organic', rank_group: 1, title: 'What is a CVL? | Begbies Traynor', url: 'https://www.begbies-traynorgroup.com/cvl', domain: 'www.begbies-traynorgroup.com', description: 'A guide' },
                { type: 'local_pack', title: 'Local IP', domain: 'localip.co.uk', rating: { value: 4.8, votes_count: 40 } },
              ],
            },
          ],
        },
      ],
    })
    assert.equal(r.ads[0].domain, 'cheapcvl.co.uk')
    assert.equal(r.ads[0].headline, 'Fixed Fee CVL From £995')
    assert.equal(r.organic[0].domain, 'begbies-traynorgroup.com')
    assert.equal(r.local[0].reviews, 40)
    const cands = candidatesFromSerp(r, 'cvl')
    assert.ok(cands.some((c) => c.paidHits === 1 && c.domain === 'cheapcvl.co.uk'))
    assert.ok(cands.some((c) => c.organicHits === 1 && c.name === 'Begbies Traynor'))
  })
  test('SerpApi: ads array and local results', () => {
    const r = parseSerpApi('x', {
      organic_results: [{ position: 2, title: 'A', link: 'https://a.co.uk/', snippet: 's' }],
      ads: [{ position: 1, title: 'Ad', description: 'D', link: 'https://b.co.uk/l', displayed_link: 'b.co.uk' }],
      local_results: { places: [{ title: 'P', rating: 4.1, reviews: 9, links: { website: 'https://p.co.uk' } }] },
    })
    assert.equal(r.organic[0].position, 2)
    assert.equal(r.ads[0].domain, 'b.co.uk')
    assert.equal(r.local[0].domain, 'p.co.uk')
  })
  test('Serper says it has no ads rather than claiming there are none', () => {
    const r = parseSerper('x', { organic: [{ title: 'A', link: 'https://a.co.uk' }] })
    assert.equal(r.adsSupported, false)
    assert.equal(r.organic[0].domain, 'a.co.uk')
  })
})

/* ------------------------------------------------------------ simulator */

describe('simulator', () => {
  test('is deterministic and fictional', () => {
    const a = simulatedMarket(profile())
    const b = simulatedMarket(profile())
    assert.deepEqual(a, b)
    assert.equal(a.length, 8)
    assert.ok(a.every((m) => m.domain.endsWith('.example')))
    assert.equal(new Set(a.map((m) => m.name)).size, 8)
  })
  test('simulated discovery classifies into a usable market', () => {
    const { direct } = classifyCandidates(simulatedCandidates(profile()), profile())
    assert.ok(direct.length >= 5)
    assert.ok(direct.every((d) => d.sources.includes('simulated')))
  })
  test('snapshots carry evidence and say they are simulated', () => {
    const sim = simulatedMarket(profile()).find((m) => m.archetype === 'ad_heavy')!
    const s = simulatedSnapshot(sim, profile(), NOW)
    assert.equal(s.simulated, true)
    assert.ok(s.ads.length > 0)
    assert.ok(s.reviews[0].samples.some((r) => r.rating <= 2))
    assert.equal(simulatedByDomain(profile(), sim.domain)?.name, sim.name)
    assert.equal(simulatedByDomain(profile(), 'real.co.uk'), null)
  })
})

/* ------------------------------------------------------------- analysis */

function market() {
  const p = profile()
  return simulatedMarket(p).map((m, i) => ({ id: `c${i}`, name: m.name, snapshot: simulatedSnapshot(m, p, NOW), archetype: m.archetype }))
}

describe('analysis', () => {
  const mk = market()
  const ad = mk.find((m) => m.archetype === 'ad_heavy')!
  const content = mk.find((m) => m.archetype === 'content_publisher')!
  const local = mk.find((m) => m.archetype === 'local_favourite')!

  test('channel activity follows the evidence', () => {
    const a = channelActivity(ad.snapshot, 4)
    assert.ok(a.search_ads >= 2)
    const c = channelActivity(content.snapshot, 4)
    assert.equal(c.blog, 3)
    assert.ok(c.seo >= 2)
    assert.equal(channelActivity(local.snapshot, 4).search_ads, 0)
  })

  test('claims are counted with the PPC & SEO taxonomy', () => {
    const price = mk.find((m) => m.archetype === 'price_leader')!
    assert.ok((claimsOf(price.snapshot).price ?? 0) > 0)
    assert.ok((claimsOf(ad.snapshot).risk_reversal ?? 0) > 0)
  })

  test('threat rises with search presence', () => {
    const t1 = threatScore(ad.snapshot, 70, channelActivity(ad.snapshot, 4))
    const t2 = threatScore(local.snapshot, 30, channelActivity(local.snapshot, 4))
    assert.ok(t1.score > t2.score)
    assert.ok(['low', 'medium', 'high'].includes(t1.level))
  })

  test('pain points come from low-star reviews only', () => {
    const pains = painPointsFrom(mk)
    assert.ok(pains.length > 0)
    assert.ok(pains.some((p) => p.theme === 'hidden_costs' || p.theme === 'pressure' || p.theme === 'communication'))
    const onlyPraise = painPointsFrom([
      { id: 'x', name: 'x', snapshot: { ...ad.snapshot, reviews: [{ source: 'google', rating: 5, count: 1, url: null, samples: [{ rating: 5, text: 'No hidden fees, great communication', publishedAt: null, source: 'Google' }] }] } },
    ])
    assert.equal(onlyPraise.length, 0)
  })

  test('topic families group differently worded titles', () => {
    assert.equal(topicOf('How much does a CVL cost in 2026?'), 'cost')
    assert.equal(topicOf('Liquidation fees explained'), 'cost')
    assert.equal(topicOf('CVL vs MVL: which is right for you?'), 'comparison')
    assert.equal(topicOf('Our office party'), null)
  })

  test('evidence ids resolve, and invented ones are dropped', () => {
    const idx = evidenceIndex(ad.snapshot)
    assert.ok(idx.has('ad:0'))
    assert.ok(idx.has('review:google:0'))
    const kept = keepKnownEvidence([{ text: 'x', evidence: ['ad:0', 'ad:99', 'made-up'] }], idx)
    assert.deepEqual(kept[0].evidence, ['ad:0'])
  })

  test('the landscape finds gaps and turns them into plays', () => {
    const self: PresenceSnapshot = {
      ...simulatedSnapshot(simulatedMarket(profile())[7], profile(), NOW),
      name: 'Currie Young',
      domain: 'currieyoung.co.uk',
      ads: [],
      organic: [],
      blog: { feedUrl: null, posts: [], postsLast90Days: 0 },
    }
    const report = buildLandscape({
      keywords: profile().keywords,
      businessType: 'insolvency practitioner',
      selfName: 'Currie Young',
      self,
      competitors: mk,
      now: NOW,
    })
    assert.equal(report.competitorIds.length, 8)
    assert.equal(report.simulated, true)
    assert.ok(report.claims.length > 5)
    assert.ok(report.search.length === 4)
    assert.ok(report.shareOfVoice.length > 1)
    const total = report.shareOfVoice.reduce((a, s) => a + s.share, 0)
    assert.ok(Math.abs(total - 1) < 1e-9)
    assert.ok(report.content.some((c) => !c.weCover && c.competitors.length >= 2))
    const kinds = new Set(report.plays.map((p) => p.kind))
    assert.ok(kinds.has('pain_point'), 'pain point play')
    assert.ok(kinds.has('content_gap'), 'content gap play')
    assert.ok(kinds.has('search_gap'), 'search gap play')
    for (const p of report.plays) {
      assert.ok(p.brief.title.length > 3)
      assert.ok(p.brief.objective.length > 20)
      assert.ok(p.destinations.length > 0)
      // A play never tells the writer to name a competitor.
      assert.ok(!Object.values(report.names).some((n) => p.brief.objective.includes(n)))
    }
    const ids = report.plays.map((p) => p.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('template narrative cites real evidence', () => {
    const channels = channelActivity(ad.snapshot, 4)
    const claims = claimsOf(ad.snapshot)
    const t = templateAnalysis(ad.snapshot, profile(), { claims, channels, threat: threatScore(ad.snapshot, 60, channels) })
    const idx = evidenceIndex(ad.snapshot)
    for (const i of [t.advantage, ...t.strengths, ...t.weaknesses]) for (const e of i.evidence) assert.ok(idx.has(e), e)
    assert.ok(t.weaknesses.length > 0)
    assert.ok(digest(ad.snapshot).includes('[ad:0]'))
  })
})

/* -------------------------------------------------------------- changes */

describe('change detection', () => {
  const p = profile()
  const base = simulatedSnapshot(simulatedMarket(p).find((m) => m.archetype === 'price_leader')!, p, NOW)
  test('nothing changed, nothing reported', () => {
    assert.deepEqual(diffSnapshots(base, base), [])
  })
  test('new ads, new prices, new posts, rating and headline changes', () => {
    const next: PresenceSnapshot = structuredClone(base)
    next.ads.push({ ...next.ads[0], headline: 'Now From £395', description: 'Price cut.' })
    next.offers = ['from £395 + VAT']
    next.blog.posts = [{ title: 'New post', url: 'https://x.example/new', publishedAt: NOW.toISOString(), summary: null }, ...next.blog.posts]
    next.reviews[0].rating = (base.reviews[0].rating ?? 4) - 0.3
    next.pages[0].h1 = ['A completely new headline']
    const kinds = diffSnapshots(base, next).map((c) => c.kind)
    for (const k of ['new_ads', 'price_change', 'new_posts', 'rating_change', 'positioning_change']) assert.ok(kinds.includes(k as never), k)
  })
})

/* -------------------------------------------------------------- context */

describe('generator context', () => {
  const mk = market()
  const base = buildLandscape({ keywords: profile().keywords, businessType: 'insolvency practitioner', selfName: 'Currie Young', self: null, competitors: mk, now: NOW })
  const report: LandscapeReport = { ...base, ...templateLandscape(base, 'Currie Young') }

  test('carries the rules and the gaps, never a competitor name', () => {
    const block = buildContextBlock(report, { businessType: 'insolvency practitioner', keywords: profile().keywords, selfName: 'Currie Young' })
    assert.ok(block.text.includes('Never name a competitor'))
    assert.ok(block.text.includes('CAP') || block.text.includes('comparative'))
    for (const n of Object.values(report.names)) assert.ok(!block.text.includes(n), n)
    assert.ok(block.brandNames.length >= 8)
  })

  test('brand terms skip generic trade words', () => {
    assert.deepEqual(brandTerms('Northgate Insolvency Partners Ltd', ['insolvency practitioner']), ['Northgate Insolvency Partners', 'Northgate'])
    assert.deepEqual(brandTerms('Insolvency Direct', ['insolvency practitioner']), ['Insolvency Direct'])
  })

  test('negatives use full brand names only', () => {
    const neg = competitorNegatives(['Northgate Insolvency Partners', 'Northgate', 'A'])
    assert.deepEqual(neg.map((n) => n.text), ['northgate insolvency partners'])
    assert.equal(neg[0].matchType, 'PHRASE')
  })

  test('research links are filtered to the UK', () => {
    const l = researchLinks({ name: 'Northgate & Co', domain: 'northgate.co.uk' })
    assert.ok(l.googleAdsTransparency.includes('region=GB'))
    assert.ok(l.metaAdLibrary.includes('country=GB'))
    assert.ok(l.metaAdLibrary.includes('Northgate%20%26%20Co'))
  })
})

/* ------------------------------------------------- review regressions */

import { assertPublicUrl, ipv6Groups } from '../src/lib/competitors/sources/http'
import { assertDataForSeoOk } from '../src/lib/competitors/sources/serp'
import { buildPlays } from '../src/lib/competitors/analysis'
import { clean, headings, metaContent, stripNoise, visibleText, MAX_HTML } from '../src/lib/competitors/html'

describe('review regressions', () => {
  test('IPv6 forms that embed a private IPv4 address are refused', () => {
    for (const ip of ['::ffff:a9fe:a9fe', '::ffff:7f00:1', '::7f00:1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::', 'fec0::1', 'fe80::1', '::']) {
      assert.ok(isPrivateAddress(ip), ip)
    }
    assert.ok(!isPrivateAddress('2002:0808:0808::'), '6to4 of a public address is public')
    assert.deepEqual(ipv6Groups('::ffff:10.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001])
    assert.throws(() => assertPublicUrl('http://[::ffff:169.254.169.254]/latest/meta-data'))
    assert.throws(() => assertPublicUrl('http://[::ffff:7f00:1]/'))
    assert.throws(() => assertPublicUrl('ftp://example.co.uk/'))
    assert.throws(() => assertPublicUrl('http://example.co.uk:8080/'))
    assert.doesNotThrow(() => assertPublicUrl('https://example.co.uk/'))
  })

  test('hostile pages are read in linear time', () => {
    const n = MAX_HTML
    const cases: [string, () => unknown][] = [
      ['clean <<<', () => clean('<'.repeat(n))],
      ['trust 1,1,', () => trustSignals('1,'.repeat(n / 2))],
      ['meta', () => metaContent('<meta '.repeat(n / 6), 'description')],
      ['unclosed a', () => links('<a href="/x">'.repeat(n / 13), 'https://x.co.uk/')],
      ['unclosed h2', () => headings('<h2>'.repeat(n / 4), 2)],
      ['unclosed comment/script', () => stripNoise('<!--<script>'.repeat(n / 12))],
      ['visible text', () => visibleText('<nav><div>'.repeat(n / 10))],
      ['feed', () => parseFeed('<item><title>'.repeat(n / 13))],
      ['sitemap', () => parseSitemap('<url><loc>'.repeat(n / 10))],
    ]
    for (const [name, fn] of cases) {
      const t = Date.now()
      fn()
      assert.ok(Date.now() - t < 1500, `${name} took ${Date.now() - t} ms`)
    }
  })

  test('SerpApi ads keep their domain when the display link is decorated', () => {
    const r = parseSerpApi('x', {
      ads: [{ position: 1, title: 'Ad', description: 'D', link: 'https://www.cheapcvl.co.uk/landing', displayed_link: 'https://www.cheapcvl.co.uk › cvl › fees' }],
    })
    assert.equal(r.ads[0].domain, 'cheapcvl.co.uk')
  })

  test('DataForSEO errors inside a 200 are errors', () => {
    assert.throws(() => assertDataForSeoOk({ status_code: 40200, status_message: 'Payment Required.' }), /40200/)
    assert.throws(() => assertDataForSeoOk({ status_code: 20000, tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }), /40501/)
    assert.doesNotThrow(() => assertDataForSeoOk({ status_code: 20000, tasks: [{ status_code: 20000 }] }))
  })

  test('a failed source is not reported as a change', () => {
    const p = profile()
    const prev = simulatedSnapshot(simulatedMarket(p).find((m) => m.archetype === 'ad_heavy')!, p, NOW)
    const next: PresenceSnapshot = {
      ...structuredClone(prev),
      ads: [],
      organic: [],
      pages: [],
      blog: { feedUrl: null, posts: [], postsLast90Days: 0 },
      sources: [
        { source: 'serp', status: 'error', provider: 'DataForSEO', note: 'timeout', items: 0, ms: 1 },
        { source: 'website', status: 'error', provider: 'Website reader', note: 'timeout', items: 0, ms: 1 },
      ],
    }
    assert.deepEqual(diffSnapshots(prev, next), [])
    const serper: PresenceSnapshot = { ...next, sources: [{ source: 'serp', status: 'ok', provider: 'Serper', note: '6 searches read. This provider does not return ads.', items: 3, ms: 1 }] }
    assert.ok(!diffSnapshots(prev, serper).some((c) => c.kind === 'ads_stopped'))
  })

  test('a malformed link does not break the site read', () => {
    assert.doesNotThrow(() => classifySocial('https://twitter.com/%E0%A4%A'))
  })

  test('merging gives the same key whatever order sources answer in', () => {
    const a = emptyCandidate('Smith', 'places_local')
    a.placeId = 'P1'
    const b = emptyCandidate('Smith', 'organic')
    b.placeId = 'P1'
    b.domain = 'smith.co.uk'
    assert.equal(mergeCandidates([a, b])[0].key, 'd:smith.co.uk')
    assert.equal(mergeCandidates([b, a])[0].key, 'd:smith.co.uk')
    assert.ok(candidateKey({ domain: null, placeId: null, companyNumber: null, name: 'x'.repeat(400) }).length <= 200)
  })

  test('holding and finance codes veto the company name', () => {
    assert.equal(classifyByRules('Burger Payments Ltd', ['64999']).businessType, 'financial services / payments')
    assert.equal(classifyByRules('Northgate Property Holdings Ltd', ['64209']).businessType, 'corporate services / holding')
    assert.notEqual(classifyByRules('Vehicle Recovery Ltd', []).businessType, 'insolvency practitioner')
    const g = applyGuards({ businessType: 'takeaway', keywords: ['takeaway'], scope: 'local', confidence: 0.9, source: 'ai' }, 'Burger Payments', ['64999'])
    assert.equal(g.businessType, 'financial services / payments')
  })

  test('no "you do not publish / rank" plays without reading your own presence', () => {
    const mk = market()
    const base = buildLandscape({ keywords: profile().keywords, businessType: 'x', selfName: 'Us', self: null, competitors: mk, now: NOW })
    assert.ok(!base.plays.some((p) => p.kind === 'content_gap' || p.kind === 'search_gap'))
    void buildPlays
  })

  test('robots.txt agent groups match the product token exactly', () => {
    const r = parseRobots('User-agent: a\nDisallow: /\n\nUser-agent: *\nAllow: /')
    assert.ok(robotsAllows(r, '/'))
  })

  test('feed links are resolved and limited to http(s)', () => {
    const atom = `<feed><entry><title>Rel</title><link href="/blog/rel"/></entry><entry><title>Bad</title><link href="javascript:alert(1)"/></entry></feed>`
    const items = parseFeed(atom, 'https://n.co.uk/feed')
    assert.deepEqual(items.map((i) => i.url), ['https://n.co.uk/blog/rel'])
  })
})

/* ---------------------------------------------------------- vocabulary */

describe('trade vocabulary', () => {
  const raw = (over: Partial<Parameters<typeof buildVocabulary>[2]> = {}) => ({
    strong: ['emergency plumber', 'boiler repair', 'gas safe registered'],
    supporting: ['power flushing', 'radiator'],
    adjacentTradeName: 'electrician',
    adjacent: ['consumer unit', 'rewiring'],
    adjacentNameHints: ['electrical'],
    searchTerms: ['emergency plumber near me'],
    ...over,
  })

  test('a term is matched on a word boundary, not as a substring', () => {
    // "iva" inside "private" is what put Deloitte in the competitor list.
    const v = vocabularyFor('insolvency practitioner', ['insolvency practitioner'])!
    const privateCo = scoreTrade(v, 'a private limited company', 'private', 'Private Co')
    assert.equal(privateCo.score, 0)
    const realIva = scoreTrade(v, 'we arrange an IVA for you', 'IVA', 'Debt Co')
    assert.ok(realIva.score > 0)
  })

  test('a dental profile does not pick up the insolvency vocabulary', () => {
    // Same bug, one layer up: "private dentist" selected the wrong trade.
    assert.equal(vocabularyFor('dental practice', ['private dentist', 'teeth whitening']), null)
    assert.ok(vocabularyFor('insolvency practitioner', ['company liquidation']) !== null)
  })

  test('generic words never become strong terms', () => {
    const v = buildVocabulary('x', 'X', raw({ strong: ['services', 'company', 'solutions', 'boiler repair', 'gas safe registered', 'power flushing'] }))
    assert.ok(v !== null)
    const terms = v!.strong.map((t) => t.term)
    assert.ok(!terms.includes('services'))
    assert.ok(!terms.includes('company'))
    assert.ok(terms.includes('boiler repair'))
  })

  test('a vocabulary too thin to judge anything is rejected', () => {
    assert.equal(buildVocabulary('x', 'X', raw({ strong: ['boiler repair'] })), null)
    assert.equal(buildVocabulary('x', 'X', raw({ strong: ['service', 'solutions', 'company'] })), null)
  })

  test('phrases outscore single words, because they match by accident less', () => {
    const v = buildVocabulary('x', 'X', raw())!
    const phrase = v.strong.find((t) => t.term === 'emergency plumber')!
    const single = buildVocabulary('y', 'Y', raw({ strong: ['plumbing', 'boiler repair', 'gas safe registered'] }))!
      .strong.find((t) => t.term === 'plumbing')!
    assert.ok(phrase.weight > single.weight)
  })

  test('short acronyms survive, short noise does not', () => {
    const v = buildVocabulary('x', 'X', raw({ supporting: ['cva', 'mvl', 'a', 'of'] }))!
    const terms = v.supporting.map((t) => t.term)
    assert.ok(terms.includes('cva'))
    assert.ok(terms.includes('mvl'))
    assert.ok(!terms.includes('of'))
  })

  test('a trade with no curated list still judges its own kind correctly', () => {
    const v = genericVocabulary('dental practice', ['private dentist', 'dental implants'])
    const dentist = scoreTrade(v, 'Private dentist offering dental implants and whitening.', 'Private dentist', 'Smile Co')
    const plumber = scoreTrade(v, 'Emergency plumber, boiler repair, Gas Safe.', 'Emergency plumber', 'Pipes Ltd')
    assert.equal(verdictFrom(dentist), 'match')
    assert.equal(verdictFrom(plumber), 'unrelated')
  })
})
