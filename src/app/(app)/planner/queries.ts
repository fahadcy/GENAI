import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalRequests,
  assets,
  auditEvents,
  campaigns,
  campaignTemplates,
  memberships,
  metricFacts,
  planItems,
  segments,
  users,
} from '@/lib/db/schema'
import type {
  CampaignHeader,
  CampaignSummary,
  LinkedAsset,
  PickerOption,
  TaskView,
  TemplateView,
} from '@/components/planner/types'
import type { PlanStatus } from '@/components/planner/schedule'

/**
 * Read models for the Campaign Planner.
 *
 * Every figure on the surface is counted here against live rows — task
 * progress from `plan_items`, spend and goal attainment from `metric_facts`,
 * asset links from `assets.plan_item_id`. Nothing on the screen is a constant.
 */

/** The metric_facts column each campaign goal is measured against. */
const GOAL_COLUMN = {
  signups: metricFacts.signups,
  conversions: metricFacts.conversions,
  opens: metricFacts.opens,
  clicks: metricFacts.clicks,
  impressions: metricFacts.impressions,
} as const

/* ------------------------------------------------------------- portfolio */

export async function listCampaigns(workspaceId: string): Promise<CampaignSummary[]> {
  const rows = await db
    .select({
      c: campaigns,
      ownerName: users.name,
      ownerHue: users.avatarHue,
    })
    .from(campaigns)
    .leftJoin(users, eq(users.id, campaigns.ownerId))
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.status), desc(campaigns.startDate))

  if (rows.length === 0) return []
  const ids = rows.map((r) => r.c.id)

  // Two grouped queries rather than a per-campaign loop: the card grid is the
  // first thing every strategist opens, so it stays at three round trips no
  // matter how many campaigns the workspace holds.
  const taskRows = await db
    .select({
      campaignId: planItems.campaignId,
      phase: planItems.phase,
      status: planItems.status,
      atRisk: planItems.atRisk,
      isMilestone: planItems.isMilestone,
      dueDate: planItems.dueDate,
      sortIndex: planItems.sortIndex,
    })
    .from(planItems)
    .where(inArray(planItems.campaignId, ids))
    .orderBy(asc(planItems.sortIndex))

  const metricRows = await db
    .select({
      campaignId: metricFacts.campaignId,
      spend: sql<string>`coalesce(sum(${metricFacts.spend}), 0)`,
      signups: sql<number>`coalesce(sum(${metricFacts.signups}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}), 0)::int`,
      opens: sql<number>`coalesce(sum(${metricFacts.opens}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricFacts.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${metricFacts.impressions}), 0)::int`,
    })
    .from(metricFacts)
    .where(inArray(metricFacts.campaignId, ids))
    .groupBy(metricFacts.campaignId)

  const metricsById = new Map(metricRows.map((m) => [m.campaignId, m]))

  return rows.map((r) => {
    const tasks = taskRows.filter((t) => t.campaignId === r.c.id)
    const m = metricsById.get(r.c.id)
    const goal = r.c.goalMetric as keyof typeof GOAL_COLUMN
    const phases: string[] = []
    for (const t of tasks) if (!phases.includes(t.phase)) phases.push(t.phase)

    return {
      ...toHeader(r.c, r.ownerName, r.ownerHue),
      taskTotal: tasks.length,
      taskDone: tasks.filter((t) => t.status === 'done').length,
      taskBlocked: tasks.filter((t) => t.status === 'blocked').length,
      atRisk: tasks.filter((t) => t.atRisk && t.status !== 'done').length,
      milestoneDate: tasks.find((t) => t.isMilestone)?.dueDate ?? null,
      spend: Number(m?.spend ?? 0),
      goalActual: m && goal in m ? Number((m as Record<string, unknown>)[goal] ?? 0) : 0,
      phases,
    }
  })
}

function toHeader(
  c: typeof campaigns.$inferSelect,
  ownerName: string | null,
  ownerHue: number | null,
): CampaignHeader {
  return {
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.status,
    goalMetric: c.goalMetric,
    targetValue: c.targetValue,
    budget: Number(c.budget),
    startDate: c.startDate,
    endDate: c.endDate,
    channels: c.channels,
    ownerId: c.ownerId,
    ownerName,
    ownerHue,
    createdAt: c.createdAt.toISOString(),
  }
}

/* ---------------------------------------------------------------- detail */

export async function getCampaign(
  workspaceId: string,
  id: string,
): Promise<CampaignHeader | null> {
  const [row] = await db
    .select({ c: campaigns, ownerName: users.name, ownerHue: users.avatarHue })
    .from(campaigns)
    .leftJoin(users, eq(users.id, campaigns.ownerId))
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, id)))
    .limit(1)
  return row ? toHeader(row.c, row.ownerName, row.ownerHue) : null
}

export type CampaignResults = {
  spend: number
  goalActual: number
  conversions: number
  revenue: number
  firstDay: string | null
  lastDay: string | null
}

