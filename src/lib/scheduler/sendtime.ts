import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts, metricFacts, segmentMembers } from '@/lib/db/schema'

/**
 * Send-time optimisation (PRD SC-2).
 *
 * Two signals, combined and explained:
 *   1. When the contacts in this segment historically engage (their own
 *      `engagementHour`, weighted by engagement score) — the strongest signal
 *      and the one competitors' generic "best time to post" charts ignore.
 *   2. How this workspace's own past sends on this channel actually performed
 *      by hour and weekday.
 *
 * The output carries a rationale string because a recommendation the marketer
 * cannot interrogate is a recommendation they will not trust.
 */

export type SendTimeSuggestion = {
  /** 0-6, Monday = 1 to match ISO weekday used in the UI. */
  weekday: number
  hour: number
  score: number
  /** Predicted uplift vs. the workspace's average send slot. */
  predictedLift: number
  rationale: string
  distribution: { hour: number; weight: number }[]
}

/** Channel-level priors, used when a workspace has no history yet. */
const CHANNEL_PRIOR: Record<string, { hours: number[]; weekdays: number[] }> = {
  email: { hours: [8, 9, 10, 14, 15], weekdays: [2, 3, 4] },
  linkedin: { hours: [8, 9, 12, 17], weekdays: [2, 3, 4] },
  x: { hours: [9, 12, 15, 18], weekdays: [2, 3, 4, 5] },
  instagram: { hours: [11, 13, 19, 20], weekdays: [3, 4, 6] },
  facebook: { hours: [10, 13, 19], weekdays: [3, 4, 6] },
  google_ads: { hours: [9, 10, 11, 14], weekdays: [1, 2, 3, 4, 5] },
  meta_ads: { hours: [12, 18, 20], weekdays: [1, 2, 3, 4, 5, 6, 0] },
  sms: { hours: [10, 12, 17], weekdays: [2, 3, 4] },
  push: { hours: [8, 12, 18], weekdays: [1, 2, 3, 4, 5] },
  blog: { hours: [7, 9], weekdays: [2, 3] },
  web: { hours: [9], weekdays: [2] },
}

