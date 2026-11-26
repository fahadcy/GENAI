/**
 * Brand and legal guardrails (PRD CS-2, 4.2 idea #2).
 *
 * Deliberately deterministic and dependency-free:
 *   - it runs on every generated variant, so it must be fast and free;
 *   - a reviewer must be able to see *why* a score is what it is;
 *   - the same input must always produce the same score, or "95% pass rate"
 *     is not a measurable claim.
 *
 * Pure functions only — no database, no network. Unit-tested in tests/.
 */
import type { AssetBody, BrandProfile, GuardrailFinding, LegalRule, ScoreDetail, ToneAxis } from '@/lib/db/schema'

/* ------------------------------------------------------------ text prep */

export function flattenBody(body: AssetBody): string {
  return [body.subject, body.preheader, body.headline, body.body, body.cta, (body.hashtags ?? []).join(' ')]
    .filter(Boolean)
    .join('\n')
}

/**
 * Fixed display and iteration order for the tone axes.
 *
 * Postgres jsonb does not preserve key insertion order — it sorts keys by
 * length then bytewise — so anything that iterates `Object.keys(profile.tone)`
 * gets an arbitrary-looking order back out of the database. Every axis loop
 * should use this instead.
 */
export const TONE_AXES = ['formal', 'warm', 'technical', 'playful', 'urgent'] as const

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

function words(text: string): string[] {
  return text.match(WORD_RE) ?? []
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
}

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length <= 3) return 1
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  return Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) ?? []).length)
}

/* ------------------------------------------------------------ readability */

export function readability(text: string): { grade: number; score: number } {
  const w = words(text)
  const s = sentences(text)
  if (w.length === 0 || s.length === 0) return { grade: 0, score: 100 }
  const syl = w.reduce((a, x) => a + syllables(x), 0)
  const grade = 0.39 * (w.length / s.length) + 11.8 * (syl / w.length) - 15.59
  const clamped = Math.max(1, Math.round(grade * 10) / 10)
  return { grade: clamped, score: 0 } // score filled in by scoreAsset against the profile
}

/* ------------------------------------------------------- tone estimation */

const CONTRACTIONS = /\b\w+'(?:s|re|ve|ll|d|t|m)\b/gi
const PLAYFUL_WORDS =
  /\b(awesome|amazing|love|fun|cool|hey|oops|yay|magic|delight|super|wow|honestly|basically|kinda)\b/gi
const URGENT_WORDS =
  /\b(now|today|hurry|last chance|ends|deadline|limited|final|only \d+|don'?t miss|act fast|expires|closing|immediately)\b/gi
const TECHNICAL_WORDS =
  /\b(api|latency|throughput|architecture|integration|pipeline|orchestration|schema|attribution|segmentation|infrastructure|deployment|sdk|webhook|p95|sla|throughput|governance|compliance)\b/gi
const WARM_WORDS = /\b(you|your|we|us|together|help|support|welcome|thanks|thank you|glad|happy to)\b/gi
const FORMAL_MARKERS =
  /\b(furthermore|therefore|accordingly|regarding|pursuant|herein|moreover|consequently|with respect to|please find)\b/gi

function rate(text: string, re: RegExp, per = 100): number {
  const w = words(text).length || 1
  const matches = text.match(re)?.length ?? 0
  return (matches / w) * per
}

export function estimateTone(text: string): ToneAxis {
  const w = words(text)
  const wordCount = w.length || 1
  const avgWordLen = w.reduce((a, x) => a + x.length, 0) / wordCount
  const avgSentLen = wordCount / (sentences(text).length || 1)
  const exclamations = (text.match(/!/g) ?? []).length
  const questions = (text.match(/\?/g) ?? []).length
  const contractionRate = rate(text, CONTRACTIONS)
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

  const formal = clamp(
    30 +
      (avgWordLen - 4.4) * 22 +
      (avgSentLen - 14) * 1.6 +
      rate(text, FORMAL_MARKERS) * 14 -
      contractionRate * 5 -
      exclamations * 6 -
      emoji * 8,
  )

  const playful = clamp(
    12 +
      rate(text, PLAYFUL_WORDS) * 16 +
      exclamations * 9 +
      emoji * 12 +
      contractionRate * 3.5 +
      questions * 3,
  )

  const technical = clamp(
    14 + rate(text, TECHNICAL_WORDS) * 20 + (avgWordLen - 4.4) * 12 + rate(text, /\b\d[\d.,%]*\b/g) * 4,
  )

  const urgent = clamp(6 + rate(text, URGENT_WORDS) * 24 + exclamations * 7)

  const warm = clamp(18 + rate(text, WARM_WORDS) * 9 + contractionRate * 4 - (avgWordLen - 4.4) * 8)

  return { formal, playful, technical, urgent, warm }
}

/* ---------------------------------------------------------- legal checks */

export function checkLegal(text: string, rules: LegalRule[], channel: string): GuardrailFinding[] {
  const findings: GuardrailFinding[] = []
  for (const rule of rules) {
    if (!rule.active) continue
    if (rule.channels.length > 0 && !rule.channels.includes(channel)) continue
    let re: RegExp
    try {
      re = new RegExp(rule.pattern, 'gi')
    } catch {
      continue // a malformed rule must never break generation
    }
    for (const match of text.matchAll(re)) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity as GuardrailFinding['severity'],
        message: rule.message,
        remedy: rule.remedy ?? undefined,
        excerpt: match[0].slice(0, 80),
        offset: match.index,
      })
      break // one finding per rule keeps the reviewer's list readable
    }
  }
  return findings
}

