import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  brandProfiles,
  legalRules,
  videoBudgets,
  videoGenerations,
  workspaces,
  type Channel,
  type Plan,
  type Role,
  type ScoreDetail,
  type VideoGeneration,
} from '@/lib/db/schema'
import { env } from '@/lib/env'
import { recordAudit } from '@/lib/workflow/audit'
import { pricingIsStale, videoModel, type VideoAspect, type VideoResolution } from './catalogue'
import { scoreVideoRequest, videoRefusalMessage, videoScorePasses } from './guardrails'
import {
  canGenerateVideo,
  canRaiseVideoCeiling,
  capsForPlan,
  checkCeiling,
  enforceCeiling,
  estimateVideoCost,
  money,
  resolveVideoPolicy,
  verifyAcknowledgement,
  VideoPolicyError,
  VIDEO_CHANNEL_ASPECT,
  type VideoCostEstimate,
} from './policy'
import {
  buildNegativePrompt,
  buildVideoPrompt,
  normalizeCreativeMode,
  normalizeVideoReferences,
  type VideoCreativeMode,
  type VideoReferenceAsset,
} from './prompt'
import { signPlaybackUrl } from './storage'

/**
 * Video generation, orchestrated.
 *
 * The order of operations in `requestVideoGeneration` is the governance, and
 * it is not arbitrary:
 *
 *   1. Role        — may this person spend at all?
 *   2. Policy      — what will the plan actually allow?
 *   3. Guardrails  — free, deterministic, and run before anything costs money.
 *   4. Ceiling     — is there budget left this month?
 *   5. Acknowledge — did they confirm the figure, and is it still current?
 *   6. Persist     — a row exists before any provider call, so a crash between
 *                    here and the provider leaves evidence rather than a gap.
 *   7. Queue       — the provider call happens on the worker, never in a
 *                    request. Generation is minutes, not milliseconds.
 *
 * Steps 1–5 all refuse without spending anything, every refusal names what to
 * change, and every refusal is written to the audit chain — the record that
 * the gate was closed on a given day for a given reason is exactly what an
 * auditor asks about.
 */

export type VideoQuoteInput = {
  title: string
  prompt: string
  script: string | null
  channel: Channel
  resolution: VideoResolution
  durationSeconds: number
  variants: number
  audio: boolean
  aspectRatio?: VideoAspect
  requestedModel?: string | null
  creativeMode?: VideoCreativeMode
  referenceAssets?: VideoReferenceAsset[]
}

export type VideoQuote = {
  estimate: VideoCostEstimate
  score: ScoreDetail
  adjustments: string[]
  aspectRatio: VideoAspect
  resolution: VideoResolution
  durationSeconds: number
  variants: number
  audio: boolean
  model: string
  modelLabel: string
  directorPrompt: string
  referenceAssets: VideoReferenceAsset[]
  simulated: boolean
  ceiling: { ceilingCents: number; spentCents: number; remainingCents: number; wouldExceed: boolean }
  pricingUnverified: boolean
  canProceed: boolean
  blockedReason: string | null
}

/* --------------------------------------------------------------- budgets */

/**
 * Month-to-date video spend.
 *
 * In-flight rows count at their estimate and finished ones at what they
 * actually cost, so a burst of generations cannot slip under the ceiling
 * simply by being unfinished. Failed and dead-lettered rows are excluded:
 * counting a refusal forever would mean a workspace that once hit a wall could
 * never generate again.
 */
export async function monthToDateVideoSpend(workspaceId: string, now = new Date()): Promise<number> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const [row] = await db
    .select({
      cents: sql<number>`coalesce(sum(coalesce(${videoGenerations.actualCostCents}, ${videoGenerations.estimatedCostCents})), 0)::int`,
    })
    .from(videoGenerations)
    .where(
      and(
        eq(videoGenerations.workspaceId, workspaceId),
        gte(videoGenerations.createdAt, startOfMonth),
        sql`${videoGenerations.status} not in ('failed', 'dead_letter')`,
        eq(videoGenerations.simulated, false),
      ),
    )
  return row?.cents ?? 0
}

/** The live ceiling: the most recent budget row that has taken effect, else the plan default. */
export async function currentVideoCeiling(workspaceId: string, plan: Plan): Promise<number> {
  const [row] = await db
    .select({ ceilingCents: videoBudgets.ceilingCents })
    .from(videoBudgets)
    .where(and(eq(videoBudgets.workspaceId, workspaceId), sql`${videoBudgets.effectiveFrom} <= now()`))
    .orderBy(desc(videoBudgets.effectiveFrom))
    .limit(1)
  return row?.ceilingCents ?? capsForPlan(plan).defaultCeilingCents
}

