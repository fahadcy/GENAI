'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/session'
import { assertCan, ForbiddenError, type Permission } from '@/lib/auth/rbac'
import {
  activatePlan,
  applyAdDailyBudget,
  applyAllocation,
  assignTransaction,
  balanceLines,
  BudgetError,
  closePlan,
  connectAirwallex,
  createPlan,
  enforceCardLimit,
  importHistoryCsv,
  importStatement,
  loadPlan,
  loadSimulation,
  removeCard,
  removeLine,
  revisePlan,
  runAllocation,
  runReconciliation,
  saveLine,
  setCardChannel,
  setDiscrepancyStatus,
  syncCard,
  syncFromAurea,
  addSimulatedCard,
  updatePlanSettings,
} from '@/lib/budget/service'
import { CardApiError } from '@/lib/budget/cards/http'
import { CsvError } from '@/lib/budget/cards/csv'
import { cookies } from 'next/headers'
import { newNonce, NONCE_COOKIE, trueLayerAuthUrl, trueLayerConfigured } from '@/lib/budget/cards/truelayer'
import { submitForReview, GateError } from '@/lib/workflow/approvals'
import { raiseVideoCeiling, workspacePlan } from '@/lib/video/service'
import { VideoPolicyError } from '@/lib/video/policy'
import { env } from '@/lib/env'
import { money } from '@/lib/budget/money'
import type { ActionResult } from './content'

/**
 * Server actions for the Budget Allocator. Thin on purpose: authenticate,
 * check the permission, validate, call the service, turn a refusal into a
 * sentence a marketer can act on.
 */

const DENIED: Record<string, string> = {
  'budget:plan': 'Only owners, marketing ops and growth marketers can plan budgets.',
  'budget:activate': 'Only owners and marketing ops can make a budget live or push its figures into campaigns.',
  'budget:cards': 'Only owners and marketing ops can connect or control payment cards.',
}

async function authorised(permission: Permission) {
  const auth = await requireAuth()
  assertCan(auth.role, permission)
  return auth
}

function failure(e: unknown, fallback: string): ActionResult<never> {
  if (e instanceof BudgetError || e instanceof GateError || e instanceof CsvError || e instanceof ForbiddenError || e instanceof VideoPolicyError) return { ok: false, message: e.message }
  if (e instanceof CardApiError) return { ok: false, message: e.message }
  console.error('budget action failed', e)
  return { ok: false, message: fallback }
}

function revalidate(planId?: string) {
  revalidatePath('/budget')
  if (planId) revalidatePath(`/budget/plans/${planId}`)
}

async function guard<T>(permission: Permission, fn: (auth: Awaited<ReturnType<typeof requireAuth>>) => Promise<ActionResult<T>>, fallback: string): Promise<ActionResult<T>> {
  let auth
  try {
    auth = await authorised(permission)
  } catch {
    return { ok: false, message: DENIED[permission] ?? 'Not permitted.' }
  }
  try {
    return await fn(auth)
  } catch (e) {
    return failure(e, fallback)
  }
}

const pence = z.number().int().min(0).max(1_000_000_000_00)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.')

/* ---------------------------------------------------------------- plans */

const newPlanSchema = z.object({
  name: z.string().trim().min(2, 'Name the plan.').max(120),
  periodStart: isoDate,
  periodEnd: isoDate,
  totalPence: pence.refine((v) => v > 0, 'Set a total above zero.'),
  objective: z.enum(['conversions', 'revenue', 'profit']),
  start: z.enum(['starter', 'history', 'blank']),
  valuePerConversionPence: pence.nullable().optional(),
  cardLimitPence: pence.nullable().optional(),
  simulate: z.boolean().optional(),
})

