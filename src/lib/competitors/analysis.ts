/**
 * The analysis, the arithmetic half.
 *
 * Everything here is computed from what was observed, with no model:
 * which channels each competitor is active on, which promises they make, who
 * owns which search, what customers complain about, which topics everyone
 * else writes about and you do not — and the plays that follow. A model only
 * writes the narrative on top (positioning, advantage, how to win), and has to
 * cite the evidence ids this module hands it.
 *
 * Same principle as the copilot and the SERP Twin engines: a recommendation a
 * marketer can check beats one they have to trust. Pure: no I/O.
 */

import { ALL_CLAIMS, CLAIM_LABEL, extractClaims, type Claim } from '@/lib/serptwin/claims'
import type {
  Change,
  ChannelActivity,
  ChannelKey,
  ClaimRow,
  ContentTopic,
  Insight,
  LandscapeReport,
  PainPoint,
  Play,
  PlayDestination,
  PresenceSnapshot,
  SearchRow,
} from './types'

/* ------------------------------------------------------------ evidence ids */

/**
 * Stable ids for the items in a snapshot. Used in the digest given to the
 * model, in the insights it returns, and in the UI that resolves them.
 */
export function evidenceIndex(s: PresenceSnapshot): Map<string, { label: string; text: string; url: string | null }> {
  const m = new Map<string, { label: string; text: string; url: string | null }>()
  s.pages.forEach((p, i) =>
    m.set(`page:${i}`, {
      label: `${p.kind === 'home' ? 'Home page' : `${p.kind[0].toUpperCase()}${p.kind.slice(1)} page`}`,
      text: [p.h1[0] ?? p.title, p.description].filter(Boolean).join(' — '),
      url: p.url,
    }),
  )
  s.offers.forEach((o, i) => m.set(`price:${i}`, { label: 'Price', text: o, url: s.pages.find((p) => p.prices.includes(o))?.url ?? null }))
  s.trustSignals.forEach((t, i) => m.set(`signal:${i}`, { label: 'Trust signal', text: t, url: null }))
  s.ads.forEach((a, i) =>
    m.set(`ad:${i}`, { label: `Search ad on “${a.keyword}”`, text: `${a.headline} — ${a.description}`, url: a.finalUrl }),
  )
  s.organic.forEach((o, i) =>
    m.set(`organic:${i}`, { label: `Ranks #${o.position} for “${o.keyword}”`, text: o.title, url: o.url }),
  )
  s.blog.posts.forEach((p, i) =>
    m.set(`post:${i}`, { label: `Blog post${p.publishedAt ? ` (${p.publishedAt.slice(0, 10)})` : ''}`, text: p.title, url: p.url }),
  )
  s.reviews.forEach((r) =>
    r.samples.forEach((x, i) =>
      m.set(`review:${r.source}:${i}`, { label: `${x.rating}★ ${r.source === 'google' ? 'Google' : 'Trustpilot'} review`, text: x.text, url: r.url }),
    ),
  )
  s.social.forEach((x, i) =>
    m.set(`social:${i}`, {
      label: `${x.network}`,
      text: x.followers !== null ? `${x.followers.toLocaleString('en-GB')} followers` : 'Profile linked from their site',
      url: x.url,
    }),
  )
  s.news.forEach((n, i) => m.set(`news:${i}`, { label: `News: ${n.source}`, text: n.title, url: n.url }))
  return m
}

/** Drop evidence ids the snapshot does not contain. A model citing `ad:9` when there are two ads is making it up. */
export function keepKnownEvidence(insights: Insight[], index: Map<string, unknown>): Insight[] {
  return insights
    .map((i) => ({ text: i.text.trim(), evidence: Array.from(new Set(i.evidence.filter((e) => index.has(e)))).slice(0, 6) }))
    .filter((i) => i.text.length > 0)
}

/* --------------------------------------------------------------- channels */

const clamp3 = (n: number) => Math.max(0, Math.min(3, Math.round(n))) as 0 | 1 | 2 | 3

