import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  adCampaigns,
  approvalChains,
  approvalDecisions,
  approvalRequests,
  assets,
  budgetPlans,
  memberships,
  notifications,
  serpTwinActions,
  users,
  videoGenerations,
  type ApprovalChain,
  type ApprovalStep,
  type Asset,
  type Role,
} from '@/lib/db/schema'
import { recordAudit } from './audit'
import { adapterFor, loadSubject, type ApprovalSubject } from './subjects'

/**
 * The approvals engine (PRD 6.6) — the governance spine.
 *
 * Two invariants this module exists to guarantee:
 *   1. Nothing reaches `approved` except by passing every step of a matched chain.
 *   2. Nothing publishes that is not `approved` (enforced in publish.ts, which
 *      calls `assertPublishable` here).
 */

export class GateError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
  }
}

/* ------------------------------------------------------- chain selection */

/**
 * Pick the chain that governs a subject. Most specific wins: an explicit
 * channel/spend match beats the workspace default.
 */
export async function matchChain(
  workspaceId: string,
  subject: { channel?: string | null; spend?: number; campaignId?: string | null; subjectType?: string },
): Promise<ApprovalChain | null> {
  const chains = await db
    .select()
    .from(approvalChains)
    .where(and(eq(approvalChains.workspaceId, workspaceId), eq(approvalChains.active, true)))
    .orderBy(desc(approvalChains.priority))

  const scored = chains
    .map((chain) => {
      const s = chain.scope
      let specificity = 0

      if (s.subjectTypes?.length) {
        if (!subject.subjectType || !s.subjectTypes.includes(subject.subjectType)) return null
        specificity += 1
      }
      if (s.channels?.length) {
        if (!subject.channel || !s.channels.includes(subject.channel)) return null
        specificity += 4
      }
      if (s.campaignIds?.length) {
        if (!subject.campaignId || !s.campaignIds.includes(subject.campaignId)) return null
        specificity += 8
      }
      if (typeof s.spendThreshold === 'number') {
        if ((subject.spend ?? 0) < s.spendThreshold) return null
        specificity += 6
      }
      if (chain.isDefault) specificity += 0.5
      return { chain, specificity: specificity + chain.priority / 100 }
    })
    .filter((x): x is { chain: ApprovalChain; specificity: number } => x !== null)
    .sort((a, b) => b.specificity - a.specificity)

  return scored[0]?.chain ?? chains.find((c) => c.isDefault) ?? null
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Submit anything governed by a chain — an organic asset or a paid campaign.
 *
 * The subject adapter supplies the title, version, chain-matching inputs and
 * any blocking reason; everything after that is identical regardless of what is
 * being approved, which is the whole point of routing both through here.
 */
export async function submitForReview(args: {
  workspaceId: string
  subjectType: 'asset' | 'ad_campaign' | 'video' | 'search_action' | 'budget_plan'
  subjectId: string
  actorId: string
}): Promise<{ requestId: string; chainName: string; stepName: string }> {
  const subject = await loadSubject(args.subjectType, args.workspaceId, args.subjectId)
  if (!subject) throw new GateError('Not found.')
  if (subject.status === 'approved' || subject.status === 'published' || subject.status === 'live') {
    throw new GateError(`This ${subject.noun} is already approved.`)
  }

  // A blocking problem — a high-severity guardrail finding, a campaign with no
  // landing page — stops submission outright. That is the point of checking
  // before a human ever spends time on it.
  if (subject.submitBlocker) throw new GateError(`Cannot submit: ${subject.submitBlocker}`)

  const chain = await matchChain(args.workspaceId, {
    channel: subject.channel,
    campaignId: subject.campaignId,
    spend: subject.spend,
    subjectType: args.subjectType,
  })
  if (!chain || chain.steps.length === 0) {
    throw new GateError('No approval chain is configured for this channel. Ask an admin to add one.')
  }

  // Cancel any superseded open request for this subject.
  await db
    .update(approvalRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.subjectType, args.subjectType),
        eq(approvalRequests.subjectId, args.subjectId),
        eq(approvalRequests.status, 'pending'),
      ),
    )

  const firstStep = chain.steps[0]
  const dueAt = new Date(Date.now() + (firstStep.slaHours || 24) * 3_600_000)

  const [req] = await db
    .insert(approvalRequests)
    .values({
      workspaceId: args.workspaceId,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      chainId: chain.id,
      currentStep: 0,
      status: 'pending',
      subjectVersion: subject.version,
      requestedBy: args.actorId,
      dueAt,
    })
    .returning({ id: approvalRequests.id })

  await adapterFor(args.subjectType).setStatus(args.subjectId, 'in_review', new Date())

  await notifyStep(args.workspaceId, req.id, chain, 0, subject)

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'approval.requested',
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    summary: `"${subject.title}" submitted to "${chain.name}" — step 1 of ${chain.steps.length} (${firstStep.name}).`,
    payload: {
      chainId: chain.id,
      requestId: req.id,
      version: subject.version,
      channel: subject.channel,
      ...(subject.spend > 0 ? { monthlySpend: Math.round(subject.spend) } : {}),
    },
  })

  return { requestId: req.id, chainName: chain.name, stepName: firstStep.name }
}