export function checkBannedTerms(text: string, terms: string[]): GuardrailFinding[] {
  const findings: GuardrailFinding[] = []
  for (const term of terms) {
    if (!term.trim()) continue
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = text.match(re)
    if (m) {
      findings.push({
        ruleId: `banned:${term}`,
        ruleName: 'Banned term',
        severity: 'high',
        message: `"${m[0]}" is on the workspace banned-terms list.`,
        remedy: 'Remove or replace this word.',
        excerpt: m[0],
        offset: m.index,
      })
    }
  }
  return findings
}

export function checkDisclaimers(
  text: string,
  disclaimers: { text: string; channels: string[] }[],
  channel: string,
): GuardrailFinding[] {
  return disclaimers
    .filter((d) => d.channels.length === 0 || d.channels.includes(channel))
    .filter((d) => !text.toLowerCase().includes(d.text.toLowerCase().slice(0, 40)))
    .map((d) => ({
      ruleId: `disclaimer:${d.text.slice(0, 24)}`,
      ruleName: 'Required disclaimer missing',
      severity: 'high' as const,
      message: `This channel requires the disclaimer: "${d.text.slice(0, 80)}${d.text.length > 80 ? '…' : ''}"`,
      remedy: 'Append the disclaimer to the asset.',
    }))
}

/* ------------------------------------------------------- channel limits */

/**
 * Comparative advertising. Lawful in the UK, but only when the comparison is
 * verifiable, like for like and does not denigrate (CAP Code 3.33–3.44), and a
 * superlative needs evidence on file (3.7). A generator told about competitors
 * is told not to name them; this catches it when it does anyway, or when a
 * person adds a name by hand. Not a blocker: a substantiated comparison is
 * allowed, so the reviewer decides with the evidence in front of them.
 */
export function checkCompetitorMentions(text: string, names: readonly string[]): GuardrailFinding[] {
  const out: GuardrailFinding[] = []
  const seen = new Set<string>()
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const n = name.trim()
    if (n.length < 3) continue
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
    const m = text.match(re)
    if (!m || seen.has(m[2].toLowerCase())) continue
    // A shorter brand term inside a longer one already reported is the same mention.
    if ([...seen].some((s) => s.includes(m[2].toLowerCase()))) continue
    seen.add(m[2].toLowerCase())
    out.push({
      ruleId: `competitor:${n.toLowerCase()}`,
      ruleName: 'Names a competitor',
      severity: 'medium',
      message: `Mentions "${m[2]}", a tracked competitor. Comparative advertising must be verifiable, compare like with like and must not denigrate (CAP Code 3.33–3.44).`,
      remedy: 'Remove the name and describe how you work instead, or attach the evidence for the reviewer.',
      excerpt: m[2],
      offset: (m.index ?? 0) + m[1].length,
    })
  }
  const comparative = text.match(
    /\b(cheaper|faster|better|quicker|lower[- ]cost|more affordable) than (other|any|the rest|our competitors|competitors|others)\b|\b(the best|number one|no\.? ?1|market[- ]leading|unbeatable|best[- ]value|lowest prices?)\b/i,
  )
  if (comparative) {
    out.push({
      ruleId: 'competitor:comparative',
      ruleName: 'Comparative or superlative claim',
      severity: 'low',
      message: `"${comparative[0]}" is a comparative or superlative claim. It must be objectively verifiable, with evidence held before publishing (CAP Code 3.7, 3.33).`,
      remedy: 'Make it specific and provable, or remove it.',
      excerpt: comparative[0],
      offset: comparative.index,
    })
  }
  return out
}