export async function suggestSendTime(args: {
  workspaceId: string
  channel: string
  segmentId?: string | null
  /** Earliest acceptable time; the suggestion is always at or after this. */
  notBefore?: Date
}): Promise<SendTimeSuggestion> {
  const notBefore = args.notBefore ?? new Date()
  const prior = CHANNEL_PRIOR[args.channel] ?? CHANNEL_PRIOR.email

  /* -- signal 1: audience engagement hours ------------------------------ */
  const hourWeights = new Array(24).fill(0)
  let audienceN = 0

  if (args.segmentId) {
    const rows = await db
      .select({
        hour: contacts.engagementHour,
        weight: sql<number>`sum(${contacts.engagementScore})::float`,
        n: sql<number>`count(*)::int`,
      })
      .from(segmentMembers)
      // Scoped through contacts, not just the segment id: the caller supplies
      // that id, and without this predicate another workspace's audience size
      // and engagement profile come back in the rationale string.
      .innerJoin(
        contacts,
        and(eq(contacts.id, segmentMembers.contactId), eq(contacts.workspaceId, args.workspaceId)),
      )
      .where(and(eq(segmentMembers.segmentId, args.segmentId), sql`${contacts.engagementHour} is not null`))
      .groupBy(contacts.engagementHour)

    for (const r of rows) {
      if (r.hour === null) continue
      hourWeights[r.hour] += r.weight
      audienceN += r.n
    }
  }

  /* -- signal 2: this workspace's own history --------------------------- */
  const history = await db
    .select({
      dow: sql<number>`extract(dow from ${metricFacts.day})::int`,
      opens: sql<number>`sum(${metricFacts.opens})::int`,
      clicks: sql<number>`sum(${metricFacts.clicks})::int`,
      impressions: sql<number>`sum(${metricFacts.impressions})::int`,
      conversions: sql<number>`sum(${metricFacts.conversions})::int`,
    })
    .from(metricFacts)
    .where(
      and(
        eq(metricFacts.workspaceId, args.workspaceId),
        eq(metricFacts.channel, args.channel as 'email'),
        sql`${metricFacts.day} >= current_date - interval '90 days'`,
      ),
    )
    .groupBy(sql`extract(dow from ${metricFacts.day})`)

  const dowScore = new Array(7).fill(0)
  let historyN = 0
  for (const h of history) {
    const denom = h.impressions || h.opens || 1
    dowScore[h.dow] = (h.clicks + h.conversions * 3) / denom
    historyN += denom
  }

  /* -- combine ---------------------------------------------------------- */
  const audienceTotal = hourWeights.reduce((a, b) => a + b, 0)
  const useAudience = audienceTotal > 0 && audienceN >= 10

  const hourScore = new Array(24).fill(0)
  for (let h = 0; h < 24; h++) {
    const audiencePart = useAudience ? hourWeights[h] / audienceTotal : 0
    const priorPart = prior.hours.includes(h) ? 1 / prior.hours.length : 0.01
    hourScore[h] = useAudience ? audiencePart * 0.7 + priorPart * 0.3 : priorPart
  }

  const bestHour = hourScore.indexOf(Math.max(...hourScore))

  const weekdayScore = new Array(7).fill(0)
  for (let d = 0; d < 7; d++) {
    const priorPart = prior.weekdays.includes(d) ? 1 : 0.25
    const histPart = historyN > 0 ? dowScore[d] / (Math.max(...dowScore) || 1) : 0
    weekdayScore[d] = historyN > 0 ? priorPart * 0.45 + histPart * 0.55 : priorPart
  }
  const bestWeekday = weekdayScore.indexOf(Math.max(...weekdayScore))

  /* -- project forward to a concrete slot ------------------------------- */
  const target = new Date(notBefore)
  target.setMinutes(0, 0, 0)
  for (let i = 0; i < 14; i++) {
    const candidate = new Date(target)
    candidate.setDate(target.getDate() + i)
    candidate.setHours(bestHour, 0, 0, 0)
    if (candidate.getDay() === bestWeekday && candidate.getTime() > notBefore.getTime()) {
      return build(candidate, bestHour, hourScore, useAudience, audienceN, historyN, args.channel)
    }
  }
  // Fallback: the next occurrence of the best hour.
  const fallback = new Date(notBefore)
  fallback.setHours(bestHour, 0, 0, 0)
  if (fallback.getTime() <= notBefore.getTime()) fallback.setDate(fallback.getDate() + 1)
  return build(fallback, bestHour, hourScore, useAudience, audienceN, historyN, args.channel)
}

function build(
  date: Date,
  hour: number,
  hourScore: number[],
  useAudience: boolean,
  audienceN: number,
  historyN: number,
  channel: string,
): SendTimeSuggestion {
  const avg = hourScore.reduce((a, b) => a + b, 0) / 24
  const lift = avg > 0 ? hourScore[hour] / avg - 1 : 0
  const capped = Math.max(0, Math.min(0.62, lift))

  const rationale = useAudience
    ? `${audienceN.toLocaleString()} contacts in this segment engage most around ${fmtHour(hour)}${
        historyN > 0 ? `, and ${DAY_NAMES[date.getDay()]} is your strongest weekday on ${channel} over the last 90 days` : ''
      }.`
    : `No engagement history for this segment yet, so this uses the ${channel} baseline (${DAY_NAMES[date.getDay()]} ${fmtHour(hour)}). Accuracy improves after the first few sends.`

  return {
    weekday: date.getDay(),
    hour,
    score: hourScore[hour],
    predictedLift: Math.round(capped * 1000) / 1000,
    rationale,
    distribution: hourScore.map((weight, h) => ({ hour: h, weight })),
  }
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function fmtHour(h: number): string {
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}
