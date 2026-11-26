/**
 * The narrative, without a model.
 *
 * When no model is configured (or the provider fails) the gateway calls these
 * instead, so the module never shows an empty analysis. They are written from
 * the same evidence the model sees and cite it the same way, so the screen
 * looks and behaves identically — it is just plainer prose.
 *
 * Also home to `digest`, the compact, id-tagged text of a snapshot that the
 * model is given. Pure: no I/O.
 */

import { CLAIM_LABEL, extractClaims, type Claim } from '@/lib/serptwin/claims'
import { evidenceIndex, praiseThemes, PAIN_THEMES } from './analysis'
import type {
  ChannelActivity,
  CompanyProfile,
  CompetitorAnalysis,
  Insight,
  LandscapeReport,
  PresenceSnapshot,
} from './types'
import { CHANNEL_KEY_LABEL } from './types'

/** The snapshot as id-tagged lines. Every id is resolvable by `evidenceIndex`. */
export function digest(s: PresenceSnapshot, maxChars = 9000): string {
  const lines: string[] = []
  s.offers.forEach((o, i) => lines.push(`[price:${i}] ${o}`))
  s.trustSignals.forEach((t, i) => lines.push(`[signal:${i}] ${t}`))
  if (s.structured.foundingYear) lines.push(`[fact] founded ${s.structured.foundingYear}`)
  if (s.structured.areaServed.length) lines.push(`[fact] area served: ${s.structured.areaServed.join(', ')}`)
  if (s.company?.incorporatedOn) lines.push(`[fact] incorporated ${s.company.incorporatedOn}; accounts: ${s.company.accountsType ?? 'unknown'}`)
  s.ads.forEach((a, i) => lines.push(`[ad:${i}] on "${a.keyword}" (position ${a.position ?? '?'}): "${a.headline}" — "${a.description}"`))
  s.organic.forEach((o, i) => lines.push(`[organic:${i}] ranks #${o.position} for "${o.keyword}": ${o.title}`))
  if (s.topKeywords.length) lines.push(`[fact] top keywords: ${s.topKeywords.slice(0, 10).map((k) => `${k.keyword} (#${k.position})`).join(', ')}`)
  s.blog.posts.slice(0, 12).forEach((p, i) => lines.push(`[post:${i}] ${p.publishedAt?.slice(0, 10) ?? 'undated'} "${p.title}"`))
  lines.push(`[fact] blog posts in the last 90 days: ${s.blog.postsLast90Days}`)
  s.reviews.forEach((r) => {
    lines.push(`[fact] ${r.source} rating ${r.rating ?? 'n/a'} from ${r.count} reviews`)
    r.samples.forEach((x, i) => lines.push(`[review:${r.source}:${i}] ${x.rating}★ "${x.text.slice(0, 260)}"`))
  })
  s.social.forEach((x, i) =>
    lines.push(
      `[social:${i}] ${x.network} ${x.url}${x.followers !== null ? ` — ${x.followers} followers` : ''}${x.recent.length ? `; latest: ${x.recent.slice(0, 3).map((r) => `"${r.title}"`).join(', ')}` : ''}`,
    ),
  )
  s.news.forEach((n, i) => lines.push(`[news:${i}] ${n.publishedAt ?? ''} ${n.source}: ${n.title}`))
  // Pages last: they are the longest, so when the digest is cut it is page copy
  // that goes, not the ads, reviews and rankings.
  s.pages.forEach((p, i) =>
    lines.push(
      `[page:${i}] ${p.kind.toUpperCase()} ${p.url}\n  title: ${p.title}\n  h1: ${p.h1.join(' / ')}\n  description: ${p.description}\n  sections: ${p.h2.slice(0, 8).join(' / ')}\n  calls to action: ${p.ctas.join(' / ')}\n  copy: ${p.excerpt.slice(0, 500)}`,
    ),
  )
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[…truncated]` : text
}

const topClaims = (claims: Partial<Record<Claim, number>>, n = 3): Claim[] =>
  (Object.entries(claims) as [Claim, number][])
    .filter(([c]) => c !== 'cta' && c !== 'specificity')
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c]) => c)

function idsWhere(s: PresenceSnapshot, test: (label: string, text: string) => boolean, max = 3): string[] {
  const out: string[] = []
  for (const [id, v] of evidenceIndex(s)) if (test(v.label, v.text) && out.length < max) out.push(id)
  return out
}

/** A plain analysis built from the evidence alone. Used without a model. */
export function templateAnalysis(
  s: PresenceSnapshot,
  profile: Pick<CompanyProfile, 'businessType' | 'keywords'>,
  computed: Pick<CompetitorAnalysis, 'claims' | 'channels' | 'threat'>,
): CompetitorAnalysis {
  const home = s.pages.find((p) => p.kind === 'home') ?? s.pages[0]
  const claims = topClaims(computed.claims)
  const headline = home?.h1[0] ?? home?.title ?? s.name
  const g = s.reviews.find((r) => r.source === 'google')
  const lead = claims[0]

  const advantageText = lead
    ? `Leads on ${CLAIM_LABEL[lead].toLowerCase()}: it is the promise that recurs most across their ads and pages.`
    : g?.rating && g.count >= 50
      ? `Customer proof: ${g.rating}★ from ${g.count} Google reviews.`
      : computed.channels.seo >= 2
        ? 'Visibility: they rank on page one for many of the searches your customers make.'
        : 'No single clear advantage stands out in what they publish.'
  const advantageEvidence = lead
    ? idsWhere(s, (_, t) => extractClaims(t).includes(lead), 3)
    : g
      ? idsWhere(s, (l) => l.includes('review'), 2)
      : idsWhere(s, (l) => l.startsWith('Ranks'), 2)

  const strengths: Insight[] = []
  if (computed.channels.search_ads >= 2) strengths.push({ text: 'Pays to appear on most of your searches.', evidence: idsWhere(s, (l) => l.startsWith('Search ad')) })
  if (computed.channels.seo >= 2) strengths.push({ text: 'Ranks organically on page one for several of your searches.', evidence: idsWhere(s, (l) => l.startsWith('Ranks')) })
  if (g?.rating && g.rating >= 4.5 && g.count >= 50) strengths.push({ text: `Strong review profile (${g.rating}★, ${g.count} reviews).`, evidence: idsWhere(s, (l) => l.includes('★'), 2) })
  if (s.trustSignals.length) strengths.push({ text: `Uses trust signals prominently: ${s.trustSignals.slice(0, 2).join('; ')}.`, evidence: ['signal:0', 'signal:1'].filter((id) => evidenceIndex(s).has(id)) })
  if (computed.channels.blog >= 2) strengths.push({ text: `Publishes regularly (${s.blog.postsLast90Days} posts in 90 days).`, evidence: idsWhere(s, (l) => l.startsWith('Blog'), 3) })
  if (s.offers.length) strengths.push({ text: `Shows prices openly (${s.offers.slice(0, 2).join(', ')}).`, evidence: idsWhere(s, (l) => l === 'Price', 2) })

  const weaknesses: Insight[] = []
  const low = g?.samples.filter((x) => x.rating <= 3) ?? []
  for (const t of PAIN_THEMES) {
    const hits = low.map((x, i) => ({ x, i })).filter(({ x }) => t.re.test(x.text))
    if (hits.length) weaknesses.push({ text: `Customers complain about ${t.phrase}.`, evidence: hits.slice(0, 2).map(({ x }) => `review:google:${g!.samples.indexOf(x)}`) })
  }
  if (computed.channels.blog === 0) weaknesses.push({ text: 'No recent content: nothing to answer customers’ questions before they buy.', evidence: [] })
  if (computed.channels.search_ads === 0 && computed.channels.seo <= 1) weaknesses.push({ text: 'Weak on your searches: neither ranks well nor advertises.', evidence: [] })
  if (s.offers.length === 0 && s.pages.length) weaknesses.push({ text: 'No prices published, which leaves price-conscious searchers guessing.', evidence: idsWhere(s, (l) => l.endsWith('page'), 1) })

  const howToWin: Insight[] = []
  for (const w of weaknesses.slice(0, 2)) {
    const t = PAIN_THEMES.find((p) => w.text.includes(p.phrase))
    if (t) howToWin.push({ text: t.answer, evidence: w.evidence })
  }
  if (lead) howToWin.push({ text: `Do not compete head-on on ${CLAIM_LABEL[lead].toLowerCase()}; lead with a different, verifiable promise.`, evidence: advantageEvidence })
  if (computed.channels.blog === 0) howToWin.push({ text: 'Answer the questions they leave unanswered with useful guides.', evidence: [] })

  const praise = praiseThemes([s])
  return {
    positioning: `${s.name}: “${headline}”${home?.description ? ` — ${home.description.slice(0, 160)}` : ''}`,
    audience: s.structured.areaServed.length ? `Customers in ${s.structured.areaServed.slice(0, 3).join(', ')}` : `People looking for ${profile.keywords[0] ?? profile.businessType}`,
    advantage: { text: advantageText, evidence: advantageEvidence },
    valueProps: claims.map((c) => ({ text: CLAIM_LABEL[c], evidence: idsWhere(s, (_, t) => extractClaims(t).includes(c), 2) })),
    strengths: strengths.slice(0, 5),
    weaknesses: weaknesses.slice(0, 5),
    howToWin: howToWin.slice(0, 4),
    tone: praise.length ? `Customers praise: ${praise.slice(0, 2).join(', ').toLowerCase()}.` : 'Not enough copy to judge tone.',
    claims: computed.claims,
    channels: computed.channels,
    threat: computed.threat,
    simulated: true,
  }
}

/** Summary and differentiators without a model. */
export function templateLandscape(
  report: Omit<LandscapeReport, 'summary' | 'differentiators'>,
  selfName: string,
): Pick<LandscapeReport, 'summary' | 'differentiators'> {
  const n = report.competitorIds.length
  const crowded = report.claims
    .filter((c) => c.competitorsUsing / Math.max(1, n) >= 0.5 && !['cta', 'specificity', 'feature'].includes(c.claim))
    .map((c) => CLAIM_LABEL[c.claim].toLowerCase())
  const open = report.claims.filter((c) => c.competitorsUsing <= 1 && !['cta', 'specificity', 'feature', 'urgency'].includes(c.claim))
  const lead = report.shareOfVoice[0]
  const pain = report.painPoints[0]
  const parts = [
    `${n} competitor${n === 1 ? '' : 's'} analysed.`,
    lead ? `${lead.competitorId === 'us' ? 'You hold' : `${lead.name} holds`} the largest share of your searches (${Math.round(lead.share * 100)}%).` : '',
    crowded.length ? `Most competitors promise ${crowded.slice(0, 3).join(', ')}, so those claims no longer set anyone apart.` : '',
    pain ? `The most common complaint about competitors is ${PAIN_THEMES.find((t) => t.theme === pain.theme)?.phrase ?? pain.label.toLowerCase()}.` : '',
  ].filter(Boolean)
  const differentiators: Insight[] = [
    ...open
      .filter((c) => c.us)
      .map((c) => ({ text: `${selfName} already makes a ${CLAIM_LABEL[c.claim].toLowerCase()} claim that few competitors do.`, evidence: [] })),
    ...(pain ? [{ text: `Be visibly better at what customers say goes wrong elsewhere: ${PAIN_THEMES.find((t) => t.theme === pain.theme)?.phrase ?? pain.label.toLowerCase()}.`, evidence: pain.competitors.map((id) => `${id}:reviews`) }] : []),
    ...report.channels
      .filter((c) => c.us >= 2 && c.competitorsActive / Math.max(1, n) < 0.4)
      .map((c) => ({ text: `You are stronger than most competitors on ${CHANNEL_KEY_LABEL[c.channel].toLowerCase()}.`, evidence: [] })),
  ]
  return { summary: parts.join(' '), differentiators: differentiators.slice(0, 5) }
}

export function channelSentence(c: ChannelActivity): string {
  const strong = (Object.entries(c) as [keyof ChannelActivity, number][]).filter(([, v]) => v >= 2).map(([k]) => CHANNEL_KEY_LABEL[k])
  return strong.length ? `Active on ${strong.join(', ').toLowerCase()}.` : 'Little activity on any channel.'
}