export const CHANNEL_LIMITS: Record<string, { field: keyof AssetBody; max: number; label: string }[]> = {
  email: [
    { field: 'subject', max: 60, label: 'Subject line' },
    { field: 'preheader', max: 110, label: 'Preheader' },
  ],
  x: [{ field: 'body', max: 280, label: 'Post' }],
  linkedin: [{ field: 'body', max: 3000, label: 'Post' }],
  instagram: [{ field: 'body', max: 2200, label: 'Caption' }],
  facebook: [{ field: 'body', max: 2000, label: 'Post' }],
  google_ads: [
    { field: 'headline', max: 30, label: 'Headline' },
    { field: 'body', max: 90, label: 'Description' },
  ],
  meta_ads: [
    { field: 'headline', max: 40, label: 'Headline' },
    { field: 'body', max: 125, label: 'Primary text' },
  ],
  sms: [{ field: 'body', max: 160, label: 'Message' }],
  push: [
    { field: 'headline', max: 50, label: 'Title' },
    { field: 'body', max: 150, label: 'Body' },
  ],
}

export function checkChannelLimits(body: AssetBody, channel: string): GuardrailFinding[] {
  const limits = CHANNEL_LIMITS[channel] ?? []
  const findings: GuardrailFinding[] = []
  for (const limit of limits) {
    const value = body[limit.field]
    if (typeof value !== 'string') continue
    if (value.length > limit.max) {
      findings.push({
        ruleId: `limit:${channel}:${String(limit.field)}`,
        ruleName: 'Channel limit exceeded',
        severity: 'medium',
        message: `${limit.label} is ${value.length} characters; ${channel} allows ${limit.max}.`,
        remedy: `Trim by ${value.length - limit.max} characters.`,
        excerpt: value.slice(limit.max, limit.max + 40),
      })
    }
  }
  return findings
}

/* ------------------------------------------------------------- scoring */

const SEVERITY_PENALTY = { high: 34, medium: 14, low: 5 } as const

export type ScoreInput = {
  body: AssetBody
  channel: string
  profile: Pick<
    BrandProfile,
    | 'tone'
    | 'doList'
    | 'dontList'
    | 'bannedTerms'
    | 'preferredTerms'
    | 'requiredDisclaimers'
    | 'readingLevelMax'
    | 'maxExclamations'
    | 'passThreshold'
  >
  legalRules: LegalRule[]
  /**
   * Brand names of tracked competitors. When given, copy that names one, or
   * makes a comparative or superlative claim, is flagged for the reviewer.
   */
  competitorNames?: readonly string[]
}

