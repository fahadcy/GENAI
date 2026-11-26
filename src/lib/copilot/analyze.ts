import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalRequests,
  assets,
  campaigns,
  metricFacts,
  recommendations,
  scheduleItems,
  segments,
  type RecommendationAction,
} from '@/lib/db/schema'
import { suggestSendTime, fmtHour, DAY_NAMES } from '@/lib/scheduler/sendtime'

/**
 * The copilot's analysis pass (PRD 4.1 idea #4, CC-3, PF-3, PF-4).
 *
 * Everything here is computed from the workspace's own metric rows — no model
 * call is required to *find* a problem, which is what lets each recommendation
 * carry hard evidence a marketer can check. The model is used later, only to
 * write the replacement asset once a human accepts the recommendation.
 *
 * Every recommendation states: what to do, why (with numbers), what it should
 * move, and how confident we are.
 */

export type Draft = {
  type: string
  title: string
  rationale: string
  evidence: { label: string; value: string }[]
  expectedEffect: { metric: string; delta: string; confidence: number; horizonDays: number }
  priorityScore: number
  subjectType: string | null
  subjectId: string | null
  campaignId: string | null
  action: RecommendationAction
}

export async function analyzeWorkspace(workspaceId: string): Promise<Draft[]> {
  const drafts = (
    await Promise.all([
      detectCreativeFatigue(workspaceId),
      detectBudgetMisallocation(workspaceId),
      detectSendTimeDrift(workspaceId),
      detectOverdueApprovals(workspaceId),
      detectSegmentOpportunity(workspaceId),
    ])
  ).flat()

  return drafts.sort((a, b) => b.priorityScore - a.priorityScore)
}

/** Persist fresh recommendations, leaving already-applied history intact. */
export async function refreshRecommendations(workspaceId: string): Promise<number> {
  const drafts = await analyzeWorkspace(workspaceId)

  await db
    .delete(recommendations)
    .where(and(eq(recommendations.workspaceId, workspaceId), eq(recommendations.status, 'open')))

  if (drafts.length === 0) return 0

  await db.insert(recommendations).values(
    drafts.map((d) => ({
      workspaceId,
      type: d.type,
      title: d.title,
      rationale: d.rationale,
      evidence: d.evidence,
      expectedEffect: d.expectedEffect,
      priorityScore: d.priorityScore,
      subjectType: d.subjectType,
      subjectId: d.subjectId,
      campaignId: d.campaignId,
      action: d.action,
      status: 'open' as const,
    })),
  )
  return drafts.length
}

/* --------------------------------------------------- 1. creative fatigue */

/**
 * Fatigue = a live asset whose click-through rate over the last 3 days has
 * dropped materially against its own earlier baseline, with enough volume for
 * the drop to mean something.
 */
async function detectCreativeFatigue(workspaceId: string): Promise<Draft[]> {
  const rows = await db
    .select({
      assetId: metricFacts.assetId,
      title: assets.title,
      channel: metricFacts.channel,
      campaignId: metricFacts.campaignId,
      briefId: assets.briefId,
      recentImpr: sql<number>`sum(${metricFacts.impressions}) filter (where ${metricFacts.day} >= current_date - 3)::int`,
      recentClicks: sql<number>`sum(${metricFacts.clicks}) filter (where ${metricFacts.day} >= current_date - 3)::int`,
      baseImpr: sql<number>`sum(${metricFacts.impressions}) filter (where ${metricFacts.day} < current_date - 3 and ${metricFacts.day} >= current_date - 17)::int`,
      baseClicks: sql<number>`sum(${metricFacts.clicks}) filter (where ${metricFacts.day} < current_date - 3 and ${metricFacts.day} >= current_date - 17)::int`,
      spend: sql<number>`sum(${metricFacts.spend}) filter (where ${metricFacts.day} >= current_date - 7)::float`,
    })
    .from(metricFacts)
    .innerJoin(assets, eq(assets.id, metricFacts.assetId))
    .where(
      and(
        eq(metricFacts.workspaceId, workspaceId),
        eq(assets.status, 'published'),
        sql`${metricFacts.day} >= current_date - 17`,
      ),
    )
    .groupBy(metricFacts.assetId, assets.title, metricFacts.channel, metricFacts.campaignId, assets.briefId)

  const drafts: Draft[] = []
  for (const r of rows) {
    if (r.recentImpr < 400 || r.baseImpr < 800) continue
    const recentCtr = r.recentClicks / r.recentImpr
    const baseCtr = r.baseClicks / r.baseImpr
    if (baseCtr <= 0) continue
    const drop = 1 - recentCtr / baseCtr
    if (drop < 0.25) continue

    const wastedSpend = r.spend * drop
    drafts.push({
      type: 'creative_fatigue',
      title: `Retire "${r.title}" — engagement down ${Math.round(drop * 100)}%`,
      rationale:
        `Click-through on this ${r.channel} asset has fallen from ${(baseCtr * 100).toFixed(2)}% to ` +
        `${(recentCtr * 100).toFixed(2)}% over the last three days, on ${r.recentImpr.toLocaleString()} impressions. ` +
        `That pattern is creative fatigue rather than noise: the audience has seen it enough. ` +
        `Pausing it and running a fresh angle from the same brief typically recovers most of the lost rate.`,
      evidence: [
        { label: 'Baseline CTR (14 days)', value: `${(baseCtr * 100).toFixed(2)}%` },
        { label: 'Last 3 days CTR', value: `${(recentCtr * 100).toFixed(2)}%` },
        { label: 'Recent impressions', value: r.recentImpr.toLocaleString() },
        { label: 'Spend at reduced efficiency', value: `£${Math.round(wastedSpend).toLocaleString()}/wk` },
      ],
      expectedEffect: {
        metric: 'Click-through rate',
        delta: `+${Math.round(drop * 70)}% recovery`,
        confidence: Math.min(0.86, 0.5 + drop),
        horizonDays: 7,
      },
      priorityScore: drop * 60 + Math.min(40, wastedSpend / 25),
      subjectType: 'asset',
      subjectId: r.assetId,
      campaignId: r.campaignId,
      action: { kind: 'generate_replacement', assetId: r.assetId!, briefId: r.briefId },
    })
  }
  return drafts
}

