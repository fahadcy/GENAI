'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  approvalChains,
  assets,
  campaigns,
  campaignTemplates,
  channelEnum,
  memberships,
  notifications,
  planItems,
  users,
  type Channel,
} from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { generatePlan } from '@/lib/ai/agents/planner'
import { recordAudit } from '@/lib/workflow/audit'
import {
  computeSchedule,
  formatDay,
  fromDay,
  pluralDays,
  summariseImpact,
  toDay,
  todayDay,
  type PlanStatus,
  type ScheduleInput,
} from '@/components/planner/schedule'
import type { DraftPlan, DraftTask } from '@/components/planner/types'
import type { ActionResult } from '@/app/actions/content'

const CHANNELS = new Set<string>(channelEnum.enumValues)
const STATUSES = ['not_started', 'in_progress', 'blocked', 'in_review', 'done'] as const

/* ------------------------------------------------------------------ CP-1 */

const objectiveSchema = z.object({
  name: z.string().trim().min(3, 'Give the campaign a name.'),
  objective: z.string().trim().min(12, 'Describe what this campaign has to achieve.'),
  channels: z.array(z.string()).default([]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date.'),
  durationDays: z.coerce.number().int().min(7).max(180),
  budget: z.coerce.number().min(0).max(100_000_000),
  goalMetric: z.string().default('signups'),
  targetValue: z.coerce.number().int().min(0).nullable().optional(),
})

export type ObjectiveInput = z.input<typeof objectiveSchema>

/**
 * Objective in, plan out — and nothing written yet (PRD CP-1). The draft comes
 * back with real owners and real dates already resolved so the review step is a
 * look at the plan that will exist, not at an abstraction of it.
 */
export async function draftPlanAction(input: ObjectiveInput): Promise<ActionResult<DraftPlan>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:create')
  } catch {
    return { ok: false, message: 'Your role cannot create campaigns.' }
  }

  const parsed = objectiveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  }
  const data = parsed.data

  // The draft carries the id the campaign will eventually be created with, so
  // the AI run recorded against it lines up with the campaign that ships.
  const draftId = randomUUID()

  let plan
  let simulated = false
  try {
    const result = await generatePlan({
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
      campaignId: draftId,
      name: data.name,
      objective: data.objective,
      channels: data.channels.filter((c) => CHANNELS.has(c)),
      durationDays: data.durationDays,
      budget: data.budget,
      currency: auth.workspace.settings.currency,
    })
    plan = result.plan
    simulated = result.simulated
  } catch {
    return {
      ok: false,
      message: 'The planning agent did not answer. Nothing was created — try again in a moment.',
    }
  }

  const owners = await roleOwners(auth.workspace.id)
  const tasks = plan.tasks.map((t) =>
    resolveDraftTask(
      {
        ref: t.ref,
        phase: t.phase,
        title: t.title,
        description: t.description ?? null,
        channel: t.channel ?? null,
        ownerRole: t.ownerRole,
        startOffsetDays: t.startOffsetDays,
        durationDays: t.durationDays,
        dependsOn: t.dependsOn,
        isMilestone: t.isMilestone,
        needsApproval: t.needsApproval,
      },
      data.startDate,
      owners,
    ),
  )

  return {
    ok: true,
    message: `${tasks.length} tasks across ${plan.phases.length} phases.`,
    data: {
      draftId,
      summary: plan.summary,
      phases: plan.phases,
      risks: plan.risks,
      recommendedChannels: plan.recommendedChannels.filter((c) => CHANNELS.has(c)),
      simulated,
      fromTemplate: null,
      tasks,
    },
  }
}