export function scoreAsset({ body, channel, profile, legalRules, competitorNames }: ScoreInput): ScoreDetail {
  const text = flattenBody(body)

  /* -- compliance ------------------------------------------------------- */
  const findings: GuardrailFinding[] = [
    ...checkLegal(text, legalRules, channel),
    ...checkBannedTerms(text, profile.bannedTerms),
    ...checkDisclaimers(text, profile.requiredDisclaimers, channel),
    ...checkChannelLimits(body, channel),
    ...(competitorNames?.length ? checkCompetitorMentions(text, competitorNames) : []),
  ]

  for (const swap of profile.preferredTerms) {
    const re = new RegExp(`\\b${swap.avoid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = text.match(re)
    if (m) {
      findings.push({
        ruleId: `preferred:${swap.avoid}`,
        ruleName: 'Preferred wording',
        severity: 'low',
        message: `Use "${swap.use}" rather than "${swap.avoid}".`,
        remedy: `Replace "${m[0]}" with "${swap.use}".`,
        excerpt: m[0],
        offset: m.index,
      })
    }
  }

  const exclamations = (text.match(/!/g) ?? []).length
  if (exclamations > profile.maxExclamations) {
    findings.push({
      ruleId: 'style:exclamations',
      ruleName: 'Punctuation',
      severity: 'low',
      message: `${exclamations} exclamation marks; the brand allows ${profile.maxExclamations}.`,
      remedy: 'Remove the extra exclamation marks.',
    })
  }

  const compliancePenalty = findings.reduce((a, f) => a + SEVERITY_PENALTY[f.severity], 0)
  const complianceScore = Math.max(0, 100 - compliancePenalty)

  /* -- brand voice ------------------------------------------------------ */
  const estimated = estimateTone(text)
  const axes = Object.keys(profile.tone) as (keyof ToneAxis)[]
  const deltas: Record<string, number> = {}
  let toneCost = 0
  for (const axis of axes) {
    const delta = Math.abs(estimated[axis] - profile.tone[axis])
    deltas[axis] = estimated[axis]
    // Tolerance band of 12 points; beyond that it costs.
    toneCost += Math.max(0, delta - 12)
  }
  const toneScore = Math.max(0, 100 - toneCost / axes.length / 0.6)

  const notes: string[] = []
  for (const axis of axes) {
    const delta = estimated[axis] - profile.tone[axis]
    if (Math.abs(delta) > 18) {
      notes.push(
        `${axis[0].toUpperCase()}${axis.slice(1)} reads ${delta > 0 ? 'higher' : 'lower'} than the profile (${estimated[axis]} vs target ${profile.tone[axis]}).`,
      )
    }
  }

  const lower = text.toLowerCase()
  let guidanceScore = 100
  for (const dont of profile.dontList) {
    const probe = dont.toLowerCase().split(/\s+/).slice(0, 3).join(' ')
    if (probe && lower.includes(probe)) {
      guidanceScore -= 12
      notes.push(`Conflicts with a "don't" rule: ${dont}`)
    }
  }
  const doHits = profile.doList.filter((d) => {
    const probe = d.toLowerCase().split(/\s+/).slice(0, 3).join(' ')
    return probe && lower.includes(probe)
  }).length
  if (profile.doList.length > 0) {
    guidanceScore = Math.min(100, guidanceScore + Math.min(8, doHits * 4))
  }
  guidanceScore = Math.max(0, guidanceScore)

  const brandScore = Math.round(toneScore * 0.62 + guidanceScore * 0.38)

  /* -- readability ------------------------------------------------------ */
  const { grade } = readability(text)
  const over = Math.max(0, grade - profile.readingLevelMax)
  const readabilityScore = Math.max(0, Math.round(100 - over * 11))

  /* -- composite -------------------------------------------------------- */
  const composite = Math.round(brandScore * 0.4 + complianceScore * 0.45 + readabilityScore * 0.15)
  const hasBlocker = findings.some((f) => f.severity === 'high')

  return {
    brand: { score: brandScore, axes: deltas, notes },
    compliance: { score: complianceScore, findings },
    readability: { score: readabilityScore, grade },
    composite,
    passed: composite >= profile.passThreshold && !hasBlocker,
    evaluatedAt: new Date().toISOString(),
  }
}

/** Human-readable one-liner for lists and notifications. */
export function scoreSummary(detail: ScoreDetail): string {
  if (detail.passed) return `Passed at ${detail.composite}/100`
  const blocker = detail.compliance.findings.find((f) => f.severity === 'high')
  if (blocker) return `Blocked — ${blocker.ruleName}`
  return `${detail.composite}/100 — below threshold`
}

export function scoreBand(score: number): 'strong' | 'ok' | 'weak' {
  if (score >= 85) return 'strong'
  if (score >= 70) return 'ok'
  return 'weak'
}
