import 'server-only'
import { z } from 'zod'
import { run } from '../gateway'
import { CLAIM_LABEL } from '@/lib/serptwin/claims'
import { applyGuards, classifyByRules, type ProfileGuess } from '@/lib/competitors/profile'
import { evidenceIndex, keepKnownEvidence } from '@/lib/competitors/analysis'
import { digest, templateAnalysis, templateLandscape } from '@/lib/competitors/narrative'
import type { CompanyProfile, CompetitorAnalysis, LandscapeReport, PresenceSnapshot } from '@/lib/competitors/types'
import { CHANNEL_KEY_LABEL } from '@/lib/competitors/types'
import type { PageExtract } from '@/lib/competitors/types'

/**
 * Competitor intelligence agents.
 *
 * Three jobs, each with a deterministic stand-in so the module works with no
 * model:
 *
 *  1. classifyBusiness — what the business is, which searches find it, and
 *     whether it competes locally or nationally. Ported from the prototype's
 *     `generate_profile_keywords`, and still held to its SIC guard rails
 *     afterwards: the model describes, the rules veto.
 *  2. analyseCompetitor — positioning, competitive advantage, strengths,
 *     weaknesses and how to win, every point citing snapshot evidence ids.
 *     Ids the snapshot does not contain are dropped, and so is any point left
 *     with nothing to stand on, unless it is the overall advantage.
 *  3. synthesiseLandscape — the summary and what the business can credibly
 *     own, written over the arithmetic in `analysis.ts`, never instead of it.
 */

/* ------------------------------------------------------------ 1. classify */

const classifySchema = z.object({
  businessType: z.string().min(2).max(80),
  keywords: z.array(z.string().min(2).max(60)).min(3).max(12),
  scope: z.enum(['local', 'hybrid', 'national']),
  confidence: z.number().min(0).max(1),
})

export async function classifyBusiness(args: {
  workspaceId: string
  userId?: string | null
  companyName: string
  sicCodes: string[]
  sicText?: string
  site?: PageExtract[]
}): Promise<ProfileGuess & { simulated: boolean }> {
  const siteSummary = (args.site ?? [])
    .slice(0, 4)
    .map((p) => `${p.kind}: ${p.title} | ${p.h1.join(' / ')} | ${p.description} | ${p.h2.slice(0, 6).join(' / ')}`)
    .join('\n')

  const system = [
    'You classify UK businesses for competitor discovery.',
    'Given a company name, its SIC codes and (when available) its own website, return:',
    '- businessType: what the business actually sells, in 2-5 plain words (e.g. "insolvency practitioner", "emergency plumber").',
    '- keywords: 6-10 short Google searches a UK customer would type to find this kind of business. Buying intent, not jargon. No locations, no brand names.',
    '- scope: "local" (customers come from nearby: trades, clinics, restaurants), "national" (sold online or nationwide), or "hybrid" (nationwide work but local presence matters: law firms, accountants, insolvency).',
    '- confidence: 0-1.',
    'Prefer what the website says over the SIC code: SIC codes are often generic or out of date.',
    'Never return food or restaurant terms unless the business is clearly in food service.',
  ].join('\n')

  const prompt = [
    `COMPANY: ${args.companyName}`,
    `SIC CODES: ${args.sicCodes.join(', ') || 'unknown'}${args.sicText ? ` (${args.sicText})` : ''}`,
    siteSummary ? `WEBSITE:\n${siteSummary}` : 'WEBSITE: not available',
  ].join('\n')

  const result = await run({
    agent: 'competitors.classify',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: classifySchema,
    tier: 'fast',
    temperature: 0.2,
    maxTokens: 600,
    cacheTtlSeconds: 7 * 86400,
    simulate: () => {
      const r = classifyByRules(args.companyName, args.sicCodes)
      return { businessType: r.businessType, keywords: r.keywords, scope: r.scope, confidence: r.confidence }
    },
  })

  const guarded = applyGuards(
    { ...result.data, source: result.meta.simulated ? 'rules' : 'ai' },
    args.companyName,
    args.sicCodes,
  )
  return { ...guarded, simulated: result.meta.simulated }
}

/* ------------------------------------------------------------- 2. analyse */

const insight = z.object({ text: z.string().min(3).max(400), evidence: z.array(z.string()).max(8).default([]) })

const analysisSchema = z.object({
  positioning: z.string().min(5).max(400),
  audience: z.string().min(2).max(240),
  advantage: insight,
  valueProps: z.array(insight).max(6).default([]),
  strengths: z.array(insight).max(6).default([]),
  weaknesses: z.array(insight).max(6).default([]),
  howToWin: z.array(insight).max(6).default([]),
  tone: z.string().max(240).default(''),
})