const commitSchema = objectiveSchema.extend({
  draftId: z.string().uuid(),
  summary: z.string().default(''),
  phases: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  simulated: z.boolean().default(false),
  fromTemplateId: z.string().uuid().nullable().optional(),
  tasks: z
    .array(
      z.object({
        ref: z.string(),
        phase: z.string(),
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        channel: z.string().nullable().optional(),
        ownerRole: z.string(),
        ownerId: z.string().uuid().nullable().optional(),
        dependsOn: z.array(z.string()).default([]),
        isMilestone: z.boolean().default(false),
        needsApproval: z.boolean().default(false),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .min(1, 'A plan needs at least one task.'),
})

/** Commit a reviewed draft: the campaign and its whole plan, or neither. */
export async function commitPlanAction(
  input: z.input<typeof commitSchema>,
): Promise<ActionResult<{ campaignId: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:create')
  } catch {
    return { ok: false, message: 'Your role cannot create campaigns.' }
  }

  const parsed = commitSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  }
  const data = parsed.data

  const [clash] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, data.draftId))
    .limit(1)
  if (clash) {
    return { ok: false, message: 'This plan has already been created. Open it from the list below.' }
  }

  const owners = await roleOwners(auth.workspace.id)
  const [defaultChain] = await db
    .select({ id: approvalChains.id })
    .from(approvalChains)
    .where(
      and(
        eq(approvalChains.workspaceId, auth.workspace.id),
        eq(approvalChains.active, true),
        eq(approvalChains.isDefault, true),
      ),
    )
    .limit(1)

  // The window must cover the plan. If the reviewer stretched a task past the
  // stated duration, the campaign end moves with it rather than the campaign
  // being born already overrunning itself.
  const endDate = fromDay(
    Math.max(toDay(data.startDate) + data.durationDays, ...data.tasks.map((t) => toDay(t.dueDate))),
  )

  const created = await db.transaction(async (tx) => {
    await tx.insert(campaigns).values({
      id: data.draftId,
      workspaceId: auth.workspace.id,
      name: data.name,
      objective: data.objective,
      goalMetric: data.goalMetric,
      targetValue: data.targetValue ?? null,
      budget: String(data.budget),
      status: 'planning',
      startDate: data.startDate,
      endDate,
      ownerId: auth.user.id,
      channels: data.channels.filter((c) => CHANNELS.has(c)),
    })

    // Dependencies arrive as agent refs ("t3"); they become real row ids only
    // once each row exists, so the map is filled as we insert in plan order.
    const refToId = new Map<string, string>()
    for (let i = 0; i < data.tasks.length; i++) {
      const t = data.tasks[i]
      const [row] = await tx
        .insert(planItems)
        .values({
          workspaceId: auth.workspace.id,
          campaignId: data.draftId,
          phase: t.phase,
          title: t.title,
          description: t.description || null,
          channel: t.channel && CHANNELS.has(t.channel) ? (t.channel as Channel) : null,
          ownerId: t.ownerId ?? owners.get(t.ownerRole)?.id ?? auth.user.id,
          startDate: t.startDate,
          dueDate: t.dueDate,
          dependsOn: t.dependsOn.map((r) => refToId.get(r)).filter((v): v is string => Boolean(v)),
          status: 'not_started',
          approvalChainId: t.needsApproval ? (defaultChain?.id ?? null) : null,
          isMilestone: t.isMilestone,
          sortIndex: i,
        })
        .returning({ id: planItems.id })
      refToId.set(t.ref, row.id)
    }

    if (data.fromTemplateId) {
      await tx
        .update(campaignTemplates)
        .set({ usageCount: sql`${campaignTemplates.usageCount} + 1` })
        .where(
          and(
            eq(campaignTemplates.workspaceId, auth.workspace.id),
            eq(campaignTemplates.id, data.fromTemplateId),
          ),
        )
    }

    return data.draftId
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'campaign.created',
    subjectType: 'campaign',
    subjectId: created,
    summary: `Campaign "${data.name}" created for ${data.durationDays} days on ${
      data.channels.length
    } channel${data.channels.length === 1 ? '' : 's'}, budget ${data.budget.toLocaleString('en-GB')}.`,
    payload: { objective: data.objective, channels: data.channels, goalMetric: data.goalMetric },
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    actorType: data.fromTemplateId ? 'user' : 'system',
    action: 'campaign.planned',
    subjectType: 'campaign',
    subjectId: created,
    summary: `${data.tasks.length}-task plan across ${data.phases.length} phases committed${
      data.fromTemplateId ? ' from a saved template' : ''
    }. ${data.risks.length} risk${data.risks.length === 1 ? '' : 's'} flagged at planning.`,
    payload: {
      planSummary: data.summary,
      risks: data.risks,
      phases: data.phases,
      simulated: data.simulated,
      fromTemplateId: data.fromTemplateId ?? null,
      taskCount: data.tasks.length,
    },
  })

  revalidatePath('/planner')
  revalidatePath('/command-center')
  return {
    ok: true,
    message: `"${data.name}" created with ${data.tasks.length} tasks.`,
    data: { campaignId: created },
  }
}