/**
 * Raising the ceiling is a spend decision, so it is restricted to the roles
 * that may turn a campaign on, and it is appended rather than updated. Who
 * authorised what spend, and why, is not something an UPDATE should be able to
 * erase.
 */
export async function raiseVideoCeiling(args: {
  workspaceId: string
  actorId: string
  role: Role
  plan: Plan
  toCents: number
  reason: string
}): Promise<void> {
  if (!canRaiseVideoCeiling(args.role)) {
    throw new VideoPolicyError(
      'not_permitted',
      'Only an owner or marketing ops can change the monthly video budget.',
    )
  }
  if (!Number.isInteger(args.toCents) || args.toCents < 0) {
    throw new VideoPolicyError('invalid_request', 'A budget must be a whole, non-negative amount.')
  }
  if (!args.reason.trim()) {
    throw new VideoPolicyError(
      'invalid_request',
      'Raising the video budget needs a reason. It is recorded against your name in the audit trail.',
    )
  }

  const previous = await currentVideoCeiling(args.workspaceId, args.plan)

  await db.insert(videoBudgets).values({
    workspaceId: args.workspaceId,
    ceilingCents: args.toCents,
    previousCeilingCents: previous,
    reason: args.reason.trim(),
    setBy: args.actorId,
  })

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'video.budget_changed',
    subjectType: 'workspace',
    subjectId: args.workspaceId,
    summary: `Monthly video budget changed from ${money(previous)} to ${money(args.toCents)}: ${args.reason.trim()}`,
    payload: { fromCents: previous, toCents: args.toCents, reason: args.reason.trim() },
  })
}

/* ---------------------------------------------------------------- quoting */

/**
 * What this would cost and whether it would be allowed. Spends nothing,
 * writes nothing, and is safe to call on every keystroke.
 */
export async function quoteVideo(args: {
  workspaceId: string
  role: Role
  plan: Plan
  input: VideoQuoteInput
}): Promise<VideoQuote> {
  const { workspaceId, role, plan, input } = args

  if (!canGenerateVideo(role)) {
    throw new VideoPolicyError(
      'not_permitted',
      `Your role cannot start a video generation, because generating spends from the workspace budget.`,
    )
  }

  const aspectRatio = input.aspectRatio ?? VIDEO_CHANNEL_ASPECT[input.channel] ?? '16:9'
  const requestedReferences = normalizeVideoReferences(input.referenceAssets)

  const policy = resolveVideoPolicy({
    plan,
    primaryProvider: env().VIDEO_PROVIDER,
    requestedModel: input.requestedModel ?? null,
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
    aspectRatio,
    variants: input.variants,
    audio: input.audio,
    referenceCount: requestedReferences.length,
  })
  const referenceAssets = requestedReferences.slice(0, policy.maxReferenceImages)
  const creativeMode = normalizeCreativeMode(input.creativeMode)
  const directorPrompt = buildVideoPrompt({
    title: input.title,
    prompt: input.prompt,
    script: input.script,
    channel: input.channel,
    durationSeconds: policy.durationSeconds,
    aspectRatio: policy.aspectRatio,
    audio: policy.audio,
    creativeMode,
    references: referenceAssets,
  })

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, workspaceId), eq(brandProfiles.isDefault, true)))
    .limit(1)
  if (!profile) {
    throw new VideoPolicyError(
      'no_brand_profile',
      'There is no default brand profile, so nothing can be scored before it is generated. Add one in Settings → Brand.',
    )
  }
  const rules = await db.select().from(legalRules).where(eq(legalRules.workspaceId, workspaceId))

  const score = scoreVideoRequest({
    title: input.title,
    prompt: directorPrompt,
    script: input.script,
    channel: input.channel,
    durationSeconds: policy.durationSeconds,
    aspectRatio: policy.aspectRatio,
    resolution: policy.resolution,
    audio: policy.audio,
    references: referenceAssets,
    profile,
    legalRules: rules,
  })

  const estimate = estimateVideoCost(policy)
  const ceilingCents = await currentVideoCeiling(workspaceId, plan)
  const spentCents = await monthToDateVideoSpend(workspaceId)
  const ceiling = checkCeiling({ ceilingCents, spentCents, requestedCents: estimate.totalCents })

  const passes = videoScorePasses(score)
  const blockedReason = !passes
    ? videoRefusalMessage(score)
    : ceiling.wouldExceed
      ? ceiling.ceilingCents === 0
        ? 'Video generation is not included on this plan.'
        : `This would spend ${money(estimate.totalCents)} against ${money(ceiling.remainingCents)} left this month.`
      : null

  return {
    estimate,
    score,
    adjustments: policy.adjustments,
    aspectRatio: policy.aspectRatio,
    resolution: policy.resolution,
    durationSeconds: policy.durationSeconds,
    variants: policy.variants,
    audio: policy.audio,
    model: policy.model.id,
    modelLabel: policy.model.label,
    directorPrompt,
    referenceAssets,
    simulated: policy.model.providerId === 'simulator',
    ceiling: {
      ceilingCents: ceiling.ceilingCents,
      spentCents: ceiling.spentCents,
      remainingCents: ceiling.remainingCents,
      wouldExceed: ceiling.wouldExceed,
    },
    pricingUnverified: pricingIsStale(policy.model, new Date()),
    canProceed: blockedReason === null,
    blockedReason,
  }
}