/** CP goal progress: attainment against `targetValue`, read from metric facts. */
export async function campaignResults(
  campaignId: string,
  goalMetric: string,
): Promise<CampaignResults> {
  const column = GOAL_COLUMN[goalMetric as keyof typeof GOAL_COLUMN] ?? metricFacts.conversions
  const [row] = await db
    .select({
      spend: sql<string>`coalesce(sum(${metricFacts.spend}), 0)`,
      revenue: sql<string>`coalesce(sum(${metricFacts.revenue}), 0)`,
      goalActual: sql<number>`coalesce(sum(${column}), 0)::int`,
      conversions: sql<number>`coalesce(sum(${metricFacts.conversions}), 0)::int`,
      firstDay: sql<string | null>`min(${metricFacts.day})`,
      lastDay: sql<string | null>`max(${metricFacts.day})`,
    })
    .from(metricFacts)
    .where(eq(metricFacts.campaignId, campaignId))

  return {
    spend: Number(row?.spend ?? 0),
    revenue: Number(row?.revenue ?? 0),
    goalActual: Number(row?.goalActual ?? 0),
    conversions: Number(row?.conversions ?? 0),
    firstDay: row?.firstDay ?? null,
    lastDay: row?.lastDay ?? null,
  }
}

/**
 * The plan itself, with every CP-3 link resolved in one pass: the assets each
 * task produced, the segment it targets and the approval chain that gates it.
 */
export async function getPlan(workspaceId: string, campaignId: string): Promise<TaskView[]> {
  const rows = await db
    .select({
      item: planItems,
      ownerName: users.name,
      ownerHue: users.avatarHue,
      ownerRole: memberships.role,
      segmentName: segments.name,
      segmentReach: segments.reachableSize,
      chainName: approvalChains.name,
      chainSteps: sql<number>`coalesce(jsonb_array_length(${approvalChains.steps}), 0)::int`,
    })
    .from(planItems)
    .leftJoin(users, eq(users.id, planItems.ownerId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, planItems.ownerId), eq(memberships.workspaceId, workspaceId)),
    )
    .leftJoin(segments, eq(segments.id, planItems.segmentId))
    .leftJoin(approvalChains, eq(approvalChains.id, planItems.approvalChainId))
    .where(and(eq(planItems.workspaceId, workspaceId), eq(planItems.campaignId, campaignId)))
    .orderBy(asc(planItems.sortIndex))

  if (rows.length === 0) return []
  const taskIds = rows.map((r) => r.item.id)

  const assetRows = await db
    .select({
      id: assets.id,
      planItemId: assets.planItemId,
      title: assets.title,
      channel: assets.channel,
      status: assets.status,
      compositeScore: assets.compositeScore,
    })
    .from(assets)
    .where(inArray(assets.planItemId, taskIds))
    .orderBy(asc(assets.title))

  // Outstanding approvals are counted against the assets a task produced, so a
  // gate reads as "2 waiting" rather than just naming the chain.
  const linkedAssetIds = assetRows.map((a) => a.id)
  const pendingRows =
    linkedAssetIds.length > 0
      ? await db
          .select({ subjectId: approvalRequests.subjectId })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.workspaceId, workspaceId),
              eq(approvalRequests.status, 'pending'),
              inArray(approvalRequests.subjectId, linkedAssetIds),
            ),
          )
      : []
  const pendingAssetIds = new Set(pendingRows.map((p) => p.subjectId))

  return rows.map((r) => {
    const mine = assetRows.filter((a) => a.planItemId === r.item.id)
    return {
      id: r.item.id,
      phase: r.item.phase,
      title: r.item.title,
      description: r.item.description,
      channel: r.item.channel,
      ownerId: r.item.ownerId,
      ownerName: r.ownerName,
      ownerHue: r.ownerHue,
      ownerRole: r.ownerRole,
      startDate: r.item.startDate,
      dueDate: r.item.dueDate,
      dependsOn: r.item.dependsOn,
      status: r.item.status as PlanStatus,
      isMilestone: r.item.isMilestone,
      atRisk: r.item.atRisk,
      sortIndex: r.item.sortIndex,
      segmentId: r.item.segmentId,
      segmentName: r.segmentName,
      segmentReach: r.segmentReach,
      approvalChainId: r.item.approvalChainId,
      approvalChainName: r.chainName,
      approvalStepCount: r.chainName ? Number(r.chainSteps ?? 0) : null,
      approvalsPending: mine.filter((a) => pendingAssetIds.has(a.id)).length,
      assets: mine.map(
        (a): LinkedAsset => ({
          id: a.id,
          title: a.title,
          channel: a.channel,
          status: a.status,
          compositeScore: a.compositeScore,
        }),
      ),
    }
  })
}