export async function createPlanAction(input: z.infer<typeof newPlanSchema>): Promise<ActionResult<{ id: string }>> {
  return guard(
    'budget:plan',
    async (auth) => {
      const p = newPlanSchema.safeParse(input)
      if (!p.success) return { ok: false, message: p.error.issues[0]?.message ?? 'Check the form.' }
      await syncFromAurea(auth.workspace.id).catch((e) => console.error('budget: sync before plan failed', e))
      const plan = await createPlan({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...p.data })
      if (p.data.simulate) await loadSimulation({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId: plan.id })
      revalidate(plan.id)
      return { ok: true, message: `"${plan.name}" created with ${plan.lines.length} lines.`, data: { id: plan.id } }
    },
    'Could not create the plan.',
  )
}

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  totalPence: pence.optional(),
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  objective: z.enum(['conversions', 'revenue', 'profit']).optional(),
  riskAversion: z.number().min(0).max(1).optional(),
  learningShare: z.number().min(0).max(0.25).optional(),
  maxShift: z.number().min(0.05).max(2).nullable().optional(),
  valuePerConversionPence: pence.nullable().optional(),
  cardLimitPence: pence.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

export async function updatePlanAction(planId: string, patch: z.infer<typeof settingsSchema>): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      const p = settingsSchema.safeParse(patch)
      if (!p.success) return { ok: false, message: p.error.issues[0]?.message ?? 'Check the settings.' }
      await updatePlanSettings({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId, patch: p.data })
      revalidate(planId)
      return { ok: true, message: 'Saved. The plan needs approving again before it can go live.' }
    },
    'Could not save the settings.',
  )
}

const lineSchema = z.object({
  id: z.string().uuid().optional(),
  channelKey: z.string().min(2).max(48),
  label: z.string().trim().max(80).optional(),
  plannedPence: pence,
  minPence: pence.optional(),
  maxPence: pence.nullable().optional(),
  locked: z.boolean().optional(),
  allowExtrapolation: z.boolean().optional(),
  incrementality: z.number().min(0.01).max(1.5).optional(),
  incrementalitySource: z.string().trim().max(200).nullable().optional(),
  adCampaignIds: z.array(z.string().uuid()).max(50).optional(),
  notes: z.string().max(500).nullable().optional(),
})

export async function saveLineAction(planId: string, line: z.infer<typeof lineSchema>): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      const p = lineSchema.safeParse(line)
      if (!p.success) return { ok: false, message: p.error.issues[0]?.message ?? 'Check the line.' }
      const row = await saveLine({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId, line: p.data })
      revalidate(planId)
      return { ok: true, message: `${row.label} saved.` }
    },
    'Could not save the line.',
  )
}

export async function removeLineAction(planId: string, lineId: string): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      await removeLine({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId, lineId })
      revalidate(planId)
      return { ok: true, message: 'Line removed.' }
    },
    'Could not remove the line.',
  )
}

export async function balanceLinesAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      await balanceLines({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      return { ok: true, message: 'Unlocked lines scaled to match the total.' }
    },
    'Could not balance the lines.',
  )
}

export async function submitPlanAction(planId: string): Promise<ActionResult<{ chain: string }>> {
  return guard(
    'budget:plan',
    async (auth) => {
      const r = await submitForReview({ workspaceId: auth.workspace.id, subjectType: 'budget_plan', subjectId: planId, actorId: auth.user.id })
      revalidate(planId)
      revalidatePath('/approvals')
      return { ok: true, message: `Sent to "${r.chainName}" — ${r.stepName}.`, data: { chain: r.chainName } }
    },
    'Could not submit the plan.',
  )
}

export async function activatePlanAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:activate',
    async (auth) => {
      const p = await activatePlan({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      await runReconciliation({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId }).catch(() => undefined)
      revalidate(planId)
      return { ok: true, message: `"${p.name}" is live.` }
    },
    'Could not make the plan live.',
  )
}

export async function closePlanAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:activate',
    async (auth) => {
      await closePlan({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      return { ok: true, message: 'Plan closed.' }
    },
    'Could not close the plan.',
  )
}