/* ----------------------------------------------- 2. budget misallocation */

/**
 * Within a campaign, compare cost per conversion by channel. If the best
 * channel is materially cheaper than the worst *and* both have credible volume,
 * propose a bounded shift.
 */
async function detectBudgetMisallocation(workspaceId: string): Promise<Draft[]> {
  const rows = await db
    .select({
      campaignId: metricFacts.campaignId,
      campaignName: campaigns.name,
      channel: metricFacts.channel,
      spend: sql<number>`sum(${metricFacts.spend})::float`,
      conversions: sql<number>`sum(${metricFacts.conversions})::int`,
      signups: sql<number>`sum(${metricFacts.signups})::int`,
    })
    .from(metricFacts)
    .innerJoin(campaigns, eq(campaigns.id, metricFacts.campaignId))
    .where(
      and(
        eq(metricFacts.workspaceId, workspaceId),
        eq(campaigns.status, 'active'),
        sql`${metricFacts.day} >= current_date - 14`,
      ),
    )
    .groupBy(metricFacts.campaignId, campaigns.name, metricFacts.channel)

  const byCampaign = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!r.campaignId) continue
    const list = byCampaign.get(r.campaignId) ?? []
    list.push(r)
    byCampaign.set(r.campaignId, list)
  }

  const drafts: Draft[] = []
  for (const [campaignId, channels] of byCampaign) {
    const viable = channels.filter((c) => c.spend > 150 && c.conversions >= 3)
    if (viable.length < 2) continue

    const withCpa = viable.map((c) => ({ ...c, cpa: c.spend / c.conversions }))
    withCpa.sort((a, b) => a.cpa - b.cpa)
    const best = withCpa[0]
    const worst = withCpa[withCpa.length - 1]
    if (worst.cpa < best.cpa * 1.6) continue

    // Move a quarter of the weak channel's spend — bounded, reversible, and
    // small enough that being wrong is cheap.
    const amount = Math.round((worst.spend * 0.25) / 10) * 10
    if (amount < 50) continue
    const extraConversions = amount / best.cpa - amount / worst.cpa

    drafts.push({
      type: 'budget_shift',
      title: `Move £${amount.toLocaleString()} from ${label(worst.channel)} to ${label(best.channel)}`,
      rationale:
        `In "${worst.campaignName}" over the last 14 days, ${label(best.channel)} is acquiring at £${best.cpa.toFixed(0)} ` +
        `per conversion while ${label(worst.channel)} is at £${worst.cpa.toFixed(0)} — ${(worst.cpa / best.cpa).toFixed(1)}× more expensive. ` +
        `Both have enough volume for the difference to be real (${best.conversions} and ${worst.conversions} conversions). ` +
        `Shifting a quarter of the weaker channel's spend keeps the test running while buying more of what works.`,
      evidence: [
        { label: `${label(best.channel)} CPA`, value: `£${best.cpa.toFixed(0)} (${best.conversions} conv.)` },
        { label: `${label(worst.channel)} CPA`, value: `£${worst.cpa.toFixed(0)} (${worst.conversions} conv.)` },
        { label: 'Amount to move', value: `£${amount.toLocaleString()}` },
        { label: 'Window', value: 'Last 14 days' },
      ],
      expectedEffect: {
        metric: 'Conversions',
        delta: `+${Math.max(1, Math.round(extraConversions))} per 14 days`,
        confidence: Math.min(0.82, 0.42 + Math.min(best.conversions, worst.conversions) / 60),
        horizonDays: 14,
      },
      priorityScore: Math.min(95, (worst.cpa / best.cpa) * 18 + amount / 40),
      subjectType: 'campaign',
      subjectId: campaignId,
      campaignId,
      action: {
        kind: 'shift_budget',
        fromChannel: worst.channel,
        toChannel: best.channel,
        amount,
        campaignId,
      },
    })
  }
  return drafts
}