/* ------------------------------------------------------------------ CP-4 */

const reschedulePatch = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(STATUSES).optional(),
})

export type RescheduleOutcome = {
  moved: number
  slipped: { title: string; slip: number; date: string }[]
  detail: string
}

/**
 * Move or block one task and settle the rest of the plan behind it (PRD CP-4).
 *
 * The projection is the same `computeSchedule` the browser previewed with, run
 * again server-side against freshly-read rows — the client's copy is only ever
 * a preview, never the source of the dates that get written.
 */
export async function rescheduleTaskAction(
  campaignId: string,
  taskId: string,
  patch: z.input<typeof reschedulePatch>,
): Promise<ActionResult<RescheduleOutcome>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:edit')
  } catch {
    return { ok: false, message: 'Your role cannot change a campaign plan.' }
  }

  const parsedPatch = reschedulePatch.safeParse(patch)
  if (!parsedPatch.success) return { ok: false, message: 'That change could not be read.' }
  const change = parsedPatch.data
  if (change.startDate && change.dueDate && toDay(change.dueDate) < toDay(change.startDate)) {
    return { ok: false, message: 'The due date cannot fall before the start date.' }
  }

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, auth.workspace.id), eq(campaigns.id, campaignId)))
    .limit(1)
  if (!campaign) return { ok: false, message: 'Campaign not found.' }

  const rows = await db
    .select()
    .from(planItems)
    .where(and(eq(planItems.workspaceId, auth.workspace.id), eq(planItems.campaignId, campaignId)))
    .orderBy(asc(planItems.sortIndex))

  const target = rows.find((r) => r.id === taskId)
  if (!target) return { ok: false, message: 'That task is not part of this campaign.' }

  const inputs: ScheduleInput[] = rows.map(toScheduleInput)
  const today = todayDay()
  const campaignEnd = campaign.endDate ? toDay(campaign.endDate) : null

  const before = computeSchedule(inputs, { today, campaignEnd })
  const after = computeSchedule(inputs, {
    today,
    campaignEnd,
    overrides: new Map([[taskId, change]]),
  })

  const nextStatus = change.status ?? (target.status as PlanStatus)

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const placed = after.placements.get(row.id)!
      const status = row.id === taskId ? nextStatus : (row.status as PlanStatus)
      const start = fromDay(placed.start)
      const due = fromDay(placed.finish)
      // "At risk" is derived, never typed: a task is at risk when it has been
      // pushed past its committed finish, is blocked, or is already overdue.
      const atRisk =
        status !== 'done' && (placed.shift > 0 || status === 'blocked' || placed.finish < today)

      if (
        row.startDate === start &&
        row.dueDate === due &&
        row.status === status &&
        row.atRisk === atRisk
      ) {
        continue
      }
      await tx
        .update(planItems)
        .set({ startDate: start, dueDate: due, status, atRisk })
        .where(eq(planItems.id, row.id))
    }
  })

  const slipped = after.milestones
    .filter((m) => m.slip > 0)
    .map((m) => ({ title: m.title, slip: m.slip, date: fromDay(m.finish) }))
  const movedOthers = after.moved.filter((p) => p.id !== taskId)
  const wasSlipping = before.milestones.filter((m) => m.slip > 0).length

  const detail = summariseImpact(after)
  const verb = change.status === 'blocked' ? 'blocked' : 'rescheduled'

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'campaign.rescheduled',
    subjectType: 'campaign',
    subjectId: campaignId,
    summary: `"${target.title}" ${verb}${
      change.startDate || change.dueDate
        ? ` to ${formatDay(after.placements.get(taskId)!.start)} – ${formatDay(
            after.placements.get(taskId)!.finish,
          )}`
        : ''
    }. ${movedOthers.length} dependent task${movedOthers.length === 1 ? '' : 's'} moved. ${
      slipped.length === 0
        ? 'No milestone slipped.'
        : slipped.map((s) => `"${s.title}" slips ${pluralDays(s.slip)}`).join('; ') + '.'
    }`,
    payload: {
      taskId,
      change,
      movedTaskIds: movedOthers.map((p) => p.id),
      milestoneSlips: slipped,
    },
  })

  // Only tell the owner when the situation got worse. A notification for every
  // date nudge would train people to ignore the ones that matter.
  if (slipped.length > wasSlipping && campaign.ownerId && campaign.ownerId !== auth.user.id) {
    await db.insert(notifications).values({
      workspaceId: auth.workspace.id,
      userId: campaign.ownerId,
      type: 'campaign.at_risk',
      title: `"${slipped[0].title}" is now at risk on ${campaign.name}`,
      body: `${target.title} ${verb}. ${detail}`,
      href: `/planner/${campaignId}`,
    })
  }

  revalidatePath(`/planner/${campaignId}`)
  revalidatePath('/planner')
  return {
    ok: true,
    message: detail,
    data: { moved: movedOthers.length, slipped, detail },
  }
}