/* ------------------------------------------------------------- requesting */

export type RequestVideoArgs = {
  workspaceId: string
  actorId: string
  role: Role
  plan: Plan
  briefId?: string | null
  campaignId?: string | null
  input: VideoQuoteInput
  /** Echoed back from the quote the person actually saw. */
  acknowledgedFingerprint: string
  acknowledgedTotalCents: number
  /** Set when regenerating; its approval is voided and the version increments. */
  supersedesId?: string | null
}

export async function requestVideoGeneration(args: RequestVideoArgs): Promise<VideoGeneration[]> {
  const { workspaceId, actorId, input } = args

  // Everything the quote checked is checked again here from the server's own
  // state. The client's quote is a courtesy for the UI, never an authorisation
  // it can replay.
  const quote = await quoteVideo({ workspaceId, role: args.role, plan: args.plan, input })

  if (!videoScorePasses(quote.score)) {
    await recordAudit({
      workspaceId,
      actorId,
      action: 'video.refused',
      subjectType: 'video',
      subjectId: null,
      summary: `Video generation refused before any spend: ${quote.score.compliance.findings.filter((f) => f.severity === 'high').map((f) => f.ruleName).join(', ') || 'below the brand pass threshold'}.`,
      payload: {
        reason: 'guardrail',
        composite: quote.score.composite,
        findings: quote.score.compliance.findings.filter((f) => f.severity === 'high').map((f) => f.ruleId),
      },
    })
    throw new VideoPolicyError('guardrail_blocked', videoRefusalMessage(quote.score))
  }

  const ceiling = checkCeiling({
    ceilingCents: quote.ceiling.ceilingCents,
    spentCents: quote.ceiling.spentCents,
    requestedCents: quote.estimate.totalCents,
  })
  if (ceiling.wouldExceed) {
    await recordAudit({
      workspaceId,
      actorId,
      action: 'video.refused',
      subjectType: 'video',
      subjectId: null,
      summary: `Video generation refused: monthly budget reached (${money(ceiling.spentCents)} of ${money(ceiling.ceilingCents)} spent, ${money(ceiling.requestedCents)} requested).`,
      payload: { reason: 'ceiling', ...ceiling },
    })
  }
  enforceCeiling(ceiling)

  verifyAcknowledgement({
    current: quote.estimate,
    presentedFingerprint: args.acknowledgedFingerprint,
    presentedTotalCents: args.acknowledgedTotalCents,
  })

  /* Regeneration: void the previous approval before the new version exists, so
     a crash between the two leaves nothing approved rather than something
     approved that nobody reviewed. */
  let lineageId = randomUUID()
  let version = 1
  if (args.supersedesId) {
    const previous = await loadVideo(workspaceId, args.supersedesId)
    if (!previous) throw new VideoPolicyError('not_found', 'There is no such generation to replace.')
    lineageId = previous.lineageId as typeof lineageId
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${videoGenerations.version}), 0)::int` })
      .from(videoGenerations)
      .where(eq(videoGenerations.lineageId, lineageId))
    version = max + 1
    await voidApprovalForRegeneration(workspaceId, previous, actorId)
  }

  const model = videoModel(quote.model)
  const providerId = model?.providerId ?? 'simulator'
  const simulated = providerId === 'simulator'
  const promptHash = createHash('sha256').update(quote.directorPrompt.normalize('NFC')).digest('hex')
  const negativePrompt = model?.supportsNegativePrompt ? buildNegativePrompt(quote.referenceAssets) : null
  const now = new Date()

  const created: VideoGeneration[] = []

  for (let i = 0; i < quote.variants; i++) {
    const [row] = await db
      .insert(videoGenerations)
      .values({
        workspaceId,
        briefId: args.briefId ?? null,
        campaignId: args.campaignId ?? null,
        lineageId: quote.variants > 1 && !args.supersedesId ? randomUUID() : lineageId,
        version,
        title: quote.variants > 1 ? `${input.title} — ${String.fromCharCode(65 + i)}` : input.title,
        status: 'queued',
        stage: 'generate',
        providerId,
        model: quote.model,
        simulated,
        prompt: quote.directorPrompt,
        promptHash,
        script: input.script,
        negativePrompt,
        referenceAssets: quote.referenceAssets,
        channel: input.channel,
        aspectRatio: quote.aspectRatio,
        resolution: quote.resolution,
        durationSeconds: quote.durationSeconds,
        audio: quote.audio,
        estimatedCostCents: quote.estimate.perVariantCents,
        acknowledgedBy: actorId,
        acknowledgedCostCents: args.acknowledgedTotalCents,
        acknowledgedAt: now,
        scoreDetail: quote.score,
        createdBy: actorId,
      })
      .returning()

    await recordAudit({
      workspaceId,
      actorId,
      action: args.supersedesId ? 'video.regenerated' : 'video.requested',
      subjectType: 'video',
      subjectId: row.id,
      summary: args.supersedesId
        ? `"${row.title}" regenerated as v${version}. Any approval on the previous version is void.`
        : `"${row.title}" requested — ${quote.durationSeconds}s ${quote.aspectRatio} on ${quote.modelLabel}, ${money(quote.estimate.perVariantCents)}${simulated ? ' (simulated)' : ''}.`,
      payload: {
        promptHash,
        referenceAssetKinds: quote.referenceAssets.map((r) => r.kind),
        model: quote.model,
        providerId,
        resolution: quote.resolution,
        aspectRatio: quote.aspectRatio,
        durationSeconds: quote.durationSeconds,
        audio: quote.audio,
        estimatedCostCents: quote.estimate.perVariantCents,
        acknowledgedTotalCents: args.acknowledgedTotalCents,
        guardrailComposite: quote.score.composite,
        simulated,
        version,
        adjustments: quote.adjustments,
      },
    })

    created.push(row)
  }

  return created
}

/* ----------------------------------------------------------------- reads */

export async function loadVideo(workspaceId: string, id: string): Promise<VideoGeneration | null> {
  const [row] = await db
    .select()
    .from(videoGenerations)
    .where(and(eq(videoGenerations.workspaceId, workspaceId), eq(videoGenerations.id, id)))
    .limit(1)
  return row ?? null
}

/** A short-lived playback URL, generated per request. Never a public object. */
export function videoPlaybackUrl(row: VideoGeneration): string | null {
  if (!row.storageKey) return null
  return signPlaybackUrl(row.storageKey, env().VIDEO_SIGNED_URL_TTL_SECONDS)
}

export async function workspacePlan(workspaceId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row?.plan ?? 'trial'
}

/* ------------------------------------------------------------- internals */

/**
 * Regenerating is not editing. The clip a reviewer approved no longer exists —
 * it was never a text change that could be eyeballed, it is entirely different
 * footage from a non-deterministic model. So a regeneration always voids the
 * approval, with no "minor change" path. There is no such thing as a minor
 * change to a video generation.
 */
async function voidApprovalForRegeneration(
  workspaceId: string,
  previous: VideoGeneration,
  actorId: string,
): Promise<void> {
  const { approvalRequests } = await import('@/lib/db/schema')
  await db
    .update(approvalRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.subjectType, 'video'),
        eq(approvalRequests.subjectId, previous.id),
        eq(approvalRequests.status, 'pending'),
      ),
    )

  await db
    .update(videoGenerations)
    .set({ status: 'changes_requested', updatedAt: new Date() })
    .where(and(eq(videoGenerations.id, previous.id), eq(videoGenerations.status, 'approved')))

  await recordAudit({
    workspaceId,
    actorId,
    action: 'approval.invalidated',
    subjectType: 'video',
    subjectId: previous.id,
    summary: `Approval for "${previous.title}" v${previous.version} is void: it was regenerated, so the footage a reviewer saw no longer exists.`,
    payload: { previousVersion: previous.version },
  })
}