/**
 * Assets already produced for this campaign that no task claims yet. They are
 * offered as attachable so CP-3's link is something a user can actually make,
 * not only something a generator can pre-wire.
 */
export async function attachableAssets(
  workspaceId: string,
  campaignId: string,
): Promise<LinkedAsset[]> {
  const rows = await db
    .select({
      id: assets.id,
      title: assets.title,
      channel: assets.channel,
      status: assets.status,
      compositeScore: assets.compositeScore,
    })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, workspaceId),
        eq(assets.campaignId, campaignId),
        sql`${assets.planItemId} is null`,
      ),
    )
    .orderBy(asc(assets.channel), asc(assets.title))
  return rows
}

/* ---------------------------------------------------------------- pickers */

export async function segmentOptions(workspaceId: string): Promise<PickerOption[]> {
  const rows = await db
    .select({
      id: segments.id,
      name: segments.name,
      reachableSize: segments.reachableSize,
      sourceType: segments.sourceType,
    })
    .from(segments)
    .where(eq(segments.workspaceId, workspaceId))
    .orderBy(desc(segments.reachableSize))

  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    detail: `${s.reachableSize.toLocaleString('en-GB')} reachable · ${
      s.sourceType === 'lookalike' ? 'lookalike' : 'rule-based'
    }`,
  }))
}

export async function chainOptions(workspaceId: string): Promise<PickerOption[]> {
  const rows = await db
    .select({
      id: approvalChains.id,
      name: approvalChains.name,
      steps: sql<number>`coalesce(jsonb_array_length(${approvalChains.steps}), 0)::int`,
      isDefault: approvalChains.isDefault,
    })
    .from(approvalChains)
    .where(and(eq(approvalChains.workspaceId, workspaceId), eq(approvalChains.active, true)))
    .orderBy(desc(approvalChains.priority))

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    detail: `${c.steps} step${c.steps === 1 ? '' : 's'}${c.isDefault ? ' · default' : ''}`,
  }))
}

export type MemberOption = { id: string; name: string; role: string; avatarHue: number }

export async function memberOptions(workspaceId: string): Promise<MemberOption[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: memberships.role,
      avatarHue: users.avatarHue,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(users.name))
  return rows
}

/* -------------------------------------------------------------- templates */

type TemplatePayload = {
  version: number
  objective?: string
  goalMetric?: string
  targetValue?: number | null
  budget?: number
  durationDays?: number
  channels?: string[]
  summary?: string
  phases?: string[]
  risks?: string[]
  tasks?: unknown[]
}

export async function listTemplates(workspaceId: string): Promise<TemplateView[]> {
  const rows = await db
    .select()
    .from(campaignTemplates)
    .where(eq(campaignTemplates.workspaceId, workspaceId))
    .orderBy(desc(campaignTemplates.usageCount), desc(campaignTemplates.createdAt))

  return rows.map((t) => {
    const payload = (t.payload ?? {}) as TemplatePayload
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      taskCount: tasks.length,
      phaseCount: payload.phases?.length ?? 0,
      durationDays: payload.durationDays ?? 0,
      channels: payload.channels ?? [],
      usageCount: t.usageCount,
      createdAt: t.createdAt.toISOString(),
    }
  })
}

/* ----------------------------------------------------------------- audit */

export type PlanningNote = {
  at: string
  summary: string
  risks: string[]
  planSummary: string | null
  simulated: boolean
}

/**
 * What the agent flagged when this plan was generated. Read from the audit
 * trail rather than a mutable column, so the caveats a plan shipped with cannot
 * be quietly edited later.
 */
export async function planningNote(
  workspaceId: string,
  campaignId: string,
): Promise<PlanningNote | null> {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        eq(auditEvents.subjectType, 'campaign'),
        eq(auditEvents.subjectId, campaignId),
        inArray(auditEvents.action, ['campaign.planned', 'campaign.created']),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(1)

  if (!row) return null
  const payload = row.payload as Record<string, unknown>
  return {
    at: row.createdAt.toISOString(),
    summary: row.summary,
    risks: Array.isArray(payload.risks) ? (payload.risks as string[]) : [],
    planSummary: typeof payload.planSummary === 'string' ? payload.planSummary : null,
    simulated: payload.simulated === true,
  }
}

/** The reschedules this campaign has already been through (CP-4 history). */
export async function rescheduleHistory(
  workspaceId: string,
  campaignId: string,
  limit = 4,
): Promise<{ at: string; summary: string; actorName: string | null }[]> {
  const rows = await db
    .select({
      createdAt: auditEvents.createdAt,
      summary: auditEvents.summary,
      actorName: users.name,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        eq(auditEvents.subjectType, 'campaign'),
        eq(auditEvents.subjectId, campaignId),
        eq(auditEvents.action, 'campaign.rescheduled'),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(limit)

  return rows.map((r) => ({
    at: r.createdAt.toISOString(),
    summary: r.summary,
    actorName: r.actorName,
  }))
}