/* ------------------------------------------------------------------ CP-3 */

export async function linkTaskAction(
  campaignId: string,
  taskId: string,
  link: { segmentId?: string | null; approvalChainId?: string | null },
): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:edit')
  } catch {
    return { ok: false, message: 'Your role cannot change a campaign plan.' }
  }

  const patch: Record<string, string | null> = {}
  if (link.segmentId !== undefined) patch.segmentId = link.segmentId || null
  if (link.approvalChainId !== undefined) patch.approvalChainId = link.approvalChainId || null
  if (Object.keys(patch).length === 0) return { ok: false, message: 'Nothing to change.' }

  const updated = await db
    .update(planItems)
    .set(patch)
    .where(
      and(
        eq(planItems.workspaceId, auth.workspace.id),
        eq(planItems.campaignId, campaignId),
        eq(planItems.id, taskId),
      ),
    )
    .returning({ id: planItems.id })
  if (updated.length === 0) return { ok: false, message: 'That task is not part of this campaign.' }

  revalidatePath(`/planner/${campaignId}`)
  return { ok: true, message: 'Link saved.' }
}

/** Claim an already-generated asset for a task, or release it back. */
export async function setAssetTaskAction(
  campaignId: string,
  assetId: string,
  taskId: string | null,
): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:edit')
  } catch {
    return { ok: false, message: 'Your role cannot change a campaign plan.' }
  }

  if (taskId) {
    const [task] = await db
      .select({ id: planItems.id })
      .from(planItems)
      .where(
        and(
          eq(planItems.workspaceId, auth.workspace.id),
          eq(planItems.campaignId, campaignId),
          eq(planItems.id, taskId),
        ),
      )
      .limit(1)
    if (!task) return { ok: false, message: 'That task is not part of this campaign.' }
  }

  const updated = await db
    .update(assets)
    .set({ planItemId: taskId })
    .where(
      and(
        eq(assets.workspaceId, auth.workspace.id),
        eq(assets.campaignId, campaignId),
        eq(assets.id, assetId),
      ),
    )
    .returning({ id: assets.id })
  if (updated.length === 0) return { ok: false, message: 'That asset is not part of this campaign.' }

  revalidatePath(`/planner/${campaignId}`)
  return { ok: true, message: taskId ? 'Asset attached to the task.' : 'Asset detached.' }
}

/* ------------------------------------------------------------------ CP-5 */

const templateSchema = z.object({
  name: z.string().trim().min(3, 'Give the template a name.'),
  description: z.string().trim().max(400).optional(),
})

/**
 * Freeze a working plan into a reusable shape. Absolute dates become offsets
 * from day zero and owners become roles, so the same template lands correctly
 * whenever and for whoever it is next used.
 */
