'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth/session'
import { assertCan, ForbiddenError } from '@/lib/auth/rbac'
import { GateError } from '@/lib/workflow/approvals'
import { z } from 'zod'
import {
  applyAction,
  revertAction,
  runAnalysis,
  saveProfile,
  SearchError,
  submitRecommendation,
  updateLeadOutcome,
} from '@/lib/search/service'
import type { BusinessProfile, LeadOutcome } from '@/lib/serptwin'
import type { ActionResult } from './content'

/**
 * Server actions for PPC & SEO. Thin on purpose: authenticate, check the
 * permission, call the service, turn a refusal into a sentence. The policy
 * lives in `lib/search/service.ts`.
 */

const failure = (e: unknown, fallback: string): ActionResult<never> => {
  if (e instanceof SearchError || e instanceof GateError || e instanceof ForbiddenError) {
    return { ok: false, message: e.message }
  }
  console.error('search action failed', e)
  return { ok: false, message: fallback }
}

function revalidate(actionId?: string) {
  revalidatePath('/search')
  revalidatePath('/approvals')
  if (actionId) revalidatePath(`/search/actions/${actionId}`)
}

export async function runSearchAnalysisAction(seed?: number): Promise<ActionResult<{ runId: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:analyse')
  } catch {
    return { ok: false, message: 'Your role can read the analysis but not run a new one.' }
  }
  try {
    const run = await runAnalysis({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      seed: Number.isFinite(seed) && seed && seed > 0 ? Math.floor(seed) : undefined,
    })
    revalidate()
    return {
      ok: true,
      message: `Analysis finished: ${run.recommendationCount} recommendations in ${run.durationMs ?? 0} ms.`,
      data: { runId: run.id },
    }
  } catch (e) {
    return failure(e, 'Could not run the analysis.')
  }
}

export async function submitSearchRecommendationAction(
  runId: string,
  recommendationId: string,
): Promise<ActionResult<{ actionId: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:analyse')
  } catch {
    return { ok: false, message: 'Your role cannot send search changes for approval.' }
  }
  try {
    const result = await submitRecommendation({
      workspaceId: auth.workspace.id,
      runId,
      recommendationId,
      actorId: auth.user.id,
    })
    revalidate(result.actionId)
    return {
      ok: true,
      message: `Sent to "${result.chainName}". ${result.stepName} has it now.`,
      data: { actionId: result.actionId },
    }
  } catch (e) {
    return failure(e, 'Could not send this for approval.')
  }
}

export async function applySearchAction(actionId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:apply')
  } catch {
    return { ok: false, message: 'Only owners and marketing ops can apply search changes.' }
  }
  try {
    const { simulated } = await applyAction({
      workspaceId: auth.workspace.id,
      actionId,
      actorId: auth.user.id,
    })
    revalidate(actionId)
    return {
      ok: true,
      message: simulated
        ? 'Recorded as applied (simulated). Nothing changed in Google Ads or on the site, because this analysis used simulated data.'
        : 'Applied.',
    }
  } catch (e) {
    return failure(e, 'Could not apply this change.')
  }
}

export async function revertSearchAction(actionId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:apply')
  } catch {
    return { ok: false, message: 'Only owners and marketing ops can revert search changes.' }
  }
  try {
    await revertAction({ workspaceId: auth.workspace.id, actionId, actorId: auth.user.id })
    revalidate(actionId)
    return { ok: true, message: 'Reverted. The undo is in the audit trail.' }
  } catch (e) {
    return failure(e, 'Could not revert this change.')
  }
}

const list = z.array(z.string().trim().min(1).max(80)).max(60)
const profileSchema = z.object({
  services: z
    .array(
      z.object({
        id: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/, 'Service ids use lower-case letters, numbers, - and _.'),
        name: z.string().trim().min(2).max(80),
        keywords: list,
        adGroupIds: z.array(z.string().trim().min(1).max(64)).max(60),
        marginPerCustomer: z.number().min(0).max(10_000_000),
        weeklyCapacity: z.number().int().min(0).max(100_000).nullable(),
        bookedThisWeek: z.number().int().min(0).max(100_000),
        landingPages: z.array(z.string().trim().url().max(500)).max(10),
        growthPriority: z.enum(['grow', 'maintain', 'reduce']),
      }),
    )
    .min(1, 'Add at least one service.')
    .max(30),
  serviceAreas: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Z]{2}(:[A-Z]{1,2})?$/, 'Areas look like GB, IE or GB:M.'),
    )
    .max(200),
  notOffered: list,
  followUpSlaHours: z.number().min(0.25).max(72),
  unreachableAfterAttempts: z.number().int().min(1).max(20),
  maxWeeklyBudgetChange: z.number().min(0.01).max(0.5),
})

export async function saveBusinessProfileAction(profile: BusinessProfile): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:apply')
  } catch {
    return {
      ok: false,
      message:
        'Only owners and marketing ops can change the business setup, because it steers budget recommendations.',
    }
  }
  const parsed = profileSchema.safeParse(profile)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, message: `${issue?.path.join(' → ') || 'Setup'}: ${issue?.message ?? 'not valid'}` }
  }
  const ids = parsed.data.services.map((s) => s.id)
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'Two services have the same id.' }
  const over = parsed.data.services.find(
    (s) => s.weeklyCapacity !== null && s.bookedThisWeek > s.weeklyCapacity * 3,
  )
  if (over)
    return { ok: false, message: `${over.name}: booked this week is far above capacity. Check the numbers.` }
  try {
    await saveProfile({ workspaceId: auth.workspace.id, profile: parsed.data, actorId: auth.user.id })
    revalidatePath('/search')
    revalidatePath('/search/setup')
    return { ok: true, message: 'Saved. Run the analysis again to use it.' }
  } catch (e) {
    return failure(e, 'Could not save the business setup.')
  }
}

export async function updateLeadOutcomeAction(input: {
  leadId: string
  outcome: LeadOutcome
  lostReason?: string | null
  contactAttempts?: number
}): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'search:analyse')
  } catch {
    return { ok: false, message: 'Your role cannot update enquiry outcomes.' }
  }
  try {
    await updateLeadOutcome({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...input })
    revalidatePath('/search/leads')
    return { ok: true, message: 'Saved. It will count in the next analysis.' }
  } catch (e) {
    return failure(e, 'Could not save that outcome.')
  }
}