/* ------------------------------------------------- 3. send-time drift */

async function detectSendTimeDrift(workspaceId: string): Promise<Draft[]> {
  const upcoming = await db
    .select({
      id: scheduleItems.id,
      assetId: scheduleItems.assetId,
      title: assets.title,
      channel: scheduleItems.channel,
      segmentId: scheduleItems.segmentId,
      scheduledAt: scheduleItems.scheduledAt,
      source: scheduleItems.sendTimeSource,
      campaignId: scheduleItems.campaignId,
    })
    .from(scheduleItems)
    .innerJoin(assets, eq(assets.id, scheduleItems.assetId))
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        eq(scheduleItems.status, 'scheduled'),
        eq(scheduleItems.sendTimeSource, 'manual'),
        sql`${scheduleItems.scheduledAt} > now() + interval '12 hours'`,
      ),
    )
    .orderBy(scheduleItems.scheduledAt)
    .limit(12)

  const drafts: Draft[] = []
  for (const item of upcoming) {
    const suggestion = await suggestSendTime({
      workspaceId,
      channel: item.channel,
      segmentId: item.segmentId,
      notBefore: new Date(Date.now() + 6 * 3_600_000),
    })
    const currentHour = item.scheduledAt.getHours()
    if (currentHour === suggestion.hour && item.scheduledAt.getDay() === suggestion.weekday) continue
    if (suggestion.predictedLift < 0.12) continue

    const target = new Date(item.scheduledAt)
    target.setHours(suggestion.hour, 0, 0, 0)
    // Keep it on the same day unless the weekday is clearly better.
    if (target.getTime() < Date.now() + 3_600_000) target.setDate(target.getDate() + 1)

    drafts.push({
      type: 'send_time',
      title: `Move "${item.title}" to ${fmtHour(suggestion.hour)}`,
      rationale:
        `This ${label(item.channel)} send is set for ${fmtHour(currentHour)} on ${DAY_NAMES[item.scheduledAt.getDay()]}, ` +
        `which was chosen manually. ${suggestion.rationale} Moving it is a one-field change and fully reversible.`,
      evidence: [
        { label: 'Currently', value: `${DAY_NAMES[item.scheduledAt.getDay()]} ${fmtHour(currentHour)}` },
        { label: 'Suggested', value: `${DAY_NAMES[target.getDay()]} ${fmtHour(suggestion.hour)}` },
        { label: 'Modelled uplift', value: `+${Math.round(suggestion.predictedLift * 100)}%` },
      ],
      expectedEffect: {
        metric: 'Open / engagement rate',
        delta: `+${Math.round(suggestion.predictedLift * 100)}%`,
        confidence: 0.55 + Math.min(0.25, suggestion.predictedLift),
        horizonDays: 3,
      },
      priorityScore: suggestion.predictedLift * 45,
      subjectType: 'schedule_item',
      subjectId: item.id,
      campaignId: item.campaignId,
      action: { kind: 'reschedule', scheduleItemId: item.id, toIso: target.toISOString() },
    })
  }
  return drafts
}

/* ---------------------------------------------- 4. approval bottleneck */