export async function analyseCompetitor(args: {
  workspaceId: string
  userId?: string | null
  competitorId: string | null
  profile: CompanyProfile
  snapshot: PresenceSnapshot
  /** Our own snapshot, so "how to win" is about this business, not generic advice. */
  self: PresenceSnapshot | null
  computed: Pick<CompetitorAnalysis, 'claims' | 'channels' | 'threat'>
  discoveryReasons?: string[]
}): Promise<CompetitorAnalysis> {
  const { snapshot: s, computed } = args
  const fallback = () => templateAnalysis(s, args.profile, computed)

  // Nothing to read: a model would only invent. The template says so plainly.
  const index = evidenceIndex(s)
  if (index.size === 0) return fallback()

  const ours = args.self
    ? args.self.pages
        .slice(0, 3)
        .map((p) => `${p.title} | ${p.h1.join(' / ')} | ${p.description}`)
        .join('\n') + (args.self.trustSignals.length ? `\nTrust signals: ${args.self.trustSignals.slice(0, 6).join('; ')}` : '')
    : 'Not available.'

  const system = [
    `You are a competitive strategist for a UK ${args.profile.businessType}. You are analysing ONE competitor from evidence gathered from their website, Google search results, ads and reviews.`,
    'Every evidence line is tagged with an id in square brackets, e.g. [ad:0], [page:1], [review:google:2]. Cite those ids in the "evidence" array of every point you make.',
    'Rules:',
    '- Only state what the evidence supports. If you infer, say "appears to". Never invent prices, statistics, awards or review counts.',
    '- "advantage" is the single thing that best explains why a customer would choose them over others. Be specific.',
    '- "weaknesses" come from complaints in reviews, gaps in what they publish, or claims they cannot back up.',
    '- "howToWin" is advice for OUR business: concrete, ethical, and legal under the UK CAP Code. Never suggest naming, disparaging or copying the competitor, or making unverifiable comparative claims.',
    '- Write in plain British English. Short sentences.',
    'Return JSON: { positioning, audience, advantage: {text, evidence}, valueProps: [{text, evidence}], strengths: [...], weaknesses: [...], howToWin: [...], tone }',
  ].join('\n')

  const prompt = [
    `COMPETITOR: ${s.name}${s.domain ? ` (${s.domain})` : ''}`,
    args.discoveryReasons?.length ? `WHY THEY ARE A COMPETITOR: ${args.discoveryReasons.join('; ')}` : '',
    `CLAIMS DETECTED (count): ${Object.entries(computed.claims)
      .map(([k, v]) => `${CLAIM_LABEL[k as keyof typeof CLAIM_LABEL]} ${v}`)
      .join(', ') || 'none'}`,
    `CHANNEL ACTIVITY (0-3): ${Object.entries(computed.channels)
      .map(([k, v]) => `${CHANNEL_KEY_LABEL[k as keyof typeof CHANNEL_KEY_LABEL]} ${v}`)
      .join(', ')}`,
    '',
    'EVIDENCE:',
    digest(s),
    '',
    `OUR BUSINESS (${args.profile.companyName}):`,
    ours,
  ]
    .filter((x) => x !== '')
    .join('\n')

  const result = await run({
    agent: 'competitors.analyse',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: analysisSchema,
    tier: 'smart',
    temperature: 0.3,
    maxTokens: 2500,
    cacheTtlSeconds: 3 * 86400,
    subject: args.competitorId ? { type: 'competitor', id: args.competitorId } : null,
    simulate: () => {
      const t = fallback()
      return {
        positioning: t.positioning,
        audience: t.audience,
        advantage: t.advantage,
        valueProps: t.valueProps,
        strengths: t.strengths,
        weaknesses: t.weaknesses,
        howToWin: t.howToWin,
        tone: t.tone,
      }
    },
  })

  const d = result.data
  const strict = (xs: { text: string; evidence: string[] }[]) => keepKnownEvidence(xs, index).filter((x) => x.evidence.length > 0)
  const [advantage] = keepKnownEvidence([d.advantage], index)
  return {
    positioning: d.positioning,
    audience: d.audience,
    advantage: advantage ?? { text: d.advantage.text, evidence: [] },
    valueProps: keepKnownEvidence(d.valueProps, index),
    strengths: strict(d.strengths),
    weaknesses: keepKnownEvidence(d.weaknesses, index),
    // Advice about our business need not cite the competitor's evidence.
    howToWin: keepKnownEvidence(d.howToWin, index),
    tone: d.tone,
    claims: computed.claims,
    channels: computed.channels,
    threat: computed.threat,
    simulated: result.meta.simulated,
  }
}