/** Kept as the name the Studio surface already calls. */
export function submitAssetForReview(args: {
  workspaceId: string
  assetId: string
  actorId: string
}) {
  return submitForReview({
    workspaceId: args.workspaceId,
    subjectType: 'asset',
    subjectId: args.assetId,
    actorId: args.actorId,
  })
}

export async function decide(args: {
  workspaceId: string
  requestId: string
  actorId: string
  actorRole: Role
  decision: 'approve' | 'reject'
  comment?: string
}): Promise<{ status: 'pending' | 'approved' | 'rejected'; nextStep?: string }> {
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workspaceId, args.workspaceId), eq(approvalRequests.id, args.requestId)))
    .limit(1)
  if (!req) throw new GateError('Approval request not found.')
  if (req.status !== 'pending') throw new GateError(`This request is already ${req.status}.`)

  const [chain] = await db.select().from(approvalChains).where(eq(approvalChains.id, req.chainId)).limit(1)
  const step = chain.steps[req.currentStep]
  if (!step) throw new GateError('Approval chain step is missing.')

  if (!(await canActOnStep(args.workspaceId, step, args.actorId, args.actorRole))) {
    throw new GateError(`This step is for ${step.role}s. You are not an eligible approver.`)
  }

  if (args.decision === 'reject' && !args.comment?.trim()) {
    throw new GateError('A comment is required when requesting changes.') // AP-2
  }

  await db.insert(approvalDecisions).values({
    requestId: req.id,
    step: req.currentStep,
    userId: args.actorId,
    decision: args.decision,
    comment: args.comment ?? null,
  })

  const subject = await loadSubject(req.subjectType, args.workspaceId, req.subjectId)
  const adapter = adapterFor(req.subjectType)

  /* ------------------------------------------------------------ reject */
  if (args.decision === 'reject') {
    const now = new Date()
    await db
      .update(approvalRequests)
      .set({
        status: 'rejected',
        completedAt: now,
        resolutionMs: now.getTime() - req.requestedAt.getTime(),
      })
      .where(eq(approvalRequests.id, req.id))

    await adapter.setStatus(req.subjectId, 'changes_requested', now)

    if (req.requestedBy) {
      await db.insert(notifications).values({
        workspaceId: args.workspaceId,
        userId: req.requestedBy,
        type: 'approval.rejected',
        title: `Changes requested on "${subject?.title ?? 'an item'}"`,
        body: args.comment ?? null,
        href: subject?.href ?? `/approvals/${req.id}`,
      })
    }

    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: 'approval.rejected',
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      summary: `Changes requested at step ${req.currentStep + 1} (${step.name}): ${args.comment}`,
      payload: { requestId: req.id, step: req.currentStep, comment: args.comment },
    })
    return { status: 'rejected' }
  }

  /* ----------------------------------------------------------- approve */
  // 'all' mode: wait until every eligible approver on this step has approved.
  if (step.mode === 'all') {
    const eligible = await eligibleApprovers(args.workspaceId, step)
    const approvals = await db
      .select({ userId: approvalDecisions.userId })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.requestId, req.id),
          eq(approvalDecisions.step, req.currentStep),
          eq(approvalDecisions.decision, 'approve'),
        ),
      )
    const approvedIds = new Set(approvals.map((a) => a.userId))
    const outstanding = eligible.filter((e) => !approvedIds.has(e.id))
    if (outstanding.length > 0) {
      await recordAudit({
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        action: 'approval.approved',
        subjectType: req.subjectType,
        subjectId: req.subjectId,
        summary: `Approved at step ${req.currentStep + 1} (${step.name}); waiting on ${outstanding.length} more approver(s).`,
        payload: { requestId: req.id, step: req.currentStep, outstanding: outstanding.map((o) => o.name) },
      })
      return { status: 'pending', nextStep: step.name }
    }
  }

  const nextIndex = req.currentStep + 1
  const isFinal = nextIndex >= chain.steps.length

  if (!isFinal) {
    const next = chain.steps[nextIndex]
    await db
      .update(approvalRequests)
      .set({
        currentStep: nextIndex,
        dueAt: new Date(Date.now() + (next.slaHours || 24) * 3_600_000),
      })
      .where(eq(approvalRequests.id, req.id))

    await notifyStep(args.workspaceId, req.id, chain, nextIndex, subject)

    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: 'approval.step_advanced',
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      summary: `Step ${req.currentStep + 1} (${step.name}) approved. Now at step ${nextIndex + 1} (${next.name}).`,
      payload: { requestId: req.id, from: req.currentStep, to: nextIndex },
    })
    return { status: 'pending', nextStep: next.name }
  }

  const now = new Date()
  await db
    .update(approvalRequests)
    .set({
      status: 'approved',
      completedAt: now,
      resolutionMs: now.getTime() - req.requestedAt.getTime(),
    })
    .where(eq(approvalRequests.id, req.id))

  await adapter.setStatus(req.subjectId, 'approved', now)

  if (req.requestedBy) {
    await db.insert(notifications).values({
      workspaceId: args.workspaceId,
      userId: req.requestedBy,
      type: 'approval.approved',
      title: `"${subject?.title ?? 'Your work'}" is approved`,
      body: subject?.approvedNote ?? 'It can now be published.',
      href: subject?.approvedHref ?? `/approvals/${req.id}`,
    })
  }

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'approval.approved',
    subjectType: req.subjectType,
    subjectId: req.subjectId,
    summary: `Fully approved after ${chain.steps.length} step(s) in ${formatDuration(now.getTime() - req.requestedAt.getTime())}.`,
    payload: { requestId: req.id, resolutionMs: now.getTime() - req.requestedAt.getTime() },
  })

  return { status: 'approved' }
}