async function detectOverdueApprovals(workspaceId: string): Promise<Draft[]> {
  const overdue = await db
    .select({
      id: approvalRequests.id,
      subjectId: approvalRequests.subjectId,
      title: assets.title,
      dueAt: approvalRequests.dueAt,
      requestedAt: approvalRequests.requestedAt,
      campaignId: assets.campaignId,
    })
    .from(approvalRequests)
    .innerJoin(assets, eq(assets.id, approvalRequests.subjectId))
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.status, 'pending'),
        sql`${approvalRequests.dueAt} < now()`,
      ),
    )
    .orderBy(approvalRequests.dueAt)
    .limit(6)

  return overdue.map((r) => {
    const hoursLate = Math.round((Date.now() - (r.dueAt?.getTime() ?? Date.now())) / 3_600_000)
    const waiting = Math.round((Date.now() - r.requestedAt.getTime()) / 3_600_000)
    return {
      type: 'approval_sla',
      title: `Chase sign-off on "${r.title}" — ${hoursLate}h overdue`,
      rationale:
        `This has been waiting ${waiting} hours, which is ${hoursLate} hours past its SLA. ` +
        `Approval latency is the single largest contributor to campaign turnaround, and every hour here ` +
        `pushes the launch date directly. A reminder goes to the current step's approvers only.`,
      evidence: [
        { label: 'Waiting', value: `${waiting}h` },
        { label: 'Past SLA by', value: `${hoursLate}h` },
      ],
      expectedEffect: {
        metric: 'Average approval time',
        delta: `−${Math.min(40, hoursLate * 2)}%`,
        confidence: 0.6,
        horizonDays: 1,
      },
      priorityScore: 30 + Math.min(45, hoursLate * 1.5),
      subjectType: 'approval_request',
      subjectId: r.id,
      campaignId: r.campaignId,
      action: { kind: 'nudge_approver', requestId: r.id } as RecommendationAction,
    }
  })
}

/* ------------------------------------------- 5. segment opportunity */

async function detectSegmentOpportunity(workspaceId: string): Promise<Draft[]> {
  const rows = await db
    .select({
      id: segments.id,
      name: segments.name,
      size: segments.estimatedSize,
      predicted: segments.predictedConversion,
      threshold: segments.similarityThreshold,
      sourceType: segments.sourceType,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}), 0)::int`,
    })
    .from(segments)
    .leftJoin(
      metricFacts,
      and(eq(metricFacts.segmentId, segments.id), sql`${metricFacts.day} >= current_date - 30`),
    )
    .where(and(eq(segments.workspaceId, workspaceId), eq(segments.sourceType, 'rule')))
    .groupBy(segments.id)

  const drafts: Draft[] = []
  for (const r of rows) {
    if (r.impressions < 500 || r.conversions < 5) continue
    const rate = r.conversions / r.impressions
    if (rate < 0.02) continue
    if (r.size > 4000) continue

    const expansion = Math.round(r.size * 1.8)
    drafts.push({
      type: 'segment_expansion',
      title: `Build a lookalike from "${r.name}"`,
      rationale:
        `"${r.name}" is converting at ${(rate * 100).toFixed(2)}% across ${r.impressions.toLocaleString()} impressions — ` +
        `well above the workspace average — but it only holds ${r.size.toLocaleString()} contacts, so it is capped on volume. ` +
        `A lookalike built from these contacts at a ${r.threshold.toFixed(2)} similarity threshold would reach roughly ` +
        `${expansion.toLocaleString()} more people with a similar profile.`,
      evidence: [
        { label: 'Conversion rate', value: `${(rate * 100).toFixed(2)}%` },
        { label: 'Current size', value: r.size.toLocaleString() },
        { label: 'Estimated expansion', value: `~${expansion.toLocaleString()} contacts` },
      ],
      expectedEffect: {
        metric: 'Reachable audience',
        delta: `+${expansion.toLocaleString()} contacts`,
        confidence: 0.58,
        horizonDays: 30,
      },
      priorityScore: rate * 900,
      subjectType: 'segment',
      subjectId: r.id,
      campaignId: null,
      action: { kind: 'expand_segment', segmentId: r.id, threshold: r.threshold },
    })
  }
  return drafts
}

/* -------------------------------------------------------------- shared */

function label(channel: string): string {
  const map: Record<string, string> = {
    email: 'Email', linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram',
    facebook: 'Facebook', blog: 'Blog', google_ads: 'Google Ads',
    meta_ads: 'Meta Ads', sms: 'SMS', push: 'Push', web: 'Web',
  }
  return map[channel] ?? channel
}

export const CHANNEL_LABEL = label

export async function openRecommendations(workspaceId: string, limit = 20) {
  return db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.workspaceId, workspaceId), eq(recommendations.status, 'open')))
    .orderBy(desc(recommendations.priorityScore))
    .limit(limit)
}

export async function recentlyApplied(workspaceId: string, limit = 10) {
  return db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.workspaceId, workspaceId),
        inArray(recommendations.status, ['applied', 'reverted']),
      ),
    )
    .orderBy(desc(recommendations.appliedAt))
    .limit(limit)
}