export function channelActivity(s: PresenceSnapshot, keywordCount: number): ChannelActivity {
  const words = s.pages.reduce((a, p) => a + p.wordCount, 0)
  const dated = s.blog.posts.some((p) => p.publishedAt)
  const posts90 = s.blog.postsLast90Days
  const kw = Math.max(1, keywordCount)
  const reviewCount = s.reviews.reduce((a, r) => a + r.count, 0)
  const followers = s.social.reduce((a, x) => a + (x.followers ?? 0), 0)
  const yt = s.social.find((x) => x.network === 'youtube')
  return {
    website: s.pages.length === 0 ? 0 : words > 2500 || s.pages.length >= 4 ? 3 : words > 800 ? 2 : 1,
    blog: dated ? clamp3(posts90 === 0 ? 0 : posts90 <= 2 ? 1 : posts90 <= 8 ? 2 : 3) : s.blog.posts.length ? 1 : 0,
    search_ads: clamp3(s.ads.length === 0 ? 0 : s.ads.length / kw >= 0.6 ? 3 : s.ads.length / kw >= 0.3 ? 2 : 1),
    seo: clamp3(
      s.organic.length === 0
        ? 0
        : s.organic.length / kw >= 0.6 && Math.min(...s.organic.map((o) => o.position)) <= 3
          ? 3
          : s.organic.length / kw >= 0.3
            ? 2
            : 1,
    ),
    reviews: clamp3(reviewCount === 0 ? 0 : reviewCount < 25 ? 1 : reviewCount < 150 ? 2 : 3),
    social: clamp3(s.social.length === 0 ? 0 : followers > 5000 || s.social.length >= 4 ? 3 : followers > 800 || s.social.length >= 2 ? 2 : 1),
    video: clamp3(!yt ? 0 : yt.recent.length === 0 ? 1 : yt.recent.some((v) => v.publishedAt && Date.parse(v.publishedAt) > Date.parse(s.collectedAt) - 90 * 86_400_000) ? 3 : 2),
    pr: clamp3(s.news.length === 0 ? 0 : s.news.length < 3 ? 1 : s.news.length < 6 ? 2 : 3),
  }
}

/* ------------------------------------------------------------------ claims */

/**
 * Which promises a business makes, counted across its ads, its headings and
 * its trust signals. One sentence can carry several claims. Uses the PPC &
 * SEO claim taxonomy so "speed" means the same thing in both modules.
 */
export function claimsOf(s: PresenceSnapshot): Partial<Record<Claim, number>> {
  const out: Partial<Record<Claim, number>> = {}
  const add = (text: string) => {
    for (const c of extractClaims(text)) out[c] = (out[c] ?? 0) + 1
  }
  for (const a of s.ads) {
    add(a.headline)
    add(a.description)
  }
  for (const p of s.pages) {
    for (const h of [p.title, p.description, ...p.h1, ...p.h2.slice(0, 6)]) if (h) add(h)
    for (const c of p.ctas) add(c)
  }
  for (const t of s.trustSignals) add(t)
  for (const o of s.offers) add(o)
  return out
}

/* ------------------------------------------------------------------ threat */

export function threatScore(
  s: PresenceSnapshot,
  relevance: number,
  channels: ChannelActivity,
): { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const reasons: string[] = []
  let score = relevance * 0.35
  const search = channels.seo + channels.search_ads
  score += search * 6
  if (channels.search_ads >= 2) reasons.push('Advertises on most of your searches')
  if (channels.seo >= 2) reasons.push('Ranks on page one for many of your searches')
  const g = s.reviews.find((r) => r.source === 'google')
  if (g?.rating && g.count) {
    const rv = Math.min(1, Math.log10(1 + g.count) / 2.7) * (g.rating / 5)
    score += rv * 15
    if (g.rating >= 4.6 && g.count >= 50) reasons.push(`Strong reviews: ${g.rating}★ from ${g.count}`)
  }
  const active = (Object.values(channels) as number[]).filter((v) => v >= 2).length
  score += active * 2
  if (channels.blog >= 2) reasons.push('Publishes regularly')
  if (channels.video >= 2 || channels.social >= 2) reasons.push('Active on social or video')
  const final = Math.round(Math.max(0, Math.min(100, score)))
  return { score: final, level: final >= 60 ? 'high' : final >= 35 ? 'medium' : 'low', reasons: reasons.slice(0, 4) }
}

/* ------------------------------------------------------------- pain points */