/* --------------------------------------------------------- 3. synthesise */

const landscapeSchema = z.object({
  summary: z.string().min(10).max(1200),
  differentiators: z.array(insight).max(6).default([]),
})

export async function synthesiseLandscape(args: {
  workspaceId: string
  userId?: string | null
  profile: CompanyProfile
  report: Omit<LandscapeReport, 'summary' | 'differentiators'>
  analyses: { id: string; name: string; analysis: CompetitorAnalysis }[]
  self: PresenceSnapshot | null
}): Promise<Pick<LandscapeReport, 'summary' | 'differentiators'> & { simulated: boolean }> {
  const { report } = args
  const n = report.competitorIds.length
  const fallback = () => templateLandscape(report, args.profile.companyName)
  if (n === 0) return { ...fallback(), simulated: true }

  const system = [
    `You advise a UK ${args.profile.businessType} on how to stand out from its competitors.`,
    'You are given computed facts about the market (claims each competitor makes, who wins which searches, customer complaints, channel activity) and a short analysis of each competitor.',
    'Write:',
    '- summary: 3-5 sentences on the shape of this market and where the opening is. Concrete, no fluff.',
    '- differentiators: 3-5 things THIS business can credibly own. Each must be grounded in the facts given; cite competitor ids (e.g. "c1:claims", "c2:reviews") or "us" in evidence.',
    'Never recommend disparaging competitors or making unverifiable comparative claims (UK CAP Code 3.33-3.44).',
    'Return JSON: { summary, differentiators: [{text, evidence}] }',
  ].join('\n')

  const idAlias = new Map(report.competitorIds.map((id, i) => [id, `c${i + 1}`]))
  const alias = (id: string) => idAlias.get(id) ?? id
  const prompt = [
    `OUR BUSINESS: ${args.profile.companyName} — ${args.profile.businessType}, ${args.profile.scope} scope, searches: ${args.profile.keywords.join(', ')}`,
    args.self?.pages[0] ? `OUR HOME PAGE: ${args.self.pages[0].title} | ${args.self.pages[0].h1.join(' / ')} | ${args.self.pages[0].description}` : '',
    args.self?.trustSignals.length ? `OUR TRUST SIGNALS: ${args.self.trustSignals.join('; ')}` : '',
    '',
    'COMPETITORS:',
    ...args.analyses.map(
      (a) =>
        `${alias(a.id)} ${a.name}: ${a.analysis.positioning} | advantage: ${a.analysis.advantage.text} | weaknesses: ${a.analysis.weaknesses
          .map((w) => w.text)
          .join('; ')} | threat ${a.analysis.threat.score}/100`,
    ),
    '',
    `CLAIMS (competitors using / ${n}; us): ${report.claims
      .map((c) => `${CLAIM_LABEL[c.claim]} ${c.competitorsUsing}/${n}${c.us === null ? '' : c.us ? ' us:yes' : ' us:no'}`)
      .join(', ')}`,
    `SHARE OF SEARCH: ${report.shareOfVoice.map((s) => `${s.competitorId === 'us' ? 'us' : alias(s.competitorId)} ${Math.round(s.share * 100)}%`).join(', ')}`,
    `CUSTOMER COMPLAINTS ABOUT COMPETITORS: ${report.painPoints.map((p) => `${p.label} (${p.mentions})`).join(', ') || 'none found'}`,
    `CHANNELS (competitors active / ${n}; us 0-3): ${report.channels.map((c) => `${CHANNEL_KEY_LABEL[c.channel]} ${c.competitorsActive}, us ${c.us}`).join('; ')}`,
    `CONTENT COMPETITORS PUBLISH THAT WE DO NOT: ${report.content.filter((c) => !c.weCover).map((c) => `${c.topic} (${c.competitors.length})`).join(', ') || 'none'}`,
  ]
    .filter(Boolean)
    .join('\n')

  const result = await run({
    agent: 'competitors.landscape',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt,
    schema: landscapeSchema,
    tier: 'smart',
    temperature: 0.4,
    maxTokens: 1500,
    simulate: fallback,
  })

  // Map the short aliases back to real ids.
  const back = new Map([...idAlias.entries()].map(([id, a]) => [a, id]))
  // Keep only evidence that points at a real competitor (or at us).
  const differentiators = result.data.differentiators.map((d) => ({
    text: d.text,
    evidence: d.evidence
      .map((e) => {
        const [head, ...rest] = e.split(':')
        if (head === 'us') return e
        const real = back.get(head)
        return real ? [real, ...rest].join(':') : null
      })
      .filter((e): e is string => e !== null),
  }))
  return { summary: result.data.summary, differentiators, simulated: result.meta.simulated }
}