export async function revisePlanAction(planId: string): Promise<ActionResult<{ id: string }>> {
  return guard(
    'budget:plan',
    async (auth) => {
      const rev = await revisePlan({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      return { ok: true, message: 'Revision drafted. Change it, then send it for approval.', data: { id: rev.id } }
    },
    'Could not draft a revision.',
  )
}

/* ------------------------------------------------------------ allocator */

export async function runAllocationAction(planId: string): Promise<ActionResult<{ id: string }>> {
  return guard(
    'budget:plan',
    async (auth) => {
      await syncFromAurea(auth.workspace.id).catch((e) => console.error('budget: sync failed', e))
      const run = await runAllocation({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      return { ok: true, message: run.result.summary.split('. ')[0] + '.', data: { id: run.id } }
    },
    'The allocator could not run.',
  )
}

export async function applyAllocationAction(allocationId: string): Promise<ActionResult<{ planId: string; revision: boolean }>> {
  return guard(
    'budget:plan',
    async (auth) => {
      const plan = await applyAllocation({ workspaceId: auth.workspace.id, actorId: auth.user.id, allocationId })
      revalidate(plan.id)
      if (plan.parentPlanId) revalidate(plan.parentPlanId)
      return {
        ok: true,
        message: plan.parentPlanId ? 'Recommendation drafted as a revision. Send it for approval to replace the live plan.' : 'Recommendation applied to the draft.',
        data: { planId: plan.id, revision: Boolean(plan.parentPlanId) },
      }
    },
    'Could not apply the recommendation.',
  )
}

export async function loadSimulationAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      await loadSimulation({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      return { ok: true, message: 'Simulated market loaded. Everything it produced is labelled simulated.' }
    },
    'Could not load the simulation.',
  )
}

export async function importHistoryAction(text: string): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      if (text.length > 3_000_000) return { ok: false, message: 'The file is too large.' }
      const r = await importHistoryCsv({ workspaceId: auth.workspace.id, actorId: auth.user.id, text })
      revalidate()
      return { ok: true, message: `${r.rows} weeks imported${r.skipped ? `, ${r.skipped} rows skipped` : ''}.` }
    },
    'Could not import the history.',
  )
}

/* ------------------------------------------------------- reconciliation */

export async function reconcileAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:plan',
    async (auth) => {
      await syncFromAurea(auth.workspace.id).catch(() => undefined)
      const r = await runReconciliation({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId })
      revalidate(planId)
      const n = r.report.discrepancies.length
      return { ok: true, message: n ? `${n} discrepanc${n === 1 ? 'y' : 'ies'} found.` : 'Plan, platforms and card agree.' }
    },
    'Could not reconcile.',
  )
}

/**
 * Explaining away a discrepancy, or saying a charge is not marketing, is a
 * finance decision: it silences an alert about money. The people spending the
 * budget should not be the ones who can do it, so it sits with budget:cards.
 */
export async function discrepancyAction(id: string, status: 'open' | 'explained' | 'resolved', note: string | null): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      await setDiscrepancyStatus({ workspaceId: auth.workspace.id, actorId: auth.user.id, id, status, note })
      revalidate()
      return { ok: true, message: status === 'open' ? 'Reopened.' : `Marked ${status}.` }
    },
    'Could not update the discrepancy.',
  )
}

/* ---------------------------------------------------------------- cards */

export async function addSimulatedCardAction(): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      await addSimulatedCard({ workspaceId: auth.workspace.id, actorId: auth.user.id })
      revalidate()
      return { ok: true, message: 'Simulated card added.' }
    },
    'Could not add the card.',
  )
}

export async function importStatementAction(input: {
  cardId: string | null
  label: string
  last4: string | null
  text: string
  sign: 'auto' | 'charges_positive' | 'charges_negative'
}): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      const r = await importStatement({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...input })
      revalidate()
      return {
        ok: true,
        message: `${r.added} new transaction${r.added === 1 ? '' : 's'} imported (${r.total - r.added} already known${r.skipped ? `, ${r.skipped} skipped` : ''}). Read "${r.detected.descriptionColumn}" as the merchant; purchases were ${r.detected.sign === 'charges_negative' ? 'negative' : 'positive'} in the file.`,
      }
    },
    'Could not import the statement.',
  )
}

export async function trueLayerStartAction(): Promise<ActionResult<{ url: string }>> {
  return guard(
    'budget:cards',
    async (auth) => {
      if (!trueLayerConfigured()) {
        return { ok: false, message: 'Open Banking is not configured. Set TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET in .env.local.' }
      }
      const nonce = newNonce()
      ;(await cookies()).set(NONCE_COOKIE, nonce, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env().NODE_ENV === 'production',
        path: '/api/budget/truelayer',
        maxAge: 15 * 60,
      })
      return { ok: true, message: 'Redirecting to your bank…', data: { url: trueLayerAuthUrl(auth.workspace.id, auth.user.id, nonce) } }
    },
    'Could not start the bank connection.',
  )
}