/** `phrase` is the label as it reads inside a sentence: "frustrated by delays". */
export const PAIN_THEMES: { theme: string; label: string; phrase: string; re: RegExp; answer: string }[] = [
  {
    theme: 'hidden_costs',
    phrase: 'unexpected costs',
    label: 'Unexpected or hidden costs',
    re: /\b(hidden|extra|additional|unexpected|surprise)\b.{0,25}\b(fee|fees|cost|costs|charge|charges)\b|\b(invoice|bill)\b.{0,30}\b(more|higher)\b|\bovercharg/i,
    answer: 'Put the full price in writing before anything starts, and say what is not included.',
  },
  {
    theme: 'communication',
    phrase: 'poor communication',
    label: 'Poor communication and updates',
    re: /\b(no|never|didn'?t|did not|hard to|couldn'?t|could not)\b.{0,25}\b(update|updated|call(ed)? back|respond|reply|replied|get hold|hear back|contact)\b|\bwent (quiet|silent)\b|\bignored\b|\bchasing\b/i,
    answer: 'Promise a named contact and a fixed update rhythm, and keep it.',
  },
  {
    theme: 'slow',
    phrase: 'delays',
    label: 'Slow or delayed',
    re: /\b(slow|delay|delayed|took (weeks|months|ages|forever)|waiting|waited|wait(ing)? list|still waiting)\b/i,
    answer: 'State realistic timelines up front and show where each case is.',
  },
  {
    theme: 'pressure',
    phrase: 'pushy selling',
    label: 'Pushy sales or upselling',
    re: /\b(pushy|pressur|hard sell|sales pitch|upsell|kept calling|follow-?up calls|spam|call centre)\b/i,
    answer: 'Make the first conversation advice, not a pitch, and say so.',
  },
  {
    theme: 'impersonal',
    phrase: 'being treated like a number',
    label: 'Impersonal, felt like a number',
    re: /\b(just a number|impersonal|didn'?t care|rushed|generic|not specific|passed (me )?(around|to another)|different person)\b/i,
    answer: 'Show the people: one adviser from start to finish.',
  },
  {
    theme: 'quality',
    phrase: 'mistakes and poor work',
    label: 'Mistakes or poor quality',
    re: /\b(mistake|mistakes|error|errors|wrong|incompetent|unprofessional|poor (quality|service|work)|botched|redo)\b/i,
    answer: 'Lead with your checks and your guarantee of putting things right.',
  },
  {
    theme: 'availability',
    phrase: 'being hard to reach or book',
    label: 'Hard to book or limited hours',
    re: /\b(only open|office hours|hard to book|couldn'?t book|no availability|fully booked|out of date website|website is)\b/i,
    answer: 'Make booking instant online and say when you answer the phone.',
  },
  {
    theme: 'expensive',
    phrase: 'feeling overcharged',
    label: 'Felt expensive',
    re: /\b(expensive|overpriced|too much|pricey|rip[- ]?off|cost a fortune)\b/i,
    answer: 'Explain what the fee buys, and show a fixed or capped price where you can.',
  },
]

export function painPointsFrom(
  snaps: { id: string; name: string; snapshot: PresenceSnapshot }[],
): PainPoint[] {
  const acc = new Map<string, PainPoint>()
  for (const { id, snapshot } of snaps) {
    for (const r of snapshot.reviews) {
      for (const s of r.samples) {
        if (s.rating > 3) continue
        for (const t of PAIN_THEMES) {
          if (!t.re.test(s.text)) continue
          const p = acc.get(t.theme) ?? { theme: t.theme, label: t.label, mentions: 0, competitors: [], quotes: [] }
          p.mentions += 1
          if (!p.competitors.includes(id)) p.competitors.push(id)
          if (p.quotes.length < 4) p.quotes.push(s.text.slice(0, 220))
          acc.set(t.theme, p)
        }
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.competitors.length - a.competitors.length || b.mentions - a.mentions)
}

/** What competitors' customers praise. Mirrors pain points; used for "what wins customers here". */
export function praiseThemes(snaps: PresenceSnapshot[]): string[] {
  const themes: [RegExp, string][] = [
    [/\b(kept me updated|updates?|communicat|explained|plain english|clear)\b/i, 'Clear communication'],
    [/\b(quick|fast|same day|within minutes|prompt)\b/i, 'Speed of response'],
    [/\b(honest|transparent|no surprises|exactly as quoted)\b/i, 'Honest, transparent pricing'],
    [/\b(expert|knowledg|professional)\b/i, 'Expertise'],
    [/\b(friendly|kind|caring|personal|local)\b/i, 'Personal, friendly service'],
    [/\b(value|good price|affordable)\b/i, 'Value for money'],
  ]
  const counts = new Map<string, number>()
  for (const s of snaps)
    for (const r of s.reviews)
      for (const x of r.samples)
        if (x.rating >= 4)
          for (const [re, label] of themes) if (re.test(x.text)) counts.set(label, (counts.get(label) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
}

/* ---------------------------------------------------------------- content */

/**
 * Topic families: the jobs a piece of content does for a searcher. Grouping
 * titles by job ("what does it cost", "how long does it take") is robust where
 * comparing exact phrases is not — two competitors never title a cost guide
 * the same way.
 */
export const TOPIC_FAMILIES: { id: string; label: string; make: string; re: RegExp; destinations: PlayDestination[] }[] = [
  { id: 'cost', make: 'a clear cost and pricing guide', label: 'Cost and pricing guides', re: /\b(cost|costs|price|pricing|fees?|how much|cheap|afford)/i, destinations: ['blog', 'landing_page', 'video'] },
  { id: 'timeline', make: 'a “how long does it take” guide', label: 'How long it takes', re: /\b(how long|timeline|timescale|time ?frame|how quickly|takes?\b)/i, destinations: ['blog', 'video'] },
  { id: 'comparison', make: 'an honest comparison of the options', label: 'Comparisons and alternatives', re: /\b(vs\.?|versus|alternatives?|compared?|comparison|which is (right|best)|difference between)\b/i, destinations: ['blog', 'landing_page'] },
  { id: 'howto', make: 'step-by-step guides', label: 'Step-by-step guides', re: /\b(how to|step[- ]by[- ]step|guide|explained|what is|what are|a beginner)/i, destinations: ['blog', 'video', 'social'] },
  { id: 'checklist', make: 'a free checklist or template', label: 'Checklists and templates', re: /\b(checklist|template|calculator|download|toolkit|free (guide|ebook))\b/i, destinations: ['blog', 'email'] },
  { id: 'mistakes', make: 'a “mistakes to avoid” guide', label: 'Mistakes to avoid', re: /\b(mistakes?|avoid|pitfalls?|warning signs|red flags|myths?)\b/i, destinations: ['blog', 'social', 'video'] },
  { id: 'questions', make: 'a questions-to-ask and FAQ guide', label: 'Questions to ask / FAQs', re: /\b(questions|faqs?|ask before|things to know|what to expect)\b/i, destinations: ['blog', 'landing_page'] },
  { id: 'case_study', make: 'case studies', label: 'Case studies and stories', re: /\b(case stud|success stor|client stor|how we helped|testimonial)/i, destinations: ['blog', 'video', 'social'] },
  { id: 'worth_it', make: 'an honest “is it worth it” guide', label: 'Is it worth it / pros and cons', re: /\b(worth it|pros and cons|advantages|disadvantages|should i|do i need)\b/i, destinations: ['blog', 'video'] },
  { id: 'news', make: 'updates on rule changes', label: 'Rule changes and news', re: /\b(new rules?|changes? to|update[sd]?|budget|legislation|deadline|20\d{2})\b/i, destinations: ['blog', 'email', 'social'] },
]

export function topicOf(title: string): string | null {
  for (const f of TOPIC_FAMILIES) if (f.re.test(title)) return f.id
  return null
}

export function contentTopics(
  snaps: { id: string; snapshot: PresenceSnapshot }[],
  self: PresenceSnapshot | null,
): ContentTopic[] {
  const ours = new Set<string>()
  if (self) {
    for (const p of self.blog.posts) {
      const t = topicOf(p.title)
      if (t) ours.add(t)
    }
    for (const p of self.pages) for (const h of [p.title, ...p.h1, ...p.h2]) {
      const t = topicOf(h)
      if (t) ours.add(t)
    }
  }
  const acc = new Map<string, ContentTopic>()
  for (const { id, snapshot } of snaps) {
    for (const p of snapshot.blog.posts) {
      const t = topicOf(p.title)
      if (!t) continue
      const fam = TOPIC_FAMILIES.find((f) => f.id === t)!
      const row = acc.get(t) ?? { topic: fam.label, competitors: [], examples: [], weCover: ours.has(t) }
      if (!row.competitors.includes(id)) row.competitors.push(id)
      if (row.examples.length < 5 && !row.examples.some((e) => e.url === p.url)) row.examples.push({ title: p.title, url: p.url })
      acc.set(t, row)
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].competitors.length - a[1].competitors.length)
    .map(([, v]) => v)
}

/* ----------------------------------------------------------------- search */

/** Click share by organic position, roughly the published UK desktop curve. */
const CTR = [0.28, 0.155, 0.1, 0.07, 0.052, 0.04, 0.032, 0.026, 0.021, 0.018]
const ctrAt = (pos: number | null) => (pos && pos >= 1 && pos <= 10 ? CTR[pos - 1] : pos && pos <= 20 ? 0.006 : 0)
const AD_SHARE = 0.045

export function searchMatrix(
  keywords: string[],
  snaps: { id: string; snapshot: PresenceSnapshot }[],
  self: PresenceSnapshot | null,
): SearchRow[] {
  return keywords.map((keyword) => {
    const k = keyword.toLowerCase()
    const cells = snaps.map(({ id, snapshot }) => {
      const hits = snapshot.organic.filter((o) => o.keyword.toLowerCase() === k)
      return {
        competitorId: id,
        organic: hits.length ? Math.min(...hits.map((h) => h.position)) : null,
        paid: snapshot.ads.some((a) => a.keyword.toLowerCase() === k),
      }
    })
    const usHits = self?.organic.filter((o) => o.keyword.toLowerCase() === k) ?? []
    return {
      keyword,
      usOrganic: usHits.length ? Math.min(...usHits.map((h) => h.position)) : null,
      usPaid: self?.ads.some((a) => a.keyword.toLowerCase() === k) ?? false,
      cells,
      crowding: cells.filter((c) => (c.organic !== null && c.organic <= 10) || c.paid).length,
    }
  })
}

export function shareOfVoice(rows: SearchRow[], names: Record<string, string>, selfName: string): LandscapeReport['shareOfVoice'] {
  const totals = new Map<string, number>()
  let us = 0
  for (const r of rows) {
    us += ctrAt(r.usOrganic) + (r.usPaid ? AD_SHARE : 0)
    for (const c of r.cells) totals.set(c.competitorId, (totals.get(c.competitorId) ?? 0) + ctrAt(c.organic) + (c.paid ? AD_SHARE : 0))
  }
  const sum = us + [...totals.values()].reduce((a, b) => a + b, 0)
  if (sum <= 0) return []
  const out: LandscapeReport['shareOfVoice'] = [
    { competitorId: 'us', name: selfName, share: us / sum },
    ...[...totals.entries()].map(([id, v]) => ({ competitorId: id, name: names[id] ?? id, share: v / sum })),
  ]
  return out.sort((a, b) => b.share - a.share)
}

/* ------------------------------------------------------------- claim matrix */

export function claimMatrix(
  snaps: { id: string; claims: Partial<Record<Claim, number>> }[],
  self: Partial<Record<Claim, number>> | null,
): ClaimRow[] {
  return ALL_CLAIMS.map((claim) => {
    const byCompetitor: Record<string, number> = {}
    for (const s of snaps) if (s.claims[claim]) byCompetitor[s.id] = s.claims[claim]!
    return {
      claim,
      byCompetitor,
      competitorsUsing: Object.keys(byCompetitor).length,
      us: self ? Boolean(self[claim]) : null,
    }
  }).sort((a, b) => b.competitorsUsing - a.competitorsUsing)
}

/* ------------------------------------------------------------------- plays */

const CLAIM_ANGLE: Partial<Record<Claim, { message: string; destinations: PlayDestination[] }>> = {
  risk_reversal: { message: 'take the risk out of the first step (free consultation, no obligation, fixed fee)', destinations: ['google_ads', 'landing_page', 'meta_ads'] },
  speed: { message: 'promise and prove speed: when they will hear back and how long it takes', destinations: ['google_ads', 'landing_page', 'video'] },
  proof: { message: 'lead with proof: real review counts, ratings and outcomes', destinations: ['google_ads', 'landing_page', 'social'] },
  price: { message: 'be clear about price: a published fee or a fixed-fee promise', destinations: ['google_ads', 'landing_page', 'email'] },
  authority: { message: 'show credentials: years, accreditations and who regulates you', destinations: ['landing_page', 'google_ads', 'video'] },
  outcome: { message: 'name the result the customer gets, not the service you provide', destinations: ['google_ads', 'meta_ads', 'video'] },
  audience: { message: 'say exactly who it is for, so the right people self-select', destinations: ['google_ads', 'meta_ads', 'social'] },
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a')

export type PlayInput = {
  keywords: string[]
  businessType: string
  names: Record<string, string>
  competitorCount: number
  claims: ClaimRow[]
  search: SearchRow[]
  content: ContentTopic[]
  painPoints: PainPoint[]
  channels: LandscapeReport['channels']
  /** Our own site was read, so "you do not publish this" is a finding rather than a guess. */
  selfReadable: boolean
  /** Our own search positions were read, so "you do not rank" is a finding too. */
  selfSearchRead: boolean
}

export function buildPlays(input: PlayInput): Play[] {
  const plays: Play[] = []
  const n = Math.max(1, input.competitorCount)
  const mainKw = input.keywords[0] ?? input.businessType
  const nameList = (ids: string[]) => ids.map((id) => input.names[id] ?? id).slice(0, 4).join(', ')

  // 1. Answer competitors' customers' biggest complaints.
  for (const p of input.painPoints.slice(0, 3)) {
    const theme = PAIN_THEMES.find((t) => t.theme === p.theme)
    if (!theme || p.mentions < 1) continue
    plays.push({
      id: `pain:${p.theme}`,
      kind: 'pain_point',
      title: `Answer what competitors’ customers complain about: ${theme.phrase}`,
      why: `${p.mentions} low-star review${p.mentions === 1 ? '' : 's'} across ${p.competitors.length} competitor${p.competitors.length === 1 ? '' : 's'} (${nameList(p.competitors)}) mention it. ${theme.answer}`,
      evidence: p.competitors.map((id) => `${id}:reviews`),
      destinations: ['landing_page', 'google_ads', 'video', 'social', 'email'],
      priority: p.competitors.length >= 2 ? 'high' : 'medium',
      brief: {
        title: `Why customers switch: no more ${theme.phrase}`,
        objective: `Win customers who have been frustrated by ${theme.phrase} elsewhere. ${theme.answer} Do not name or criticise any competitor; describe how we work instead, and only promise what we can evidence.`,
        keyMessages: [theme.answer, `What customers say goes wrong elsewhere: ${theme.phrase}`],
        keywords: input.keywords.slice(0, 3),
      },
    })
  }

  // 2. Angles few competitors own.
  for (const row of input.claims) {
    const angle = CLAIM_ANGLE[row.claim]
    if (!angle) continue
    const share = row.competitorsUsing / n
    if (share > 0.34) continue
    const ownedByUs = row.us === true
    plays.push({
      id: `angle:${row.claim}`,
      kind: 'unclaimed_angle',
      title: ownedByUs
        ? `Lean into ${CLAIM_LABEL[row.claim].toLowerCase()}: you say it, ${row.competitorsUsing === 0 ? 'no competitor does' : `only ${row.competitorsUsing} of ${n} competitors do`}`
        : `Test ${article(CLAIM_LABEL[row.claim])} ${CLAIM_LABEL[row.claim].toLowerCase()} angle: ${row.competitorsUsing === 0 ? 'no competitor uses it' : `only ${row.competitorsUsing} of ${n} competitors use it`}`,
      why: `Across competitors’ ads and pages, ${row.competitorsUsing} of ${n} make a ${CLAIM_LABEL[row.claim].toLowerCase()} claim. An angle nobody else uses stands out in a results page where every ad sounds the same.${ownedByUs ? '' : ' Only use it if you can substantiate it.'}`,
      evidence: Object.keys(row.byCompetitor).map((id) => `${id}:claims`),
      destinations: angle.destinations,
      priority: ownedByUs ? 'high' : 'medium',
      brief: {
        title: `${cap(CLAIM_LABEL[row.claim])} angle for ${mainKw}`,
        objective: `Stand apart from competitors by making the ${CLAIM_LABEL[row.claim].toLowerCase()} case: ${angle.message}. Only state what we can evidence.`,
        keyMessages: [cap(angle.message)],
        keywords: input.keywords.slice(0, 4),
      },
    })
  }

  // 3. Crowded claims: where everyone says the same thing, so should you not.
  for (const row of input.claims) {
    if (!['price', 'speed', 'proof', 'authority', 'risk_reversal'].includes(row.claim)) continue
    if (row.competitorsUsing / n < 0.6 || row.us !== true) continue
    plays.push({
      id: `counter:${row.claim}`,
      kind: 'counter',
      title: `Stop blending in on ${CLAIM_LABEL[row.claim].toLowerCase()}: ${row.competitorsUsing} of ${n} competitors already say it`,
      why: `You and most competitors make the same ${CLAIM_LABEL[row.claim].toLowerCase()} promise, so it no longer separates you. Keep it as a qualifier, and lead with something only you can say.`,
      evidence: Object.keys(row.byCompetitor).map((id) => `${id}:claims`),
      destinations: ['google_ads', 'landing_page'],
      priority: 'medium',
      brief: {
        title: `Rewrite ads that sound like everyone else`,
        objective: `Rewrite our ${mainKw} ads so they lead with a specific, verifiable difference rather than the ${CLAIM_LABEL[row.claim].toLowerCase()} claim every competitor makes.`,
        keyMessages: [`Lead with what only we can say`, `Keep ${CLAIM_LABEL[row.claim].toLowerCase()} as supporting detail`],
        keywords: input.keywords.slice(0, 4),
      },
    })
  }

  // 4. Content everyone else publishes and you do not.
  for (const t of input.content) {
    if (!input.selfReadable || t.weCover || t.competitors.length < 2) continue
    const fam = TOPIC_FAMILIES.find((f) => f.label === t.topic)
    plays.push({
      id: `content:${fam?.id ?? t.topic}`,
      kind: 'content_gap',
      title: `Publish ${fam?.make ?? t.topic.toLowerCase()} for ${mainKw}`,
      why: `${t.competitors.length} competitors (${nameList(t.competitors)}) publish this kind of content and your site does not. Searchers asking these questions find them first.`,
      evidence: t.examples.map((e) => e.url),
      destinations: fam?.destinations ?? ['blog'],
      priority: t.competitors.length >= 3 ? 'high' : 'medium',
      brief: {
        title: `${t.topic}: ${mainKw}`,
        objective: `Write the most useful ${t.topic.toLowerCase().replace(/s$/, '')} on ${mainKw} for UK customers — more specific and more honest than what is already ranking. Examples of what competitors publish: ${t.examples
          .slice(0, 3)
          .map((e) => `“${e.title}”`)
          .join('; ')}. Do not copy them; answer the question better.`,
        keyMessages: t.examples.slice(0, 3).map((e) => `Covers the question behind: ${e.title}`),
        keywords: [mainKw, ...input.keywords.slice(1, 3)],
      },
    })
  }

  // 5. Searches competitors own and you are missing from.
  for (const r of input.selfSearchRead ? input.search : []) {
    const organicRivals = r.cells.filter((c) => c.organic !== null && c.organic <= 10)
    const paidRivals = r.cells.filter((c) => c.paid)
    if (organicRivals.length >= 2 && (r.usOrganic === null || r.usOrganic > 10)) {
      plays.push({
        id: `seo:${r.keyword}`,
        kind: 'search_gap',
        title: `Get on page one for “${r.keyword}”`,
        why: `${organicRivals.length} competitors rank on page one for “${r.keyword}”; you ${r.usOrganic ? `are at position ${r.usOrganic}` : 'do not appear in the top 20'}.`,
        evidence: organicRivals.map((c) => `${c.competitorId}:organic`),
        destinations: ['landing_page', 'blog'],
        priority: organicRivals.length >= 3 ? 'high' : 'medium',
        brief: {
          title: `SEO: ${r.keyword}`,
          objective: `Create the page that best answers “${r.keyword}” for UK searchers, so we rank organically alongside the ${organicRivals.length} competitors already on page one.`,
          keyMessages: [r.keyword],
          keywords: [r.keyword],
        },
      })
    }
    if (paidRivals.length >= 2 && !r.usPaid) {
      plays.push({
        id: `ppc:${r.keyword}`,
        kind: 'search_gap',
        title: `${paidRivals.length} competitors advertise on “${r.keyword}” and you do not`,
        why: `When several businesses pay for a search, it usually converts. Consider a tightly themed ad group, with copy that does not repeat the claims already in the ads.`,
        evidence: paidRivals.map((c) => `${c.competitorId}:ads`),
        destinations: ['google_ads'],
        priority: 'medium',
        brief: {
          title: `Search ads: ${r.keyword}`,
          objective: `Win clicks on “${r.keyword}” from people ready to enquire, with ads that make a different, verifiable promise from the competitors already advertising there.`,
          keyMessages: [r.keyword],
          keywords: [r.keyword],
        },
      })
    }
  }

  // 6. Channels where most competitors are active and you are not.
  const CHANNEL_DEST: Partial<Record<ChannelKey, PlayDestination[]>> = {
    blog: ['blog'],
    video: ['video'],
    social: ['social', 'video'],
    reviews: ['email'],
    search_ads: ['google_ads'],
  }
  for (const c of input.channels) {
    const dest = CHANNEL_DEST[c.channel]
    if (!dest || !input.selfReadable) continue
    if (c.competitorsActive / n < 0.5 || c.us >= 2) continue
    const what =
      c.channel === 'reviews'
        ? 'Ask recent happy customers for a Google review'
        : c.channel === 'video'
          ? 'Start a short video series answering customers’ questions'
          : c.channel === 'social'
            ? 'Post useful, specific content where your customers already follow competitors'
            : c.channel === 'blog'
              ? 'Publish one genuinely useful article a fortnight'
              : 'Cover your highest-intent searches with ads'
    plays.push({
      id: `channel:${c.channel}`,
      kind: 'channel_gap',
      title: `${what}`,
      why: `${c.competitorsActive} of ${n} competitors are active here; you are ${c.us === 0 ? 'not present' : 'barely present'}.`,
      evidence: [],
      destinations: dest,
      priority: c.competitorsActive / n >= 0.75 ? 'high' : 'low',
      brief: {
        title: `${what}`,
        objective: `${what}, focused on ${mainKw}. Make it specific to our customers and how we work; do not mention competitors.`,
        keyMessages: [],
        keywords: input.keywords.slice(0, 3),
      },
    })
  }

  const rank = { high: 0, medium: 1, low: 2 }
  const seen = new Set<string>()
  return plays
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .sort((a, b) => rank[a.priority] - rank[b.priority])
    .slice(0, 24)
}

/* ---------------------------------------------------------------- changes */

/** Whether a source actually ran for this snapshot. Simulated snapshots count as read. */
export function wasRead(s: PresenceSnapshot, source: 'serp' | 'website' | 'reviews'): boolean {
  return s.sources.some((r) => r.source === 'simulator' || (r.source === source && r.status === 'ok'))
}

function adsRead(s: PresenceSnapshot): boolean {
  return (
    s.sources.some((r) => r.source === 'simulator') ||
    s.sources.some((r) => r.source === 'serp' && r.status === 'ok' && !/does not return ads/.test(r.note))
  )
}

/**
 * What changed between two scans of the same business. A section is compared
 * only when both scans actually read it: a provider outage, a switch to a
 * provider without ads, or a site that timed out is not "they stopped
 * advertising" or "they deleted their blog".
 */
export function diffSnapshots(prev: PresenceSnapshot, next: PresenceSnapshot): Change[] {
  const out: Change[] = []
  const bothAds = adsRead(prev) && adsRead(next)
  const bothSerp = wasRead(prev, 'serp') && wasRead(next, 'serp')
  const bothWeb = wasRead(prev, 'website') && wasRead(next, 'website')
  const adKey = (a: PresenceSnapshot['ads'][number]) => `${a.headline}|${a.description}`.toLowerCase()
  const prevAds = new Set(prev.ads.map(adKey))
  const nextAds = new Set(next.ads.map(adKey))
  const added = next.ads.filter((a) => !prevAds.has(adKey(a)))
  const stopped = prev.ads.filter((a) => !nextAds.has(adKey(a)))
  if (bothAds && added.length) {
    out.push({
      kind: 'new_ads',
      summary: `${added.length} new search ad${added.length === 1 ? '' : 's'}`,
      detail: added.slice(0, 4).map((a) => `“${a.headline}” on ${a.keyword}`),
      significant: true,
    })
  }
  if (bothAds && stopped.length && next.ads.length === 0 && prev.ads.length > 0) {
    out.push({ kind: 'ads_stopped', summary: 'Stopped advertising on your searches', detail: [], significant: true })
  }

  const pPrices = new Set(prev.offers.map((o) => o.toLowerCase()))
  const nPrices = new Set(next.offers.map((o) => o.toLowerCase()))
  const newPrices = next.offers.filter((o) => !pPrices.has(o.toLowerCase()))
  const gonePrices = prev.offers.filter((o) => !nPrices.has(o.toLowerCase()))
  if (bothWeb && newPrices.length && (gonePrices.length || prev.offers.length > 0)) {
    out.push({
      kind: 'price_change',
      summary: 'Prices changed',
      detail: [...gonePrices.map((p) => `was ${p}`), ...newPrices.map((p) => `now ${p}`)].slice(0, 6),
      significant: true,
    })
  }

  const prevPosts = new Set(prev.blog.posts.map((p) => p.url))
  const newPosts = next.blog.posts.filter((p) => !prevPosts.has(p.url))
  if (bothWeb && newPosts.length) {
    out.push({
      kind: 'new_posts',
      summary: `${newPosts.length} new post${newPosts.length === 1 ? '' : 's'}`,
      detail: newPosts.slice(0, 5).map((p) => p.title),
      significant: newPosts.length >= 3,
    })
  }

  const pg = prev.reviews.find((r) => r.source === 'google')
  const ng = next.reviews.find((r) => r.source === 'google')
  if (pg?.rating && ng?.rating && Math.abs(ng.rating - pg.rating) >= 0.1) {
    out.push({
      kind: 'rating_change',
      summary: `Google rating ${ng.rating > pg.rating ? 'up' : 'down'} from ${pg.rating} to ${ng.rating}`,
      detail: [`${ng.count} reviews (was ${pg.count})`],
      significant: Math.abs(ng.rating - pg.rating) >= 0.2,
    })
  }

  const prevNets = new Set(prev.social.map((s) => s.network))
  const newNets = next.social.filter((s) => !prevNets.has(s.network))
  if (bothWeb && newNets.length) {
    out.push({
      kind: 'new_channel',
      summary: `Now on ${newNets.map((s) => s.network).join(', ')}`,
      detail: newNets.map((s) => s.url),
      significant: false,
    })
  }

  const gains: string[] = []
  for (const o of bothSerp ? next.organic : []) {
    const before = prev.organic.find((p) => p.keyword === o.keyword)
    if ((!before && o.position <= 10) || (before && before.position - o.position >= 3)) {
      gains.push(`“${o.keyword}”: ${before ? `#${before.position} → ` : 'new at '}#${o.position}`)
    }
  }
  if (gains.length) out.push({ kind: 'ranking_gain', summary: `Climbed on ${gains.length} of your searches`, detail: gains.slice(0, 5), significant: gains.length >= 2 })

  const h = (s: PresenceSnapshot) => (s.pages.find((p) => p.kind === 'home')?.h1[0] ?? '').trim().toLowerCase()
  if (bothWeb && h(prev) && h(next) && h(prev) !== h(next)) {
    out.push({
      kind: 'positioning_change',
      summary: 'Changed their home page headline',
      detail: [`was “${prev.pages.find((p) => p.kind === 'home')?.h1[0]}”`, `now “${next.pages.find((p) => p.kind === 'home')?.h1[0]}”`],
      significant: true,
    })
  }
  return out
}

/* ------------------------------------------------------------- landscape */

export type LandscapeInput = {
  keywords: string[]
  businessType: string
  selfName: string
  self: PresenceSnapshot | null
  competitors: { id: string; name: string; snapshot: PresenceSnapshot }[]
  now?: Date
}

/** Everything in the landscape except the narrative, which the agent adds. */
export function buildLandscape(input: LandscapeInput): Omit<LandscapeReport, 'summary' | 'differentiators'> {
  const names = Object.fromEntries(input.competitors.map((c) => [c.id, c.name]))
  const kwCount = input.keywords.length
  const claimRows = claimMatrix(
    input.competitors.map((c) => ({ id: c.id, claims: claimsOf(c.snapshot) })),
    input.self && input.self.pages.length ? claimsOf(input.self) : null,
  )
  const search = searchMatrix(input.keywords, input.competitors, input.self)
  const content = contentTopics(input.competitors, input.self)
  const painPoints = painPointsFrom(input.competitors)
  const activities = input.competitors.map((c) => channelActivity(c.snapshot, kwCount))
  const selfActivity = input.self ? channelActivity(input.self, kwCount) : null
  const channelKeys: ChannelKey[] = ['website', 'blog', 'search_ads', 'seo', 'reviews', 'social', 'video', 'pr']
  const channels = channelKeys.map((channel) => ({
    channel,
    competitorsActive: activities.filter((a) => a[channel] >= 2).length,
    us: selfActivity ? selfActivity[channel] : (0 as const),
  }))
  const plays = buildPlays({
    keywords: input.keywords,
    businessType: input.businessType,
    names,
    competitorCount: input.competitors.length,
    claims: claimRows,
    search,
    content,
    painPoints,
    channels,
    selfReadable: Boolean(input.self && input.self.pages.length),
    selfSearchRead: Boolean(input.self && wasRead(input.self, 'serp')),
  })
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    competitorIds: input.competitors.map((c) => c.id),
    names,
    simulated: input.competitors.some((c) => c.snapshot.simulated) || Boolean(input.self?.simulated),
    claims: claimRows,
    search,
    shareOfVoice: shareOfVoice(search, names, input.selfName),
    content,
    painPoints,
    channels,
    plays,
  }
}