export async function saveAsTemplateAction(
  campaignId: string,
  input: z.input<typeof templateSchema>,
): Promise<ActionResult<{ templateId: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:create')
  } catch {
    return { ok: false, message: 'Your role cannot save campaign templates.' }
  }

  const parsed = templateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  }

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, auth.workspace.id), eq(campaigns.id, campaignId)))
    .limit(1)
  if (!campaign) return { ok: false, message: 'Campaign not found.' }

  const rows = await db
    .select()
    .from(planItems)
    .where(and(eq(planItems.workspaceId, auth.workspace.id), eq(planItems.campaignId, campaignId)))
    .orderBy(asc(planItems.sortIndex))
  if (rows.length === 0) return { ok: false, message: 'This campaign has no plan to save.' }

  const roleByUser = new Map(
    (
      await db
        .select({ userId: memberships.userId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.workspaceId, auth.workspace.id))
    ).map((m) => [m.userId, m.role as string]),
  )

  const origin = Math.min(
    ...rows.map((r) => toDay(r.startDate ?? campaign.startDate ?? fromDay(todayDay()))),
  )
  const idToRef = new Map(rows.map((r, i) => [r.id, `t${i + 1}`]))
  const phases: string[] = []
  for (const r of rows) if (!phases.includes(r.phase)) phases.push(r.phase)

  const tasks = rows.map((r, i) => {
    const start = toDay(r.startDate ?? fromDay(origin))
    const finish = toDay(r.dueDate ?? r.startDate ?? fromDay(origin))
    return {
      ref: idToRef.get(r.id) ?? `t${i + 1}`,
      phase: r.phase,
      title: r.title,
      description: r.description,
      channel: r.channel,
      ownerRole: roleByUser.get(r.ownerId ?? '') ?? 'strategist',
      startOffsetDays: Math.max(0, start - origin),
      durationDays: Math.max(1, finish - start),
      dependsOn: r.dependsOn.map((d) => idToRef.get(d)).filter((v): v is string => Boolean(v)),
      isMilestone: r.isMilestone,
      needsApproval: r.approvalChainId !== null,
    }
  })

  const durationDays = Math.max(
    ...tasks.map((t) => t.startOffsetDays + t.durationDays),
    campaign.endDate && campaign.startDate ? toDay(campaign.endDate) - toDay(campaign.startDate) : 0,
  )

  const [row] = await db
    .insert(campaignTemplates)
    .values({
      workspaceId: auth.workspace.id,
      name: parsed.data.name,
      description: parsed.data.description || null,
      payload: {
        version: 1,
        objective: campaign.objective,
        goalMetric: campaign.goalMetric,
        targetValue: campaign.targetValue,
        budget: Number(campaign.budget),
        durationDays,
        channels: campaign.channels,
        summary: `Saved from "${campaign.name}" — ${tasks.length} tasks over ${durationDays} days.`,
        phases,
        risks: [],
        tasks,
      },
    })
    .returning({ id: campaignTemplates.id })

  revalidatePath('/planner')
  return {
    ok: true,
    message: `Saved "${parsed.data.name}" — ${tasks.length} tasks, ${phases.length} phases.`,
    data: { templateId: row.id },
  }
}

/** Rehydrate a template into a reviewable draft on a new start date (CP-5). */
export async function draftFromTemplateAction(
  templateId: string,
  input: { name: string; startDate: string },
): Promise<ActionResult<DraftPlan & { defaults: ObjectiveInput }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:create')
  } catch {
    return { ok: false, message: 'Your role cannot create campaigns.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    return { ok: false, message: 'Pick a start date for the new campaign.' }
  }

  const [template] = await db
    .select()
    .from(campaignTemplates)
    .where(
      and(
        eq(campaignTemplates.workspaceId, auth.workspace.id),
        eq(campaignTemplates.id, templateId),
      ),
    )
    .limit(1)
  if (!template) return { ok: false, message: 'Template not found.' }

  const payload = template.payload as {
    objective?: string
    goalMetric?: string
    targetValue?: number | null
    budget?: number
    durationDays?: number
    channels?: string[]
    summary?: string
    phases?: string[]
    risks?: string[]
    tasks?: Omit<DraftTask, 'startDate' | 'dueDate' | 'ownerName' | 'ownerHue'>[]
  }
  const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : []
  if (rawTasks.length === 0) return { ok: false, message: 'That template holds no tasks.' }

  const owners = await roleOwners(auth.workspace.id)
  const tasks = rawTasks.map((t) => resolveDraftTask(t, input.startDate, owners))

  return {
    ok: true,
    message: `${tasks.length} tasks re-anchored to ${formatDay(toDay(input.startDate))}.`,
    data: {
      draftId: randomUUID(),
      summary: payload.summary ?? `Reused from the "${template.name}" template.`,
      phases: payload.phases ?? [],
      risks: payload.risks ?? [],
      recommendedChannels: payload.channels ?? [],
      simulated: false,
      fromTemplate: template.id,
      tasks,
      defaults: {
        name: input.name.trim() || template.name,
        objective: payload.objective ?? '',
        channels: payload.channels ?? [],
        startDate: input.startDate,
        durationDays: payload.durationDays ?? 30,
        budget: payload.budget ?? 0,
        goalMetric: payload.goalMetric ?? 'signups',
        targetValue: payload.targetValue ?? null,
      },
    },
  }
}

