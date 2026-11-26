import 'server-only'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalRequests,
  assets,
  auditEvents,
  campaigns,
  metricFacts,
  scheduleItems,
  users,
  type Channel,
} from '@/lib/db/schema'
import type { Stage } from '@/components/domain'

/** CC-2: the four portfolio KPIs, each with a trailing comparison. */
export async function portfolioKpis(workspaceId: string) {
  const [row] = await db
    .select({
      activeCampaigns: sql<number>`(select count(*) from campaigns where workspace_id = ${workspaceId} and status = 'active')::int`,
      awaitingReview: sql<number>`(select count(*) from approval_requests where workspace_id = ${workspaceId} and status = 'pending')::int`,
      overdueReview: sql<number>`(select count(*) from approval_requests where workspace_id = ${workspaceId} and status = 'pending' and due_at < now())::int`,
      scheduled30: sql<number>`(select count(*) from schedule_items where workspace_id = ${workspaceId} and status = 'scheduled' and scheduled_at between now() and now() + interval '30 days')::int`,
      deadLetter: sql<number>`(select count(*) from schedule_items where workspace_id = ${workspaceId} and status = 'dead_letter')::int`,
      avgApprovalMs: sql<number>`(select avg(resolution_ms) from approval_requests where workspace_id = ${workspaceId} and resolution_ms is not null and completed_at >= now() - interval '30 days')::float`,
      prevAvgApprovalMs: sql<number>`(select avg(resolution_ms) from approval_requests where workspace_id = ${workspaceId} and resolution_ms is not null and completed_at >= now() - interval '60 days' and completed_at < now() - interval '30 days')::float`,
      passRate: sql<number>`(select avg(case when (score_detail->>'passed')::boolean then 1.0 else 0.0 end) from assets where workspace_id = ${workspaceId} and score_detail is not null)::float`,
      assetsThisWeek: sql<number>`(select count(*) from assets where workspace_id = ${workspaceId} and created_at >= now() - interval '7 days')::int`,
      assetsPrevWeek: sql<number>`(select count(*) from assets where workspace_id = ${workspaceId} and created_at >= now() - interval '14 days' and created_at < now() - interval '7 days')::int`,
    })
    .from(sql`(select 1) as _`)

  return {
    activeCampaigns: Number(row?.activeCampaigns ?? 0),
    awaitingReview: Number(row?.awaitingReview ?? 0),
    overdueReview: Number(row?.overdueReview ?? 0),
    scheduled30: Number(row?.scheduled30 ?? 0),
    deadLetter: Number(row?.deadLetter ?? 0),
    avgApprovalMs: row?.avgApprovalMs ?? null,
    prevAvgApprovalMs: row?.prevAvgApprovalMs ?? null,
    passRate: row?.passRate ?? null,
    assetsThisWeek: Number(row?.assetsThisWeek ?? 0),
    assetsPrevWeek: Number(row?.assetsPrevWeek ?? 0),
  }
}

/** CC-1: the live pipeline, per campaign, across the five stages. */
export type PipelineRow = {
  campaignId: string
  campaignName: string
  status: string
  ownerName: string | null
  ownerHue: number | null
  channels: string[]
  counts: Record<Stage, number>
  total: number
  blocked: number
}

export async function livePipeline(
  workspaceId: string,
  filters: { campaignId?: string; ownerId?: string; channel?: string } = {},
): Promise<PipelineRow[]> {
  const conditions = [eq(assets.workspaceId, workspaceId)]
  if (filters.channel) conditions.push(eq(assets.channel, filters.channel as Channel))
  if (filters.campaignId) conditions.push(eq(assets.campaignId, filters.campaignId))

  const rows = await db
    .select({
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      status: campaigns.status,
      channels: campaigns.channels,
      ownerName: users.name,
      ownerHue: users.avatarHue,
      stage: assets.stage,
      assetStatus: assets.status,
      n: sql<number>`count(*)::int`,
    })
    .from(assets)
    .innerJoin(campaigns, eq(campaigns.id, assets.campaignId))
    .leftJoin(users, eq(users.id, campaigns.ownerId))
    .where(and(...conditions))
    .groupBy(campaigns.id, campaigns.name, campaigns.status, campaigns.channels, users.name, users.avatarHue, assets.stage, assets.status)

  const map = new Map<string, PipelineRow>()
  for (const r of rows) {
    let entry = map.get(r.campaignId)
    if (!entry) {
      entry = {
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        status: r.status,
        ownerName: r.ownerName,
        ownerHue: r.ownerHue,
        channels: r.channels,
        counts: { generate: 0, review: 0, approve: 0, publish: 0, monitor: 0 },
        total: 0,
        blocked: 0,
      }
      map.set(r.campaignId, entry)
    }
    entry.counts[r.stage as Stage] += r.n
    entry.total += r.n
    if (r.assetStatus === 'changes_requested') entry.blocked += r.n
  }

  return [...map.values()].sort((a, b) => b.total - a.total)
}