/** AP-5: hand a pending step to a colleague without breaking the trail. */
export async function delegate(args: {
  workspaceId: string
  requestId: string
  actorId: string
  toUserId: string
  comment?: string
}) {
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workspaceId, args.workspaceId), eq(approvalRequests.id, args.requestId)))
    .limit(1)
  if (!req || req.status !== 'pending') throw new GateError('Request is not open.')

  const [chain] = await db.select().from(approvalChains).where(eq(approvalChains.id, req.chainId)).limit(1)
  const step = chain.steps[req.currentStep]
  const steps = [...chain.steps]
  steps[req.currentStep] = { ...step, approverIds: [...(step.approverIds ?? []), args.toUserId] }
  await db.update(approvalChains).set({ steps }).where(eq(approvalChains.id, chain.id))

  await db.insert(approvalDecisions).values({
    requestId: req.id,
    step: req.currentStep,
    userId: args.actorId,
    decision: 'delegate',
    delegatedToId: args.toUserId,
    comment: args.comment ?? null,
  })

  await db.insert(notifications).values({
    workspaceId: args.workspaceId,
    userId: args.toUserId,
    type: 'approval.delegated',
    title: 'An approval was delegated to you',
    body: args.comment ?? null,
    href: `/approvals/${req.id}`,
  })

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'approval.delegated',
    subjectType: req.subjectType,
    subjectId: req.subjectId,
    summary: `Step ${req.currentStep + 1} delegated.`,
    payload: { requestId: req.id, toUserId: args.toUserId },
  })
}

