'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { GateError, submitForReview } from '@/lib/workflow/approvals'
import { VideoPolicyError } from '@/lib/video/policy'
import { replayVideo } from '@/lib/video/jobs'
import {
  loadVideo,
  quoteVideo,
  raiseVideoCeiling,
  requestVideoGeneration,
  videoPlaybackUrl,
  workspacePlan,
  type VideoQuote,
  type VideoQuoteInput,
} from '@/lib/video/service'
import type { ActionResult } from './content'

/**
 * Server actions for the video studio.
 *
 * Thin on purpose: authenticate, call the service, translate a refusal into a
 * message. All the policy lives in `lib/video`, so there is no path through
 * these actions that can skip the guardrails or the budget — which is the
 * property worth protecting.
 *
 * Refusal messages are passed through verbatim. They are written to be read by
 * the person who triggered them and they name the figure, the field or the
 * rule that has to change; rewording them here would only make them vaguer.
 */

const failure = (e: unknown, fallback: string): ActionResult<never> => {
  if (e instanceof VideoPolicyError || e instanceof GateError) {
    return { ok: false, message: e.message }
  }
  console.error('video action failed', e)
  return { ok: false, message: fallback }
}

/** Price and check a brief. Writes nothing; safe to call as the user types. */
export async function quoteVideoAction(input: VideoQuoteInput): Promise<ActionResult<VideoQuote>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'video:create')
  } catch {
    return { ok: false, message: 'Your role cannot generate video, because generating spends from the workspace budget.' }
  }

  try {
    const plan = await workspacePlan(auth.workspace.id)
    const quote = await quoteVideo({ workspaceId: auth.workspace.id, role: auth.role, plan, input })
    return { ok: true, message: 'Priced.', data: quote }
  } catch (e) {
    return failure(e, 'Could not price this brief.')
  }
}

/**
 * Commit to generating.
 *
 * The two acknowledgement fields are required rather than defaulted: a request
 * without them is a client that never showed anyone a price, and it is refused
 * here rather than quietly allowed through.
 */
export async function generateVideoAction(args: {
  input: VideoQuoteInput
  acknowledgedFingerprint: string
  acknowledgedTotalCents: number
  briefId?: string | null
  campaignId?: string | null
  supersedesId?: string | null
}): Promise<ActionResult<{ ids: string[]; simulated: boolean }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'video:create')
  } catch {
    return { ok: false, message: 'Your role cannot generate video.' }
  }

  if (!args.acknowledgedFingerprint || typeof args.acknowledgedTotalCents !== 'number') {
    return {
      ok: false,
      message: 'Confirm the cost before generating — the figure you were shown has to come back with the request.',
    }
  }

  try {
    const plan = await workspacePlan(auth.workspace.id)
    const rows = await requestVideoGeneration({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      role: auth.role,
      plan,
      briefId: args.briefId ?? null,
      campaignId: args.campaignId ?? null,
      input: args.input,
      acknowledgedFingerprint: args.acknowledgedFingerprint,
      acknowledgedTotalCents: args.acknowledgedTotalCents,
      supersedesId: args.supersedesId ?? null,
    })

    revalidatePath('/studio/video')
    return {
      ok: true,
      message:
        rows.length === 1
          ? 'Generating. It usually takes under two minutes.'
          : `Generating ${rows.length} variants. They usually take under two minutes.`,
      data: { ids: rows.map((r) => r.id), simulated: rows[0]?.simulated ?? false },
    }
  } catch (e) {
    return failure(e, 'Could not start the generation.')
  }
}

/** Current state for the studio's poller. */
export async function videoStatusAction(ids: string[]): Promise<
  ActionResult<
    Array<{
      id: string
      title: string
      status: string
      version: number
      simulated: boolean
      playbackUrl: string | null
      mediaCheckPassed: boolean | null
      blockingFindings: string[]
      lastError: string | null
      actualCostCents: number | null
      estimatedCostCents: number
      durationSeconds: number | null
      width: number | null
      height: number | null
      hasAudio: boolean | null
      watermark: string | null
    }>
  >
> {
  const auth = await requireAuth()
  try {
    const rows = await Promise.all(ids.slice(0, 12).map((id) => loadVideo(auth.workspace.id, id)))
    return {
      ok: true,
      message: 'ok',
      data: rows
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          version: r.version,
          simulated: r.simulated,
          playbackUrl: videoPlaybackUrl(r),
          mediaCheckPassed: r.mediaCheck ? r.mediaCheck.passed : null,
          blockingFindings: (r.mediaCheck?.findings ?? [])
            .filter((f) => f.severity === 'high')
            .map((f) => f.message),
          lastError: r.lastError,
          actualCostCents: r.actualCostCents,
          estimatedCostCents: r.estimatedCostCents,
          durationSeconds: r.mediaFacts?.durationSeconds ?? null,
          width: r.mediaFacts?.width ?? null,
          height: r.mediaFacts?.height ?? null,
          hasAudio: r.mediaFacts?.hasAudio ?? null,
          watermark: r.provenance?.watermark ?? null,
        })),
    }
  } catch (e) {
    return failure(e, 'Could not read the generation status.')
  }
}

/** Send a finished clip into the approvals queue. */
export async function submitVideoForReviewAction(id: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'asset:submit')
  } catch {
    return { ok: false, message: 'Your role cannot submit work for review.' }
  }

  try {
    const result = await submitForReview({
      workspaceId: auth.workspace.id,
      subjectType: 'video',
      subjectId: id,
      actorId: auth.user.id,
    })
    revalidatePath('/studio/video')
    revalidatePath(`/studio/video/${id}`)
    revalidatePath('/approvals')
    return { ok: true, message: `Sent to "${result.chainName}" — ${result.stepName} has it now.` }
  } catch (e) {
    return failure(e, 'Could not submit this clip for review.')
  }
}

/** Raise or lower the monthly video budget. Owners and marketing ops only. */
export async function setVideoBudgetAction(args: {
  toUsd: number
  reason: string
}): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'video:budget')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can change the video budget.' }
  }

  try {
    const plan = await workspacePlan(auth.workspace.id)
    await raiseVideoCeiling({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      role: auth.role,
      plan,
      toCents: Math.round(args.toUsd * 100),
      reason: args.reason,
    })
    revalidatePath('/studio/video')
    revalidatePath('/settings/billing')
    return { ok: true, message: 'Budget updated and recorded in the audit trail.' }
  } catch (e) {
    return failure(e, 'Could not change the budget.')
  }
}

/** Operator action: push a dead-lettered generation back into the queue. */
export async function replayVideoAction(id: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'video:create')
  } catch {
    return { ok: false, message: 'Your role cannot retry a generation.' }
  }

  try {
    const outcome = await replayVideo(auth.workspace.id, auth.user.id, id)
    revalidatePath('/studio/video')
    return { ok: true, message: outcome.message }
  } catch (e) {
    return failure(e, 'Could not retry this generation.')
  }
}