/** The "what needs me" list — role-aware (CC-4). */
export async function attentionItems(workspaceId: string, userId: string, role: string) {
  const pending = await db
    .select({
      requestId: approvalRequests.id,
      assetId: assets.id,
      title: assets.title,
      channel: assets.channel,
      dueAt: approvalRequests.dueAt,
      requestedAt: approvalRequests.requestedAt,
      currentStep: approvalRequests.currentStep,
      chainName: approvalChains.name,
      steps: approvalChains.steps,
      composite: assets.compositeScore,
    })
    .from(approvalRequests)
    .innerJoin(assets, eq(assets.id, approvalRequests.subjectId))
    .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, 'pending')))
    .orderBy(approvalRequests.dueAt)
    .limit(8)

  return pending.map((p) => {
    const step = p.steps[p.currentStep]
    const mine = role === 'owner' || step?.role === role || Boolean(step?.approverIds?.includes(userId))
    return {
      ...p,
      stepName: step?.name ?? 'Review',
      mine,
      overdue: p.dueAt ? p.dueAt.getTime() < Date.now() : false,
    }
  })
}

/** Recent activity straight off the audit trail — one feed, nothing invented. */
export async function recentActivity(workspaceId: string, limit = 12) {
  return db
    .select({
      id: auditEvents.id,
      seq: auditEvents.seq,
      action: auditEvents.action,
      summary: auditEvents.summary,
      subjectType: auditEvents.subjectType,
      subjectId: auditEvents.subjectId,
      actorType: auditEvents.actorType,
      actorName: users.name,
      actorHue: users.avatarHue,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(desc(auditEvents.seq))
    .limit(limit)
}

/** Next few sends across every channel. */
export async function upcomingSends(workspaceId: string, limit = 6) {
  return db
    .select({
      id: scheduleItems.id,
      scheduledAt: scheduleItems.scheduledAt,
      channel: scheduleItems.channel,
      status: scheduleItems.status,
      source: scheduleItems.sendTimeSource,
      predictedLift: scheduleItems.predictedLift,
      title: assets.title,
      assetId: assets.id,
      campaignName: campaigns.name,
    })
    .from(scheduleItems)
    .innerJoin(assets, eq(assets.id, scheduleItems.assetId))
    .leftJoin(campaigns, eq(campaigns.id, scheduleItems.campaignId))
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        inArray(scheduleItems.status, ['scheduled', 'failed']),
        gte(scheduleItems.scheduledAt, new Date(Date.now() - 3_600_000)),
      ),
    )
    .orderBy(scheduleItems.scheduledAt)
    .limit(limit)
}

/** Headline results for the last 30 days, with the prior 30 for comparison. */
export async function headlineResults(workspaceId: string) {
  const [row] = await db
    .select({
      signups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${metricFacts.day} >= current_date - 30), 0)::int`,
      prevSignups: sql<number>`coalesce(sum(${metricFacts.signups}) filter (where ${metricFacts.day} >= current_date - 60 and ${metricFacts.day} < current_date - 30), 0)::int`,
      spend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${metricFacts.day} >= current_date - 30), 0)::float`,
      prevSpend: sql<number>`coalesce(sum(${metricFacts.spend}) filter (where ${metricFacts.day} >= current_date - 60 and ${metricFacts.day} < current_date - 30), 0)::float`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}) filter (where ${metricFacts.day} >= current_date - 30), 0)::int`,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}) filter (where ${metricFacts.day} >= current_date - 30), 0)::int`,
    })
    .from(metricFacts)
    .where(eq(metricFacts.workspaceId, workspaceId))

  const cps = row && row.signups > 0 ? row.spend / row.signups : null
  const prevCps = row && row.prevSignups > 0 ? row.prevSpend / row.prevSignups : null
  return { ...row, costPerSignup: cps, prevCostPerSignup: prevCps }
}