/* ---------------------------------------------------------------- gating */

/**
 * The publish gate. Called by the scheduler before anything is placed and by
 * the publisher before anything is sent (SC-3, AP-1).
 */
export async function assertPublishable(workspaceId: string, assetId: string): Promise<Asset> {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    .limit(1)
  if (!asset) throw new GateError('Asset not found.')

  if (asset.status === 'published') return asset
  if (asset.status !== 'approved' && asset.status !== 'scheduled') {
    const reason =
      asset.status === 'in_review'
        ? 'It is still awaiting approval.'
        : asset.status === 'changes_requested'
          ? 'A reviewer requested changes.'
          : 'It has not been submitted for approval.'
    throw new GateError(`"${asset.title}" cannot be scheduled. ${reason}`)
  }

  // An edit after approval invalidates the approval: the approved version is
  // not the version that would go out.
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.subjectType, 'asset'),
        eq(approvalRequests.subjectId, assetId),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .orderBy(desc(approvalRequests.completedAt))
    .limit(1)

  if (!req) throw new GateError(`"${asset.title}" has no completed approval on record.`)
  if (req.subjectVersion !== asset.version) {
    throw new GateError(
      `"${asset.title}" was edited after approval (approved v${req.subjectVersion}, now v${asset.version}). Resubmit for review.`,
    )
  }

  return asset
}

/**
 * The paid equivalent of `assertPublishable`, and the last thing that runs
 * before anything is sent to Google.
 *
 * Same two rules as organic — approved, and not edited since — because the
 * consequence of getting this wrong is larger, not smaller. An unapproved
 * campaign reaching a live account starts spending real money against copy
 * nobody signed off.
 */
export async function assertPushable(
  workspaceId: string,
  adCampaignId: string,
): Promise<typeof adCampaigns.$inferSelect> {
  const [campaign] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, workspaceId), eq(adCampaigns.id, adCampaignId)))
    .limit(1)
  if (!campaign) throw new GateError('Campaign not found.')

  if (campaign.status !== 'approved') {
    const reason =
      campaign.status === 'in_review'
        ? 'It is still awaiting approval.'
        : campaign.status === 'changes_requested'
          ? 'A reviewer requested changes.'
          : campaign.status === 'live' || campaign.status === 'paused'
            ? 'It has already been pushed to Google. Make changes there, or create a new campaign.'
            : 'It has not been submitted for approval.'
    throw new GateError(`"${campaign.name}" cannot be pushed to Google. ${reason}`)
  }

  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.subjectType, 'ad_campaign'),
        eq(approvalRequests.subjectId, adCampaignId),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .orderBy(desc(approvalRequests.completedAt))
    .limit(1)

  if (!req) throw new GateError(`"${campaign.name}" has no completed approval on record.`)
  if (req.subjectVersion !== campaign.version) {
    throw new GateError(
      `"${campaign.name}" was changed after it was approved (approved v${req.subjectVersion}, now v${campaign.version}). Someone needs to review it again before it can spend money.`,
    )
  }

  return campaign
}