export async function deleteTemplateAction(templateId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:create')
  } catch {
    return { ok: false, message: 'Your role cannot manage campaign templates.' }
  }
  await db
    .delete(campaignTemplates)
    .where(
      and(
        eq(campaignTemplates.workspaceId, auth.workspace.id),
        eq(campaignTemplates.id, templateId),
      ),
    )
  revalidatePath('/planner')
  return { ok: true, message: 'Template removed.' }
}

/* ---------------------------------------------------------------- upkeep */

export async function setCampaignStatusAction(
  campaignId: string,
  status: 'draft' | 'planning' | 'active' | 'paused' | 'completed' | 'archived',
): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:edit')
  } catch {
    return { ok: false, message: 'Your role cannot change campaign status.' }
  }
  const updated = await db
    .update(campaigns)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(campaigns.workspaceId, auth.workspace.id), eq(campaigns.id, campaignId)))
    .returning({ name: campaigns.name })
  if (updated.length === 0) return { ok: false, message: 'Campaign not found.' }

  revalidatePath(`/planner/${campaignId}`)
  revalidatePath('/planner')
  revalidatePath('/command-center')
  return { ok: true, message: `"${updated[0].name}" is now ${status}.` }
}

export async function deleteCampaignAction(campaignId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'campaign:edit')
  } catch {
    return { ok: false, message: 'Your role cannot delete campaigns.' }
  }

  const [campaign] = await db
    .select({ name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, auth.workspace.id), eq(campaigns.id, campaignId)))
    .limit(1)
  if (!campaign) return { ok: false, message: 'Campaign not found.' }
  if (campaign.status === 'active') {
    return {
      ok: false,
      message: 'Pause the campaign before deleting it — live work is still attached to this plan.',
    }
  }

  await db
    .delete(campaigns)
    .where(and(eq(campaigns.workspaceId, auth.workspace.id), eq(campaigns.id, campaignId)))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'campaign.deleted',
    subjectType: 'campaign',
    subjectId: null,
    summary: `Campaign "${campaign.name}" and its plan were deleted.`,
    payload: { campaignId },
  })

  revalidatePath('/planner')
  revalidatePath('/command-center')
  return { ok: true, message: `"${campaign.name}" deleted.` }
}

/* --------------------------------------------------------------- helpers */

function toScheduleInput(row: typeof planItems.$inferSelect): ScheduleInput {
  return {
    id: row.id,
    title: row.title,
    startDate: row.startDate,
    dueDate: row.dueDate,
    dependsOn: row.dependsOn,
    status: row.status as PlanStatus,
    isMilestone: row.isMilestone,
    sortIndex: row.sortIndex,
  }
}

type RoleOwner = { id: string; name: string; hue: number }

/**
 * One representative member per role, so a plan that says "approver" lands on a
 * real person. Ordered by name for a stable pick rather than whatever the join
 * happened to return.
 */
async function roleOwners(workspaceId: string): Promise<Map<string, RoleOwner>> {
  const rows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      name: users.name,
      hue: users.avatarHue,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(users.name))

  const map = new Map<string, RoleOwner>()
  for (const r of rows) {
    if (!map.has(r.role)) map.set(r.role, { id: r.userId, name: r.name, hue: r.hue })
  }
  return map
}

type RawTask = Omit<DraftTask, 'startDate' | 'dueDate' | 'ownerName' | 'ownerHue'>

/** Offsets + role → real dates + a named owner, without writing anything. */
function resolveDraftTask(
  task: RawTask,
  startDate: string,
  owners: Map<string, RoleOwner>,
): DraftTask {
  const start = toDay(startDate) + Math.max(0, task.startOffsetDays)
  const owner = owners.get(task.ownerRole)
  return {
    ...task,
    description: task.description ?? null,
    channel: task.channel && CHANNELS.has(task.channel) ? task.channel : null,
    startDate: fromDay(start),
    dueDate: fromDay(start + Math.max(1, task.durationDays)),
    ownerName: owner?.name ?? null,
    ownerHue: owner?.hue ?? null,
  }
}