export async function connectAirwallexAction(input: { clientId: string; apiKey: string; demo: boolean }): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      const cards = await connectAirwallex({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...input })
      revalidate()
      return { ok: true, message: `${cards.length} Airwallex card${cards.length === 1 ? '' : 's'} connected.` }
    },
    'Could not connect Airwallex.',
  )
}

export async function syncCardAction(cardId: string): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      const r = await syncCard(auth.workspace.id, cardId)
      revalidate()
      return { ok: true, message: `${r.added} new transaction${r.added === 1 ? '' : 's'}.` }
    },
    'Could not sync the card.',
  )
}

export async function setCardChannelAction(cardId: string, channelKey: string | null): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      await setCardChannel({ workspaceId: auth.workspace.id, actorId: auth.user.id, cardId, channelKey })
      revalidate()
      return { ok: true, message: channelKey ? 'Every charge on this card now belongs to that line.' : 'Card is shared again.' }
    },
    'Could not update the card.',
  )
}

export async function enforceCardLimitAction(cardId: string, amountPence: number): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      await enforceCardLimit({ workspaceId: auth.workspace.id, actorId: auth.user.id, cardId, amountPence: Math.round(amountPence) })
      revalidate()
      return { ok: true, message: `Monthly limit set to ${money(amountPence)}.` }
    },
    'Could not set the limit.',
  )
}

export async function removeCardAction(cardId: string): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      await removeCard({ workspaceId: auth.workspace.id, actorId: auth.user.id, cardId })
      revalidate()
      return { ok: true, message: 'Card disconnected.' }
    },
    'Could not remove the card.',
  )
}

export async function assignTransactionAction(input: { txId: string; channelKey: string | null; ignore: boolean; remember: string | null }): Promise<ActionResult> {
  return guard(
    'budget:cards',
    async (auth) => {
      const r = await assignTransaction({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...input })
      revalidate()
      return { ok: true, message: input.remember ? `Saved, and remembered (${r.applied} other charge${r.applied === 1 ? '' : 's'} updated).` : 'Saved.' }
    },
    'Could not assign the transaction.',
  )
}

/* ------------------------------------------------------- linked controls */

export async function applyAdBudgetAction(planId: string, adCampaignId: string, dailyPence: number): Promise<ActionResult> {
  return guard(
    'budget:activate',
    async (auth) => {
      assertCan(auth.role, 'ads:create')
      await applyAdDailyBudget({ workspaceId: auth.workspace.id, actorId: auth.user.id, planId, adCampaignId, dailyPence: Math.round(dailyPence) })
      revalidate(planId)
      revalidatePath(`/ads/${adCampaignId}`)
      return { ok: true, message: `Daily budget set to ${money(dailyPence)}. The campaign needs approving again.` }
    },
    'Could not set the campaign budget.',
  )
}

export async function applyVideoCeilingAction(planId: string): Promise<ActionResult> {
  return guard(
    'budget:activate',
    async (auth) => {
      const plan = await loadPlan(auth.workspace.id, planId)
      if (!plan || plan.status !== 'active') return { ok: false, message: 'Only a live plan can set the video ceiling.' }
      const line = plan.lines.find((l) => l.channelKey === 'video_production')
      if (!line) return { ok: false, message: 'The plan has no video line.' }
      const days = (Date.parse(String(plan.periodEnd)) - Date.parse(String(plan.periodStart))) / 86_400_000 + 1
      const monthlyPence = Math.round(line.plannedPence * (30.4 / days))
      const usdCents = Math.round(monthlyPence / env().BUDGET_USD_TO_GBP)
      await raiseVideoCeiling({
        workspaceId: auth.workspace.id,
        actorId: auth.user.id,
        role: auth.role,
        plan: await workspacePlan(auth.workspace.id),
        toCents: usdCents,
        reason: `From budget plan "${plan.name}": ${money(monthlyPence)} a month on video production.`,
      })
      revalidate(planId)
      revalidatePath('/studio/video')
      return { ok: true, message: `Video ceiling set to $${(usdCents / 100).toFixed(0)} a month.` }
    },
    'Could not set the video ceiling.',
  )
}