/**
 * The video gate. Same two rules as organic and paid — approved, and not
 * changed since — plus one that only applies to a rendered file: it has to
 * have passed the mechanical checks. An approved clip in the wrong aspect
 * ratio is still a clip the platform will be rejected for.
 *
 * Note what "changed since" means for video. Regenerating does not edit the
 * clip, it replaces it with entirely different footage from a
 * non-deterministic model, so the version bump is not a formality: the thing
 * the reviewer looked at genuinely no longer exists.
 */
export async function assertVideoUsable(
  workspaceId: string,
  videoId: string,
): Promise<typeof videoGenerations.$inferSelect> {
  const [row] = await db
    .select()
    .from(videoGenerations)
    .where(and(eq(videoGenerations.workspaceId, workspaceId), eq(videoGenerations.id, videoId)))
    .limit(1)
  if (!row) throw new GateError('Clip not found.')

  if (row.status === 'published') return row

  if (row.status !== 'approved') {
    const reason =
      row.status === 'in_review'
        ? 'It is still awaiting review.'
        : row.status === 'changes_requested'
          ? 'A reviewer asked for changes.'
          : row.status === 'dead_letter'
            ? 'The generation failed and there is no clip.'
            : row.status === 'ready'
              ? 'It has not been submitted for review.'
              : 'It is still being generated.'
    throw new GateError(`"${row.title}" cannot be used. ${reason}`)
  }

  const blocking = row.mediaCheck?.findings.filter((f) => f.severity === 'high') ?? []
  if (blocking.length > 0) {
    throw new GateError(
      `"${row.title}" fails ${blocking.length} delivery check${blocking.length === 1 ? '' : 's'} and would be rejected at upload: ${blocking.map((f) => f.message).join(' ')}`,
    )
  }

  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.subjectType, 'video'),
        eq(approvalRequests.subjectId, videoId),
        eq(approvalRequests.status, 'approved'),
      ),
    )
    .orderBy(desc(approvalRequests.completedAt))
    .limit(1)

  if (!req) throw new GateError(`"${row.title}" has no completed approval on record.`)
  if (req.subjectVersion !== row.version) {
    throw new GateError(
      `"${row.title}" was regenerated after it was approved (approved v${req.subjectVersion}, now v${row.version}). The footage a reviewer signed off no longer exists, so it needs reviewing again.`,
    )
  }

  return row
}

export async function videoBlockReason(workspaceId: string, videoId: string): Promise<string | null> {
  try {
    await assertVideoUsable(workspaceId, videoId)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Not usable yet.'
  }
}

export async function pushBlockReason(workspaceId: string, adCampaignId: string): Promise<string | null> {
  try {
    await assertPushable(workspaceId, adCampaignId)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Not ready to push.'
  }
}

/** Non-throwing variant for rendering disabled states in the UI. */
export async function publishBlockReason(workspaceId: string, assetId: string): Promise<string | null> {
  try {
    await assertPublishable(workspaceId, assetId)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Not publishable.'
  }
}

/* -------------------------------------------------------------- helpers */

async function eligibleApprovers(workspaceId: string, step: ApprovalStep) {
  if (step.approverIds?.length) {
    return db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, step.approverIds))
  }
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, step.role as Role)))
}

async function canActOnStep(
  workspaceId: string,
  step: ApprovalStep,
  userId: string,
  role: Role,
): Promise<boolean> {
  if (role === 'owner') return true
  if (step.approverIds?.length) return step.approverIds.includes(userId)
  return role === step.role
}

async function notifyStep(
  workspaceId: string,
  requestId: string,
  chain: ApprovalChain,
  stepIndex: number,
  subject: ApprovalSubject | null | undefined,
) {
  const step = chain.steps[stepIndex]
  const approvers = await eligibleApprovers(workspaceId, step)
  if (approvers.length === 0) return
  await db.insert(notifications).values(
    approvers.map((a) => ({
      workspaceId,
      userId: a.id,
      type: 'approval.pending',
      title: `Review needed: "${subject?.title ?? 'an item'}"`,
      body: `${chain.name} — step ${stepIndex + 1} of ${chain.steps.length} (${step.name}). Due in ${step.slaHours}h.`,
      href: `/approvals/${requestId}`,
    })),
  )
}

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = mins / 60
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

/* ------------------------------------------------------------- queries */

/** Average approval time — the headline KPI on the Command Center (CC-2). */
export async function averageApprovalMs(workspaceId: string, sinceDays = 30): Promise<number | null> {
  const [row] = await db
    .select({ avg: sql<number>`avg(${approvalRequests.resolutionMs})::float` })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        inArray(approvalRequests.status, ['approved', 'rejected']),
        sql`${approvalRequests.completedAt} >= now() - ${sql.raw(`interval '${sinceDays} days'`)}`,
      ),
    )
  return row?.avg ?? null
}

export async function pendingQueue(workspaceId: string, forUser?: { id: string; role: Role }) {
  // Left joins, not inner: the queue holds two kinds of subject now, and an
  // inner join on assets silently hid every paid campaign awaiting review.
  const rows = await db
    .select({
      request: approvalRequests,
      chain: approvalChains,
      asset: assets,
      adCampaign: adCampaigns,
      searchAction: serpTwinActions,
      budgetPlan: budgetPlans,
      requester: { id: users.id, name: users.name, avatarHue: users.avatarHue },
    })
    .from(approvalRequests)
    .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .leftJoin(
      assets,
      and(eq(assets.id, approvalRequests.subjectId), eq(approvalRequests.subjectType, 'asset')),
    )
    .leftJoin(
      adCampaigns,
      and(
        eq(adCampaigns.id, approvalRequests.subjectId),
        eq(approvalRequests.subjectType, 'ad_campaign'),
      ),
    )
    .leftJoin(
      serpTwinActions,
      and(
        eq(serpTwinActions.id, approvalRequests.subjectId),
        eq(approvalRequests.subjectType, 'search_action'),
      ),
    )
    .leftJoin(
      budgetPlans,
      and(
        eq(budgetPlans.id, approvalRequests.subjectId),
        eq(approvalRequests.subjectType, 'budget_plan'),
      ),
    )
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, 'pending')))
    .orderBy(asc(approvalRequests.dueAt))

  return rows.map((r) => {
    const step = r.chain.steps[r.request.currentStep]
    const paid = r.adCampaign
    const search = r.searchAction
    const plan = r.budgetPlan
    const display = plan
      ? {
          title: plan.name,
          channel: 'google_ads',
          href: `/budget/plans/${plan.id}`,
          /** Monthly equivalent of the whole plan. */
          monthlySpend:
            (plan.totalPence / 100) *
            (30.4 / Math.max(1, (Date.parse(String(plan.periodEnd)) - Date.parse(String(plan.periodStart))) / 86_400_000 + 1)),
          currencyCode: plan.currency,
        }
      : search
      ? {
          title: search.title,
          channel: 'google_ads',
          href: `/search/actions/${search.id}`,
          monthlySpend: Math.abs(search.monthlyImpact),
          currencyCode: 'GBP',
        }
      : paid
      ? {
          title: paid.name,
          channel: 'google_ads',
          href: `/ads/${paid.id}`,
          /** Monthly ceiling, so a reviewer sees the money before approving. */
          monthlySpend: (paid.dailyBudgetMicros / 1_000_000) * 30.4,
          currencyCode: paid.currencyCode,
        }
      : {
          title: r.asset?.title ?? 'Untitled',
          channel: r.asset?.channel ?? null,
          href: `/studio/${r.request.subjectId}`,
          monthlySpend: 0,
          currencyCode: null,
        }
    const mine = forUser
      ? forUser.role === 'owner' ||
        (step?.approverIds?.length ? step.approverIds.includes(forUser.id) : step?.role === forUser.role)
      : false
    const overdue = r.request.dueAt ? r.request.dueAt.getTime() < Date.now() : false
    return { ...r, step, mine, overdue, display }
  })
}
