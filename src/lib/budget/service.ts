import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  adAccounts,
  adCampaigns,
  approvalRequests,
  aiRuns,
  budgetAllocations,
  budgetDiscrepancies,
  budgetLines,
  budgetObservations,
  budgetPlans,
  budgetPlatformSpend,
  budgetReconciliations,
  cardTransactions,
  memberships,
  merchantRules,
  metricFacts,
  notifications,
  paymentCards,
  videoGenerations,
  type BudgetLine,
  type BudgetPlan,
  type PaymentCard,
} from '@/lib/db/schema'
import { env } from '@/lib/env'
import { decryptToken, encryptToken } from '@/lib/crypto-secrets'
import { canonical, recordAudit } from '@/lib/workflow/audit'
import { CATEGORY_LABEL, CHANNELS, channelDef, channelLabelFor, STARTER_SPLIT } from './channels'
import { curveSeries, fitCurve } from './curves'
import { classify, sanitiseDescriptor, withOccurrence, type MerchantRule } from './merchants'
import { money, splitExact } from './money'
import { allocate, AllocationError } from './optimise'
import { addDays, dayRange, daysBetween, forecastCash, isoDay, paceLine, weekStart, type CashForecast } from './pacing'
import { reconcile } from './reconcile'
import { lastFullWeek, simulateCardFeed, simulateHistory, simulatePlatformDays } from './simulator'
import { parseStatement, type CsvSign } from './cards/csv'
import {
  cardTransactions as tlTransactions,
  exchangeCode,
  listCards as tlCards,
  normaliseTrueLayerTx,
  pendingCardTransactions,
  RECONFIRM_DAYS,
  refreshTokens,
} from './cards/truelayer'
import {
  airwallexCards,
  airwallexLogin,
  airwallexSetMonthlyLimit,
  airwallexTransactions,
  last4,
  normaliseAirwallexTx,
  type AirwallexCreds,
} from './cards/airwallex'
import type {
  AllocationLineInput,
  AllocationResult,
  AllocationSettings,
  CardProvider,
  CurveFit,
  LineCategory,
  Objective,
  Observation,
  PacingLine,
  Provenance,
  ReconciliationReport,
  StoredCurve,
} from './types'

/**
 * Budget Allocator — the service layer. Everything that touches the database
 * goes through here; the arithmetic lives in the pure modules beside it.
 *
 * Governance follows the rest of Aurea:
 *  - A plan is an approval subject ('budget_plan'). Editing an approved plan
 *    sends it back to draft, and only an approved plan at the approved version
 *    can be activated.
 *  - Applying an allocation never edits the live plan. It creates a revision,
 *    which goes through approval like any plan; activating it supersedes the
 *    one it revised.
 *  - Every state change is on the hash-chained audit trail.
 */

export class BudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

const EDITABLE = new Set(['draft', 'changes_requested'])
const SUBMITTABLE = new Set(['draft', 'changes_requested'])

function sha(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })

/** The calendar day in the UK. Budgets, card statements and platform reports all run on local days, not UTC ones. */
export function londonDay(d: Date): string {
  return DAY_FMT.format(d)
}

function today(): string {
  return londonDay(new Date())
}

/* ================================================================ plans */

export type PlanWithLines = BudgetPlan & { lines: BudgetLine[] }

export async function listPlans(workspaceId: string): Promise<BudgetPlan[]> {
  return db
    .select()
    .from(budgetPlans)
    .where(eq(budgetPlans.workspaceId, workspaceId))
    .orderBy(desc(budgetPlans.periodStart), desc(budgetPlans.createdAt))
}

export async function loadPlan(workspaceId: string, id: string): Promise<PlanWithLines | null> {
  const [plan] = await db
    .select()
    .from(budgetPlans)
    .where(and(eq(budgetPlans.workspaceId, workspaceId), eq(budgetPlans.id, id)))
    .limit(1)
  if (!plan) return null
  const lines = await db.select().from(budgetLines).where(eq(budgetLines.planId, id)).orderBy(asc(budgetLines.sort), asc(budgetLines.label))
  return { ...plan, lines }
}

export async function activePlan(workspaceId: string): Promise<PlanWithLines | null> {
  const [row] = await db
    .select({ id: budgetPlans.id })
    .from(budgetPlans)
    .where(and(eq(budgetPlans.workspaceId, workspaceId), eq(budgetPlans.status, 'active')))
    .orderBy(desc(budgetPlans.activatedAt))
    .limit(1)
  return row ? loadPlan(workspaceId, row.id) : null
}

/** The plan the overview should show: active, else the newest open one. */
export async function currentPlan(workspaceId: string): Promise<PlanWithLines | null> {
  const active = await activePlan(workspaceId)
  if (active) return active
  const [row] = await db
    .select({ id: budgetPlans.id })
    .from(budgetPlans)
    .where(and(eq(budgetPlans.workspaceId, workspaceId), inArray(budgetPlans.status, ['draft', 'in_review', 'changes_requested', 'approved'])))
    .orderBy(desc(budgetPlans.createdAt))
    .limit(1)
  return row ? loadPlan(workspaceId, row.id) : null
}

/** Open revisions of a plan (drafts and those in review). */
export async function revisionsOf(workspaceId: string, planId: string): Promise<BudgetPlan[]> {
  return db
    .select()
    .from(budgetPlans)
    .where(and(eq(budgetPlans.workspaceId, workspaceId), eq(budgetPlans.parentPlanId, planId), ne(budgetPlans.status, 'superseded')))
    .orderBy(desc(budgetPlans.createdAt))
}

export type NewPlanInput = {
  workspaceId: string
  actorId: string
  name: string
  periodStart: string
  periodEnd: string
  totalPence: number
  objective: Objective
  start: 'starter' | 'history' | 'blank'
  valuePerConversionPence?: number | null
  cardLimitPence?: number | null
}

export async function createPlan(input: NewPlanInput): Promise<PlanWithLines> {
  if (input.periodEnd < input.periodStart) throw new BudgetError('The period ends before it starts.')
  if (daysBetween(input.periodStart, input.periodEnd) > 400) throw new BudgetError('A plan covers at most a year.')
  if (!(input.totalPence > 0)) throw new BudgetError('Set a total budget above zero.')

  const lines: { key: string; share: number }[] =
    input.start === 'blank'
      ? []
      : input.start === 'history'
        ? await historySplit(input.workspaceId)
        : STARTER_SPLIT

  const amounts = splitExact(input.totalPence, lines.map((l) => l.share))

  const created = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(budgetPlans)
      .values({
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalPence: input.totalPence,
        objective: input.objective,
        valuePerConversionPence: input.valuePerConversionPence ?? null,
        cardLimitPence: input.cardLimitPence ?? null,
        createdBy: input.actorId,
      })
      .returning()
    const rows = lines.length
      ? await tx
          .insert(budgetLines)
          .values(
            lines.map((l, i) => {
              const def = channelDef(l.key)
              return {
                workspaceId: input.workspaceId,
                planId: plan.id,
                channelKey: l.key,
                label: def?.label ?? l.key,
                category: def?.category ?? 'tools',
                plannedPence: amounts[i],
                sort: i,
              }
            }),
          )
          .returning()
      : []
    return { ...plan, lines: rows }
  })
  // After commit: the audit append takes its own per-workspace lock and transaction.
  await recordAudit({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'budget.plan_created',
    subjectType: 'budget_plan',
    subjectId: created.id,
    summary: `Budget plan "${created.name}" created: ${money(created.totalPence)} for ${created.periodStart} to ${created.periodEnd}.`,
    payload: { start: input.start, lines: created.lines.length },
  })
  return created
}

/** Split by the last twelve weeks of observed spend, plus starter shares for lines with no history. */
async function historySplit(workspaceId: string): Promise<{ key: string; share: number }[]> {
  const since = addDays(today(), -84)
  const rows = await db
    .select({ key: budgetObservations.channelKey, spend: sql<number>`sum(${budgetObservations.spendPence})::float` })
    .from(budgetObservations)
    .where(and(eq(budgetObservations.workspaceId, workspaceId), gte(budgetObservations.weekStart, since)))
    .groupBy(budgetObservations.channelKey)
  const observed = rows.filter((r) => r.spend > 0 && channelDef(r.key))
  if (observed.length === 0) return STARTER_SPLIT
  const observedShare = 0.8
  const total = observed.reduce((a, r) => a + r.spend, 0)
  const keys = new Set(observed.map((r) => r.key))
  const rest = STARTER_SPLIT.filter((s) => !keys.has(s.key) && channelDef(s.key)?.category !== 'paid_media')
  const restTotal = rest.reduce((a, s) => a + s.share, 0) || 1
  return [
    ...observed.map((r) => ({ key: r.key, share: (r.spend / total) * observedShare })),
    ...rest.map((s) => ({ key: s.key, share: (s.share / restTotal) * (1 - observedShare) })),
  ]
}

async function requireEditable(workspaceId: string, planId: string): Promise<PlanWithLines> {
  const plan = await loadPlan(workspaceId, planId)
  if (!plan) throw new BudgetError('Plan not found.')
  if (!EDITABLE.has(plan.status) && plan.status !== 'approved' && plan.status !== 'in_review') {
    throw new BudgetError(
      plan.status === 'active'
        ? 'This plan is live. Changes go into a revision, which is approved before it replaces the live plan.'
        : 'This plan is closed and cannot be changed.',
    )
  }
  return plan
}

/**
 * Any edit sends an approved or in-review plan back to draft and bumps its
 * version, which voids the approval: what was signed off is no longer what
 * would be activated.
 */
async function touch(planId: string, plan: BudgetPlan) {
  // A pending request was for the version being replaced: cancel it so it cannot approve something nobody reviewed.
  if (plan.status === 'in_review') await cancelPendingRequests(planId)
  await db
    .update(budgetPlans)
    .set({
      version: sql`${budgetPlans.version} + 1`,
      status: plan.status === 'approved' || plan.status === 'in_review' ? 'draft' : plan.status,
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(budgetPlans.id, planId))
}

export async function updatePlanSettings(args: {
  workspaceId: string
  actorId: string
  planId: string
  patch: Partial<{
    name: string
    totalPence: number
    periodStart: string
    periodEnd: string
    objective: Objective
    riskAversion: number
    learningShare: number
    maxShift: number | null
    valuePerConversionPence: number | null
    cardLimitPence: number | null
    notes: string | null
  }>
}): Promise<void> {
  const plan = await requireEditable(args.workspaceId, args.planId)
  const p = args.patch
  if (p.totalPence !== undefined && !(p.totalPence > 0)) throw new BudgetError('Set a total budget above zero.')
  const start = String(p.periodStart ?? plan.periodStart)
  const end = String(p.periodEnd ?? plan.periodEnd)
  if (end < start) throw new BudgetError('The period ends before it starts.')
  if (daysBetween(start, end) > 400) throw new BudgetError('A plan covers at most a year.')
  await db.update(budgetPlans).set({ ...p, updatedAt: new Date() }).where(eq(budgetPlans.id, plan.id))
  await touch(plan.id, plan)
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.plan_edited',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Budget plan "${plan.name}" settings changed.`,
    payload: { patch: p, previousVersion: plan.version },
  })
}

export type LineInput = {
  id?: string
  channelKey: string
  label?: string
  plannedPence: number
  minPence?: number
  maxPence?: number | null
  locked?: boolean
  allowExtrapolation?: boolean
  incrementality?: number
  incrementalitySource?: string | null
  adCampaignIds?: string[]
  notes?: string | null
}

export async function saveLine(args: { workspaceId: string; actorId: string; planId: string; line: LineInput }): Promise<BudgetLine> {
  const plan = await requireEditable(args.workspaceId, args.planId)
  const l = args.line
  const def = channelDef(l.channelKey)
  if (!def) throw new BudgetError('Unknown budget line type.')
  if (l.plannedPence < 0 || (l.minPence ?? 0) < 0) throw new BudgetError('Amounts cannot be negative.')
  if (l.maxPence !== undefined && l.maxPence !== null && l.maxPence < (l.minPence ?? 0)) throw new BudgetError('The maximum is below the minimum.')
  if (l.incrementality !== undefined && !(l.incrementality > 0 && l.incrementality <= 1.5)) {
    throw new BudgetError('Incrementality is a share between 0 and 1.5 (1 = every reported result is incremental).')
  }
  if (l.adCampaignIds?.length) {
    const found = await db
      .select({ id: adCampaigns.id })
      .from(adCampaigns)
      .where(and(eq(adCampaigns.workspaceId, args.workspaceId), inArray(adCampaigns.id, l.adCampaignIds)))
    if (found.length !== l.adCampaignIds.length) throw new BudgetError('One of the linked campaigns is not in this workspace.')
  }
  const values = {
    channelKey: l.channelKey,
    label: (l.label ?? def.label).trim() || def.label,
    category: def.category,
    plannedPence: Math.round(l.plannedPence),
    minPence: Math.round(l.minPence ?? 0),
    maxPence: l.maxPence === undefined || l.maxPence === null ? null : Math.round(l.maxPence),
    locked: l.locked ?? false,
    allowExtrapolation: l.allowExtrapolation ?? false,
    incrementality: l.incrementality ?? 1,
    incrementalitySource: l.incrementalitySource ?? null,
    adCampaignIds: l.adCampaignIds ?? [],
    notes: l.notes ?? null,
  }
  let row: BudgetLine
  if (l.id) {
    const existing = plan.lines.find((x) => x.id === l.id)
    if (!existing) throw new BudgetError('Line not found in this plan.')
    if (existing.channelKey !== l.channelKey && plan.lines.some((x) => x.channelKey === l.channelKey)) {
      throw new BudgetError(`The plan already has a ${def.label} line.`)
    }
    ;[row] = await db.update(budgetLines).set(values).where(eq(budgetLines.id, l.id)).returning()
  } else {
    if (plan.lines.some((x) => x.channelKey === l.channelKey)) throw new BudgetError(`The plan already has a ${def.label} line.`)
    ;[row] = await db
      .insert(budgetLines)
      .values({ ...values, workspaceId: args.workspaceId, planId: plan.id, sort: plan.lines.length })
      .returning()
  }
  await touch(plan.id, plan)
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.line_saved',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `${row.label}: ${money(row.plannedPence)} in "${plan.name}".`,
    payload: { lineId: row.id, ...values },
  })
  return row
}

export async function removeLine(args: { workspaceId: string; actorId: string; planId: string; lineId: string }): Promise<void> {
  const plan = await requireEditable(args.workspaceId, args.planId)
  const line = plan.lines.find((l) => l.id === args.lineId)
  if (!line) throw new BudgetError('Line not found.')
  await db.delete(budgetLines).where(eq(budgetLines.id, line.id))
  await touch(plan.id, plan)
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.line_removed',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `${line.label} (${money(line.plannedPence)}) removed from "${plan.name}".`,
  })
}

async function cancelPendingRequests(planId: string) {
  await db
    .update(approvalRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(approvalRequests.subjectType, 'budget_plan'), eq(approvalRequests.subjectId, planId), eq(approvalRequests.status, 'pending')))
}

/** Make the lines add up to the total, by scaling the unlocked ones. */
export async function balanceLines(args: { workspaceId: string; actorId: string; planId: string }): Promise<void> {
  const plan = await requireEditable(args.workspaceId, args.planId)
  const locked = plan.lines.filter((l) => l.locked)
  const free = plan.lines.filter((l) => !l.locked)
  const room = plan.totalPence - locked.reduce((a, l) => a + l.plannedPence, 0)
  if (room < 0) throw new BudgetError('The locked lines alone exceed the total.')
  if (free.length === 0) throw new BudgetError('Every line is locked.')
  const weights = free.map((l) => Math.max(1, l.plannedPence))
  const amounts = splitExact(room, weights)
  for (let i = 0; i < free.length; i++) {
    await db.update(budgetLines).set({ plannedPence: amounts[i] }).where(eq(budgetLines.id, free[i].id))
  }
  await touch(plan.id, plan)
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.plan_edited',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Lines in "${plan.name}" scaled to add up to ${money(plan.totalPence)}.`,
  })
}

export function planProblems(plan: PlanWithLines): string[] {
  const out: string[] = []
  const sum = plan.lines.reduce((a, l) => a + l.plannedPence, 0)
  if (plan.lines.length === 0) out.push('The plan has no lines.')
  if (sum !== plan.totalPence) {
    out.push(`The lines add up to ${money(sum)}, not the ${money(plan.totalPence)} total. ${sum > plan.totalPence ? 'Reduce lines' : 'Assign the rest'} or balance them.`)
  }
  for (const l of plan.lines) {
    if (l.plannedPence < l.minPence) out.push(`${l.label} is below its minimum.`)
    if (l.maxPence !== null && l.plannedPence > l.maxPence) out.push(`${l.label} is above its maximum.`)
  }
  if (plan.objective === 'profit' && !plan.valuePerConversionPence) out.push('A profit objective needs the value of a conversion.')
  return out
}

/* ---------------------------------------------------------- lifecycle */

/** Called by the approval adapter: the engine moves plans between review states. */
export async function setPlanReviewStatus(id: string, status: 'in_review' | 'changes_requested' | 'approved', at: Date): Promise<void> {
  await db
    .update(budgetPlans)
    .set({ status, updatedAt: at, ...(status === 'approved' ? { approvedAt: at } : {}) })
    .where(eq(budgetPlans.id, id))
}

export async function assertActivatable(workspaceId: string, planId: string): Promise<PlanWithLines> {
  const plan = await loadPlan(workspaceId, planId)
  if (!plan) throw new BudgetError('Plan not found.')
  if (plan.status !== 'approved') {
    throw new BudgetError(
      plan.status === 'in_review'
        ? 'It is still awaiting approval.'
        : plan.status === 'active'
          ? 'It is already live.'
          : 'It has to be approved before it can go live.',
    )
  }
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.subjectType, 'budget_plan'), eq(approvalRequests.subjectId, planId), eq(approvalRequests.status, 'approved')))
    .orderBy(desc(approvalRequests.completedAt))
    .limit(1)
  if (!req) throw new BudgetError('There is no completed approval on record for this plan.')
  if (req.subjectVersion !== plan.version) {
    throw new BudgetError(`The plan changed after it was approved (approved v${req.subjectVersion}, now v${plan.version}). It needs approving again.`)
  }
  const problems = planProblems(plan)
  if (problems.length) throw new BudgetError(problems[0])
  return plan
}

export async function activatePlan(args: { workspaceId: string; actorId: string; planId: string }): Promise<PlanWithLines> {
  const plan = await assertActivatable(args.workspaceId, args.planId)
  if (plan.parentPlanId) {
    const [parent] = await db.select({ status: budgetPlans.status }).from(budgetPlans).where(eq(budgetPlans.id, plan.parentPlanId)).limit(1)
    if (parent && parent.status !== 'active') {
      throw new BudgetError('The plan this revises is no longer the live plan, so making it live would undo a newer change. Revise the live plan instead.')
    }
  }
  const now = new Date()
  const replaced = await db
    .update(budgetPlans)
    .set({ status: 'superseded', updatedAt: now })
    .where(and(eq(budgetPlans.workspaceId, args.workspaceId), eq(budgetPlans.status, 'active')))
    .returning({ id: budgetPlans.id, name: budgetPlans.name })
  await db.update(budgetPlans).set({ status: 'active', activatedAt: now, activatedBy: args.actorId, updatedAt: now }).where(eq(budgetPlans.id, plan.id))
  // Discrepancies follow the live plan, so open ones carry over to the revision.
  // Row by row: when the revision already has the same fingerprint (it was reconciled before going live),
  // the older row's status and note — the ones a person wrote — are copied onto it.
  for (const r of replaced) {
    const carried = await db.select().from(budgetDiscrepancies).where(and(eq(budgetDiscrepancies.planId, r.id), ne(budgetDiscrepancies.status, 'resolved')))
    for (const d of carried) {
      const [clash] = await db
        .select({ id: budgetDiscrepancies.id })
        .from(budgetDiscrepancies)
        .where(and(eq(budgetDiscrepancies.planId, plan.id), eq(budgetDiscrepancies.fingerprint, d.fingerprint)))
        .limit(1)
      if (clash) {
        await db.update(budgetDiscrepancies).set({ status: d.status, note: d.note, resolvedBy: d.resolvedBy, resolvedAt: d.resolvedAt }).where(eq(budgetDiscrepancies.id, clash.id))
      } else {
        await db.update(budgetDiscrepancies).set({ planId: plan.id }).where(eq(budgetDiscrepancies.id, d.id))
      }
    }
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.plan_activated',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Budget plan "${plan.name}" v${plan.version} is live${replaced.length ? `, replacing "${replaced.map((r) => r.name).join('", "')}"` : ''}.`,
    payload: { version: plan.version, totalPence: plan.totalPence, replaced: replaced.map((r) => r.id), lines: plan.lines.map((l) => ({ key: l.channelKey, pence: l.plannedPence })) },
  })
  return { ...plan, status: 'active' }
}

export async function closePlan(args: { workspaceId: string; actorId: string; planId: string }): Promise<void> {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  if (plan.status === 'closed' || plan.status === 'superseded') return
  await cancelPendingRequests(plan.id)
  await db.update(budgetPlans).set({ status: 'closed', updatedAt: new Date() }).where(eq(budgetPlans.id, plan.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.plan_closed',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Budget plan "${plan.name}" closed.`,
  })
}

/** Copy a plan into a new draft revision, optionally with new amounts per line. */
export async function revisePlan(args: {
  workspaceId: string
  actorId: string
  planId: string
  amounts?: Record<string, number>
  note?: string
}): Promise<PlanWithLines> {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  const openRevs = (await revisionsOf(args.workspaceId, plan.id)).filter((r) => EDITABLE.has(r.status) || r.status === 'in_review' || r.status === 'approved')
  if (openRevs.length && !args.amounts) return (await loadPlan(args.workspaceId, openRevs[0].id))!
  // A new recommendation replaces any earlier open revision: two competing drafts of one live plan help nobody.
  for (const r of openRevs) {
    await cancelPendingRequests(r.id)
    await db.update(budgetPlans).set({ status: 'closed', updatedAt: new Date(), notes: 'Replaced by a newer revision.' }).where(eq(budgetPlans.id, r.id))
  }
  const total = args.amounts ? Object.values(args.amounts).reduce((a, b) => a + b, 0) : plan.totalPence
  const [rev] = await db
    .insert(budgetPlans)
    .values({
      workspaceId: plan.workspaceId,
      name: plan.name.replace(/ \(revision \d+\)$/, '') + ` (revision ${(await countRevisions(plan)) + 1})`,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
      currency: plan.currency,
      totalPence: Math.max(total, plan.totalPence),
      objective: plan.objective,
      riskAversion: plan.riskAversion,
      learningShare: plan.learningShare,
      maxShift: plan.maxShift,
      valuePerConversionPence: plan.valuePerConversionPence,
      cardLimitPence: plan.cardLimitPence,
      parentPlanId: plan.id,
      notes: args.note ?? null,
      createdBy: args.actorId,
    })
    .returning()
  const lines = plan.lines.length
    ? await db
        .insert(budgetLines)
        .values(
          plan.lines.map((l) => ({
            workspaceId: l.workspaceId,
            planId: rev.id,
            channelKey: l.channelKey,
            label: l.label,
            category: l.category,
            plannedPence: args.amounts?.[l.id] ?? l.plannedPence,
            minPence: l.minPence,
            maxPence: l.maxPence,
            locked: l.locked,
            allowExtrapolation: l.allowExtrapolation,
            incrementality: l.incrementality,
            incrementalitySource: l.incrementalitySource,
            adCampaignIds: l.adCampaignIds,
            ownerId: l.ownerId,
            sort: l.sort,
            notes: l.notes,
          })),
        )
        .returning()
    : []
  // Unallocated money stays in the total but on no line: make it explicit as contingency.
  const assigned = lines.reduce((a, l) => a + l.plannedPence, 0)
  if (assigned < rev.totalPence) {
    const contingency = lines.find((l) => l.channelKey === 'contingency')
    if (contingency) {
      await db.update(budgetLines).set({ plannedPence: contingency.plannedPence + (rev.totalPence - assigned) }).where(eq(budgetLines.id, contingency.id))
    } else {
      await db.insert(budgetLines).values({
        workspaceId: rev.workspaceId,
        planId: rev.id,
        channelKey: 'contingency',
        label: 'Contingency',
        category: 'reserve',
        plannedPence: rev.totalPence - assigned,
        sort: lines.length,
        notes: 'Money the allocator would not spend past the evidence.',
      })
    }
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.plan_revised',
    subjectType: 'budget_plan',
    subjectId: rev.id,
    summary: `Revision of "${plan.name}" drafted${args.note ? `: ${args.note}` : ''}.`,
    payload: { parentPlanId: plan.id },
  })
  return (await loadPlan(args.workspaceId, rev.id))!
}

async function countRevisions(plan: BudgetPlan): Promise<number> {
  const base = plan.name.replace(/ \(revision \d+\)$/, '')
  const pattern = `${base.replace(/[%_\\]/g, (m) => '\\' + m)} (revision %`
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(budgetPlans)
    .where(and(eq(budgetPlans.workspaceId, plan.workspaceId), sql`${budgetPlans.name} like ${pattern}`))
  return row?.n ?? 0
}

/* =========================================================== observations */

/** Aurea's own metric channels → budget channels. */
const METRIC_MAP: Record<string, string> = Object.fromEntries(
  CHANNELS.filter((c) => c.metricChannel).map((c) => [c.metricChannel!, c.key]),
)

/**
 * Rebuild the 'aurea' observations and platform spend from Aurea's own data:
 * metric facts (spend and conversions per channel), model usage (ai_runs) and
 * generated video. Idempotent.
 */
export async function syncFromAurea(workspaceId: string): Promise<{ weeks: number; days: number }> {
  const since = addDays(today(), -7 * 104)
  const facts = await db
    .select({
      day: metricFacts.day,
      channel: metricFacts.channel,
      spend: sql<number>`sum(${metricFacts.spend})::float`,
      conversions: sql<number>`sum(${metricFacts.conversions})::float`,
      revenue: sql<number>`sum(${metricFacts.revenue})::float`,
    })
    .from(metricFacts)
    .where(and(eq(metricFacts.workspaceId, workspaceId), gte(metricFacts.day, since)))
    .groupBy(metricFacts.day, metricFacts.channel)

  const weekly = new Map<string, Observation>()
  const daily = new Map<string, number>()
  for (const f of facts) {
    const key = METRIC_MAP[f.channel]
    if (!key) continue
    const spend = Math.round(f.spend * 100)
    const wk = weekStart(String(f.day))
    const k = `${key}|${wk}`
    const o = weekly.get(k) ?? { weekStart: wk, spendPence: 0, conversions: 0, revenuePence: 0, source: 'aurea' as const }
    o.spendPence += spend
    o.conversions += f.conversions
    o.revenuePence += Math.round(f.revenue * 100)
    weekly.set(k, o)
    if (spend > 0) daily.set(`${key}|${f.day}`, (daily.get(`${key}|${f.day}`) ?? 0) + spend)
  }

  // Model usage and generated video, in dollars, onto the AI and video lines.
  const fx = env().BUDGET_USD_TO_GBP
  const ai = await db
    .select({ day: sql<string>`(${aiRuns.createdAt} at time zone 'UTC')::date::text`, usd: sql<number>`sum(${aiRuns.costUsd})::float` })
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), gte(aiRuns.createdAt, new Date(`${since}T00:00:00Z`))))
    .groupBy(sql`1`)
  for (const r of ai) {
    const p = Math.round(r.usd * 100 * fx)
    if (p > 0) daily.set(`ai_generation|${r.day}`, (daily.get(`ai_generation|${r.day}`) ?? 0) + p)
  }
  const video = await db
    .select({
      day: sql<string>`(${videoGenerations.createdAt} at time zone 'UTC')::date::text`,
      cents: sql<number>`sum(coalesce(${videoGenerations.actualCostCents}, 0))::float`,
    })
    .from(videoGenerations)
    .where(and(eq(videoGenerations.workspaceId, workspaceId), eq(videoGenerations.simulated, false), gte(videoGenerations.createdAt, new Date(`${since}T00:00:00Z`))))
    .groupBy(sql`1`)
  for (const r of video) {
    const p = Math.round(r.cents * fx)
    if (p > 0) daily.set(`video_production|${r.day}`, (daily.get(`video_production|${r.day}`) ?? 0) + p)
  }

  const now = new Date()
  const obsRows = [...weekly.entries()].map(([k, o]) => ({
    workspaceId,
    channelKey: k.split('|')[0],
    weekStart: o.weekStart,
    spendPence: o.spendPence,
    conversions: o.conversions,
    revenuePence: o.revenuePence,
    source: 'aurea',
    updatedAt: now,
  }))
  for (let i = 0; i < obsRows.length; i += 500) {
    await db
      .insert(budgetObservations)
      .values(obsRows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [budgetObservations.workspaceId, budgetObservations.channelKey, budgetObservations.weekStart, budgetObservations.source],
        set: { spendPence: sql`excluded.spend_pence`, conversions: sql`excluded.conversions`, revenuePence: sql`excluded.revenue_pence`, updatedAt: now },
      })
  }
  const dayRows = [...daily.entries()].map(([k, p]) => ({ workspaceId, platform: k.split('|')[0], day: k.split('|')[1], spendPence: p, source: 'aurea', updatedAt: now }))
  for (let i = 0; i < dayRows.length; i += 500) {
    await db
      .insert(budgetPlatformSpend)
      .values(dayRows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [budgetPlatformSpend.workspaceId, budgetPlatformSpend.platform, budgetPlatformSpend.day, budgetPlatformSpend.source],
        set: { spendPence: sql`excluded.spend_pence`, updatedAt: now },
      })
  }
  return { weeks: obsRows.length, days: dayRows.length }
}

/**
 * The history a curve is fitted on. Real sources win: simulated rows are used
 * for a channel only when it has nothing else, so connecting real data
 * replaces the demo without anyone having to delete it.
 */
export async function observationsFor(workspaceId: string, channelKeys: string[]): Promise<Map<string, Observation[]>> {
  const out = new Map<string, Observation[]>()
  if (channelKeys.length === 0) return out
  const rows = await db
    .select()
    .from(budgetObservations)
    .where(and(eq(budgetObservations.workspaceId, workspaceId), inArray(budgetObservations.channelKey, channelKeys)))
    .orderBy(asc(budgetObservations.weekStart))
  for (const key of channelKeys) {
    const mine = rows.filter((r) => r.channelKey === key)
    const real = mine.filter((r) => r.source !== 'simulated')
    const sim = mine.filter((r) => r.source === 'simulated')
    // Real history replaces the simulation once it has eight weeks with actual spend in them.
    const realWeeks = new Set(real.filter((r) => r.spendPence > 0).map((r) => String(r.weekStart))).size
    const use = realWeeks >= 8 || sim.length === 0 ? real : sim
    // Several real sources for one week (Aurea metrics and a manual import) — prefer manual, then platform, then aurea.
    const byWeek = new Map<string, (typeof rows)[number]>()
    const rank: Record<string, number> = { manual: 4, statement: 3, platform: 2, aurea: 1, simulated: 0 }
    for (const r of use) {
      const have = byWeek.get(String(r.weekStart))
      if (!have || (rank[r.source] ?? 0) > (rank[have.source] ?? 0)) byWeek.set(String(r.weekStart), r)
    }
    out.set(
      key,
      [...byWeek.values()]
        .sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)))
        .map((r) => ({
          weekStart: String(r.weekStart),
          spendPence: r.spendPence,
          conversions: r.conversions,
          revenuePence: r.revenuePence,
          source: r.source as Observation['source'],
        })),
    )
  }
  return out
}

/**
 * Import weekly history for any channel from a CSV: week (or date), channel,
 * spend, conversions, revenue. This is how lines Aurea cannot see — events,
 * print, an agency's channels — get response curves.
 */
export async function importHistoryCsv(args: { workspaceId: string; actorId: string; text: string }): Promise<{ rows: number; channels: string[]; skipped: number }> {
  const { splitCsv, parseDate, parseAmount } = await import('./cards/csv')
  const delim = args.text.split('\n')[0].includes(';') ? ';' : args.text.split('\n')[0].includes('\t') ? '\t' : ','
  const table = splitCsv(args.text.replace(/^﻿/, ''), delim)
  if (table.length < 2) throw new BudgetError('The file has no rows.')
  if (table.length > 20_000) throw new BudgetError('The file has more than 20,000 rows. Import a shorter range, or one row per channel per week.')
  const h = table[0].map((x) => x.toLowerCase().replace(/[^a-z]/g, ''))
  const col = (...names: string[]) => h.findIndex((x) => names.some((n) => x === n || x.includes(n)))
  const iDate = col('weekstart', 'week', 'date')
  const iChan = col('channel', 'line', 'source')
  const iSpend = col('spend', 'cost')
  // Exact names first, so "sales value" is never read as a count of sales.
  const iConvExact = h.findIndex((x) => ['conversions', 'leads', 'sales', 'results', 'orders'].includes(x))
  const iConv = iConvExact >= 0 ? iConvExact : h.findIndex((x) => /^(conversions|leads|results|orders)/.test(x))
  const iRev = col('revenue', 'value', 'sales value')
  if (iDate < 0 || iChan < 0 || iSpend < 0) throw new BudgetError('The file needs week (or date), channel and spend columns.')
  const byLabel = new Map(CHANNELS.flatMap((c) => [[c.key, c.key], [c.label.toLowerCase(), c.key]] as const))
  const agg = new Map<string, { key: string; week: string; spend: number; conv: number; rev: number }>()
  let skipped = 0
  for (const r of table.slice(1)) {
    const day = parseDate(r[iDate] ?? '', 'dmy')
    const key = byLabel.get((r[iChan] ?? '').trim().toLowerCase()) ?? byLabel.get((r[iChan] ?? '').trim().toLowerCase().replace(/\s+/g, '_'))
    const spend = parseAmount(r[iSpend] ?? '')
    if (!day || !key || spend === null) {
      skipped++
      continue
    }
    const wk = weekStart(day)
    const k = `${key}|${wk}`
    const a = agg.get(k) ?? { key, week: wk, spend: 0, conv: 0, rev: 0 }
    a.spend += Math.abs(spend)
    a.conv += iConv >= 0 ? Number((r[iConv] ?? '').replace(/[^\d.]/g, '')) || 0 : 0
    a.rev += iRev >= 0 ? Math.abs(parseAmount(r[iRev] ?? '') ?? 0) : 0
    agg.set(k, a)
  }
  if (agg.size === 0) throw new BudgetError(`No usable rows. Channels must be one of: ${CHANNELS.map((c) => c.label).join(', ')}.`)
  const now = new Date()
  const values = [...agg.values()].map((a) => ({
    workspaceId: args.workspaceId,
    channelKey: a.key,
    weekStart: a.week,
    spendPence: a.spend,
    conversions: a.conv,
    revenuePence: a.rev,
    source: 'manual',
    updatedAt: now,
  }))
  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(budgetObservations)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [budgetObservations.workspaceId, budgetObservations.channelKey, budgetObservations.weekStart, budgetObservations.source],
        set: { spendPence: sql`excluded.spend_pence`, conversions: sql`excluded.conversions`, revenuePence: sql`excluded.revenue_pence`, updatedAt: now },
      })
  }
  const channels = [...new Set(values.map((v) => v.channelKey))]
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.history_imported',
    subjectType: 'workspace',
    subjectId: args.workspaceId,
    summary: `${values.length} weeks of history imported for ${channels.map(channelLabelFor).join(', ')}.`,
    payload: { rows: values.length, skipped },
  })
  return { rows: values.length, channels, skipped }
}


/**
 * One spend figure per platform per day. Per platform, a real source (Aurea's
 * own metrics, an import) is used when it covers most of the window; a
 * simulation fills in only for platforms with no real coverage. Mixing the
 * two day by day would produce a series that is neither.
 */
export function pickPlatformDays(
  rows: { platform: string; day: string | Date; spendPence: number; source: string }[],
  from: string,
  to: string,
): { platform: string; day: string; spendPence: number; source: Provenance }[] {
  const window = Math.max(1, daysBetween(from, to < today() ? to : addDays(today(), -1)) + 1)
  const byPlatform = new Map<string, typeof rows>()
  for (const r of rows) byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r])
  const out: { platform: string; day: string; spendPence: number; source: Provenance }[] = []
  for (const [platform, list] of byPlatform) {
    const inWindow = (r: (typeof rows)[number]) => String(r.day) >= from && String(r.day) <= to
    const real = list.filter((r) => r.source !== 'simulated')
    const realCover = new Set(real.filter((r) => inWindow(r) && r.spendPence > 0).map((r) => String(r.day))).size
    const sim = list.filter((r) => r.source === 'simulated')
    const use = realCover >= window * 0.7 || sim.length === 0 ? real : sim
    const perDay = new Map<string, number>()
    for (const r of use) perDay.set(String(r.day), (perDay.get(String(r.day)) ?? 0) + r.spendPence)
    const source = (use[0]?.source ?? 'aurea') as Provenance
    for (const [day, spendPence] of perDay) out.push({ platform, day, spendPence, source })
  }
  return out
}

/* ============================================================ allocation */

const DRAWS = 80

export function weeksIn(plan: Pick<BudgetPlan, 'periodStart' | 'periodEnd'>): number {
  return Math.max(1, (daysBetween(String(plan.periodStart), String(plan.periodEnd)) + 1) / 7)
}

export async function latestReconciliation(workspaceId: string, planId: string) {
  const [row] = await db
    .select()
    .from(budgetReconciliations)
    .where(and(eq(budgetReconciliations.workspaceId, workspaceId), eq(budgetReconciliations.planId, planId)))
    .orderBy(desc(budgetReconciliations.createdAt))
    .limit(1)
  return row ?? null
}

export async function latestAllocation(workspaceId: string, planId: string) {
  const [row] = await db
    .select()
    .from(budgetAllocations)
    .where(and(eq(budgetAllocations.workspaceId, workspaceId), eq(budgetAllocations.planId, planId)))
    .orderBy(desc(budgetAllocations.createdAt))
    .limit(1)
  return row ?? null
}

export async function runAllocation(args: {
  workspaceId: string
  actorId: string | null
  planId: string
  totalPence?: number
}) {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  if (plan.lines.length === 0) throw new BudgetError('Add lines to the plan first.')

  const objective = plan.objective as Objective
  const metric: 'conversions' | 'revenue' = objective === 'conversions' ? 'conversions' : objective === 'revenue' ? 'revenue' : plan.valuePerConversionPence ? 'conversions' : 'revenue'
  const history = await observationsFor(args.workspaceId, plan.lines.map((l) => l.channelKey))
  const seed = `${plan.id}:v${plan.version}`

  // The reconciliation's measured cash factors, and the plan's incrementality.
  const recon = await latestReconciliation(args.workspaceId, plan.id)
  const parentRecon = !recon && plan.parentPlanId ? await latestReconciliation(args.workspaceId, plan.parentPlanId) : null
  const cashFactors = (recon ?? parentRecon)?.report.cashFactors ?? {}

  const fits = new Map<string, CurveFit>()
  for (const l of plan.lines) {
    const obs = history.get(l.channelKey) ?? []
    if (obs.length === 0) continue
    if (!['paid_media', 'owned', 'offline', 'events', 'production'].includes(l.category)) continue
    const f = fitCurve(l.channelKey, obs, { metric, draws: DRAWS, seed: `${seed}:${l.channelKey}` })
    if (f.quality !== 'none') fits.set(l.channelKey, f)
  }
  const simulated = [...history.values()].some((obs) => obs.some((o) => o.source === 'simulated'))

  const lines: AllocationLineInput[] = plan.lines.map((l) => ({
    id: l.id,
    key: l.channelKey,
    label: l.label,
    category: l.category as LineCategory,
    currentPence: l.plannedPence,
    minPence: l.minPence,
    maxPence: l.maxPence,
    locked: l.locked,
    fit: fits.get(l.channelKey) ?? null,
    cashFactor: cashFactors[l.channelKey] ?? 1,
    incrementality: l.incrementality,
    allowExtrapolation: l.allowExtrapolation,
  }))
  const totalPence = args.totalPence ?? plan.totalPence
  const settings: AllocationSettings = {
    objective,
    riskAversion: plan.riskAversion,
    learningShare: plan.learningShare,
    extrapolationCap: 1.5,
    maxShift: plan.maxShift,
    valuePerConversionPence: plan.valuePerConversionPence,
    weeks: weeksIn(plan),
    totalPence,
    cashFactors,
    incrementality: Object.fromEntries(plan.lines.map((l) => [l.channelKey, l.incrementality])),
    seed,
  }

  let result: AllocationResult
  try {
    result = allocate({ ...settings, lines })
  } catch (e) {
    if (e instanceof AllocationError) throw new BudgetError(e.message)
    throw e
  }

  const curves: StoredCurve[] = [...fits.values()].map((f) => ({
    channelKey: f.channelKey,
    metric: f.metric,
    quality: f.quality,
    r2: f.r2,
    credibility: f.credibility,
    weeks: f.weeks,
    maxObservedWeeklyPence: f.maxObservedWeeklyPence,
    meanWeeklyPence: f.meanWeeklyPence,
    saturationWeeklyPence: f.saturationWeeklyPence,
    notes: f.notes,
    series: curveSeries(f, Math.max(f.maxObservedWeeklyPence * 2, f.saturationWeeklyPence * 1.1), 30),
  }))

  const [row] = await db
    .insert(budgetAllocations)
    .values({
      workspaceId: args.workspaceId,
      planId: plan.id,
      planVersion: plan.version,
      settings,
      curves,
      result,
      resultHash: sha({ settings, result }),
      simulated,
      createdBy: args.actorId,
    })
    .returning()

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'budget.allocated',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Allocator run on "${plan.name}": ${result.summary.split('. ')[0]}.`,
    payload: { allocationId: row.id, hash: row.resultHash, probabilityBetter: result.totals.probabilityBetter, simulated },
  })
  return row
}

export async function applyAllocation(args: { workspaceId: string; actorId: string; allocationId: string }): Promise<PlanWithLines> {
  const [alloc] = await db
    .select()
    .from(budgetAllocations)
    .where(and(eq(budgetAllocations.workspaceId, args.workspaceId), eq(budgetAllocations.id, args.allocationId)))
    .limit(1)
  if (!alloc) throw new BudgetError('Allocation not found.')
  if (alloc.appliedPlanId) {
    const existing = await loadPlan(args.workspaceId, alloc.appliedPlanId)
    if (existing) return existing
  }
  const plan = await loadPlan(args.workspaceId, alloc.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  if (plan.version !== alloc.planVersion) {
    throw new BudgetError('The plan has changed since this allocation was run. Run the allocator again.')
  }
  const amounts = Object.fromEntries(alloc.result.lines.map((l) => [l.id, l.recommendedPence]))

  let target: PlanWithLines
  if (EDITABLE.has(plan.status)) {
    // A draft is simply updated in place.
    for (const l of plan.lines) {
      if (amounts[l.id] !== undefined) await db.update(budgetLines).set({ plannedPence: amounts[l.id] }).where(eq(budgetLines.id, l.id))
    }
    if (alloc.result.unallocatedPence > 0) {
      const c = plan.lines.find((l) => l.channelKey === 'contingency')
      if (c) await db.update(budgetLines).set({ plannedPence: (amounts[c.id] ?? c.plannedPence) + alloc.result.unallocatedPence }).where(eq(budgetLines.id, c.id))
      else
        await db.insert(budgetLines).values({
          workspaceId: plan.workspaceId,
          planId: plan.id,
          channelKey: 'contingency',
          label: 'Contingency',
          category: 'reserve',
          plannedPence: alloc.result.unallocatedPence,
          sort: plan.lines.length,
          notes: 'Money the allocator would not spend past the evidence.',
        })
    }
    await touch(plan.id, plan)
    target = (await loadPlan(args.workspaceId, plan.id))!
  } else {
    target = await revisePlan({ workspaceId: args.workspaceId, actorId: args.actorId, planId: plan.id, amounts, note: 'From the allocator' })
  }
  await db.update(budgetAllocations).set({ appliedPlanId: target.id, appliedAt: new Date(), appliedBy: args.actorId }).where(eq(budgetAllocations.id, alloc.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.allocation_applied',
    subjectType: 'budget_plan',
    subjectId: target.id,
    summary: `Allocator recommendation applied to "${target.name}". It needs approval before it goes live.`,
    payload: { allocationId: alloc.id, hash: alloc.resultHash },
  })
  return target
}

/* ================================================================= cards */

export async function listCards(workspaceId: string): Promise<PaymentCard[]> {
  return db.select().from(paymentCards).where(eq(paymentCards.workspaceId, workspaceId)).orderBy(asc(paymentCards.createdAt))
}

async function loadRules(workspaceId: string): Promise<MerchantRule[]> {
  const rows = await db.select().from(merchantRules).where(eq(merchantRules.workspaceId, workspaceId)).orderBy(desc(merchantRules.createdAt))
  return rows.map((r) => ({ id: r.id, contains: r.contains, channelKey: r.channelKey, lineId: null, ignore: r.ignore }))
}

type IncomingTx = {
  day: string
  postedAt?: string
  amountPence: number
  currency: string
  descriptor: string
  status: 'pending' | 'settled'
  providerTxId?: string | null
  originalAmountMinor?: number | null
  originalCurrency?: string | null
}

/** Normalise, classify and upsert a batch of transactions for one card. */
async function storeTransactions(workspaceId: string, card: PaymentCard, incoming: IncomingTx[], simulated: boolean): Promise<{ added: number; total: number }> {
  if (incoming.length === 0) return { added: 0, total: 0 }
  const rules = await loadRules(workspaceId)
  const keyed = withOccurrence(
    card.id,
    incoming.map((t) => ({ ...t, descriptor: sanitiseDescriptor(t.descriptor) })),
  )
  const values = keyed.map((t) => {
    const c = classify(t.descriptor, rules)
    // A card dedicated to one channel: everything on it belongs there.
    const channelKey = card.channelKey ?? c.channelKey
    return {
      workspaceId,
      cardId: card.id,
      externalId: t.key,
      providerTxId: t.providerTxId ?? null,
      postedAt: new Date(t.postedAt ?? `${t.day}T12:00:00Z`),
      amountPence: t.amountPence,
      currency: t.currency,
      originalAmountMinor: t.originalAmountMinor ?? null,
      originalCurrency: t.originalCurrency ?? null,
      descriptor: t.descriptor,
      status: t.status,
      channelKey,
      accountRef: c.accountRef,
      classifiedVia: card.channelKey ? 'card' : c.via,
      ignored: c.via === 'ignored',
      simulated,
    }
  })
  let added = 0
  for (let i = 0; i < values.length; i += 300) {
    const res = await db
      .insert(cardTransactions)
      .values(values.slice(i, i + 300))
      .onConflictDoUpdate({
        target: [cardTransactions.cardId, cardTransactions.externalId],
        // A pending item that settles keeps its row; a person's assignment is never overwritten.
        set: { status: sql`excluded.status`, providerTxId: sql`excluded.provider_tx_id` },
      })
      .returning({ created: sql<boolean>`xmax = 0` })
    added += res.filter((r) => r.created).length
  }
  return { added, total: values.length }
}

export async function addSimulatedCard(args: { workspaceId: string; actorId: string | null; planId?: string | null }): Promise<PaymentCard> {
  const plan = args.planId ? await loadPlan(args.workspaceId, args.planId) : await currentPlan(args.workspaceId)
  const [card] = await db
    .insert(paymentCards)
    .values({
      workspaceId: args.workspaceId,
      provider: 'simulated',
      label: 'Marketing card (simulated)',
      last4: '4242',
      network: 'visa',
      monthlyLimitPence: plan ? Math.round(plan.totalPence * 1.05) : 1_500_000,
      simulated: true,
      createdBy: args.actorId,
      lastSyncAt: new Date(),
    })
    .returning()
  await syncSimulatedCard(args.workspaceId, card, plan)
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'budget.card_connected',
    subjectType: 'payment_card',
    subjectId: card.id,
    summary: 'Simulated marketing card added. Its charges are fictional and labelled as such.',
  })
  return card
}

async function syncSimulatedCard(workspaceId: string, card: PaymentCard, plan: PlanWithLines | null) {
  const t = today()
  const from = plan ? String(plan.periodStart) : addDays(t, -30)
  const to = plan ? String(plan.periodEnd) : t
  const days = await db
    .select()
    .from(budgetPlatformSpend)
    .where(and(eq(budgetPlatformSpend.workspaceId, workspaceId), gte(budgetPlatformSpend.day, from), lte(budgetPlatformSpend.day, to)))
  const [acct] = await db.select({ id: adAccounts.customerId }).from(adAccounts).where(eq(adAccounts.workspaceId, workspaceId)).limit(1)
  const feed = simulateCardFeed({
    cardId: card.id,
    from,
    to,
    today: t,
    platformDays: pickPlatformDays(days, from, to).filter((d) => ['google_ads', 'meta_ads', 'linkedin_ads'].includes(d.platform)),
    googleCustomerId: acct?.id ?? '4820917365',
    seed: card.id.slice(0, 8),
  })
  await storeTransactions(
    workspaceId,
    card,
    feed.map((f) => ({ ...f, day: f.postedAt.slice(0, 10) })),
    true,
  )
}

export async function importStatement(args: {
  workspaceId: string
  actorId: string
  cardId: string | null
  label: string
  last4: string | null
  text: string
  sign: CsvSign
}): Promise<{ card: PaymentCard; added: number; total: number; skipped: number; detected: ReturnType<typeof parseStatement>['detected'] }> {
  const parsed = parseStatement(args.text, { sign: args.sign })
  if (parsed.rows.length === 0) throw new BudgetError('No transactions could be read from the file.')
  let card: PaymentCard | undefined
  if (args.cardId) {
    ;[card] = await db.select().from(paymentCards).where(and(eq(paymentCards.workspaceId, args.workspaceId), eq(paymentCards.id, args.cardId))).limit(1)
    if (!card) throw new BudgetError('Card not found.')
  } else {
    if (args.last4 && !/^\d{4}$/.test(args.last4)) throw new BudgetError('Enter only the last four digits of the card — never the full number.')
    ;[card] = await db
      .insert(paymentCards)
      .values({ workspaceId: args.workspaceId, provider: 'csv', label: args.label.trim() || 'Statement import', last4: args.last4, createdBy: args.actorId })
      .returning()
  }
  const res = await storeTransactions(args.workspaceId, card, parsed.rows, false)
  await db.update(paymentCards).set({ lastSyncAt: new Date(), lastError: null }).where(eq(paymentCards.id, card.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.statement_imported',
    subjectType: 'payment_card',
    subjectId: card.id,
    summary: `${res.added} new transactions imported to "${card.label}" from a statement (${parsed.skipped.length} rows skipped).`,
    payload: { detected: parsed.detected, total: res.total },
  })
  return { card, ...res, skipped: parsed.skipped.length, detected: parsed.detected }
}

/**
 * One row per real card. A reconnect (UK Open Banking every 90 days, or new
 * Airwallex keys) refreshes the credentials on the existing row, so its
 * transactions keep their keys and nothing is counted twice.
 */
async function upsertCard(values: typeof paymentCards.$inferInsert): Promise<PaymentCard> {
  const [row] = await db
    .insert(paymentCards)
    .values(values)
    .onConflictDoUpdate({
      target: [paymentCards.workspaceId, paymentCards.provider, paymentCards.externalId],
      set: {
        credentialRef: values.credentialRef ?? null,
        consentExpiresAt: values.consentExpiresAt ?? null,
        status: 'connected',
        lastError: null,
        ...(values.monthlyLimitPence !== undefined ? { monthlyLimitPence: values.monthlyLimitPence } : {}),
      },
    })
    .returning()
  return row
}

/** TrueLayer callback: one card row per card on the connected account. */
export async function connectTrueLayer(args: { workspaceId: string; actorId: string; code: string }): Promise<PaymentCard[]> {
  const tokens = await exchangeCode(args.code)
  const cards = await tlCards(tokens.access_token)
  if (cards.length === 0) throw new BudgetError('The bank returned no cards. Not every bank supports card access through Open Banking — import a statement instead.')
  const cred = encryptToken(JSON.stringify({ refresh: tokens.refresh_token ?? null, access: tokens.access_token, exp: Date.now() + tokens.expires_in * 1000 }))
  const consent = new Date(Date.now() + RECONFIRM_DAYS * 86_400_000)
  const out: PaymentCard[] = []
  for (const c of cards) {
    const row = await upsertCard({
        workspaceId: args.workspaceId,
        provider: 'truelayer',
        label: c.display_name ?? 'Company card',
        last4: (c.partial_card_number ?? '').replace(/\D/g, '').slice(-4) || null,
        network: c.card_network?.toLowerCase() ?? null,
        currency: c.currency ?? 'GBP',
        externalId: c.account_id,
        credentialRef: cred,
        consentExpiresAt: consent,
        createdBy: args.actorId,
      })
    out.push(row)
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.card_connected',
    subjectType: 'payment_card',
    subjectId: out[0].id,
    summary: `${out.length} card${out.length === 1 ? '' : 's'} connected through TrueLayer (read-only). Access must be reconfirmed by ${isoDay(consent)}.`,
  })
  for (const c of out) await syncCard(args.workspaceId, c.id).catch(() => undefined)
  return out
}

export async function connectAirwallex(args: { workspaceId: string; actorId: string; clientId: string; apiKey: string; demo: boolean }): Promise<PaymentCard[]> {
  const creds: AirwallexCreds = { clientId: args.clientId.trim(), apiKey: args.apiKey.trim(), demo: args.demo }
  if (!creds.clientId || !creds.apiKey) throw new BudgetError('Enter the client ID and API key from Airwallex → Developer → API keys.')
  const token = await airwallexLogin(creds)
  const cards = (await airwallexCards(creds, token)).filter((c) => (c.form_factor ?? 'VIRTUAL') === 'VIRTUAL' || c.card_status !== 'CLOSED')
  if (cards.length === 0) throw new BudgetError('No cards on that Airwallex account. Create a virtual card in Airwallex, then connect again.')
  const cred = encryptToken(JSON.stringify(creds))
  const out: PaymentCard[] = []
  for (const c of cards) {
    const limit = c.authorization_controls?.transaction_limits?.limits?.find((l) => l.interval === 'MONTHLY')
    const row = await upsertCard({
        workspaceId: args.workspaceId,
        provider: 'airwallex',
        label: c.nick_name ?? 'Airwallex card',
        last4: last4(c.card_number),
        currency: c.authorization_controls?.transaction_limits?.currency ?? 'GBP',
        externalId: c.card_id,
        monthlyLimitPence: limit ? Math.round(limit.amount * 100) : null,
        credentialRef: cred,
        createdBy: args.actorId,
      })
    out.push(row)
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.card_connected',
    subjectType: 'payment_card',
    subjectId: out[0].id,
    summary: `${out.length} Airwallex card${out.length === 1 ? '' : 's'} connected${args.demo ? ' (sandbox)' : ''}.`,
  })
  for (const c of out) await syncCard(args.workspaceId, c.id).catch(() => undefined)
  return out
}

export async function syncCard(workspaceId: string, cardId: string): Promise<{ added: number; total: number }> {
  const [card] = await db.select().from(paymentCards).where(and(eq(paymentCards.workspaceId, workspaceId), eq(paymentCards.id, cardId))).limit(1)
  if (!card) throw new BudgetError('Card not found.')
  const to = today()
  const from = addDays(to, -89)
  try {
    let res = { added: 0, total: 0 }
    if (card.provider === 'simulated') {
      await syncSimulatedCard(workspaceId, card, await currentPlan(workspaceId))
    } else if (card.provider === 'truelayer') {
      if (!card.credentialRef || !card.externalId) throw new BudgetError('Reconnect this card.')
      if (card.consentExpiresAt && card.consentExpiresAt.getTime() < Date.now()) {
        throw new BudgetError('Access to this card has lapsed. UK rules require reconfirming every 90 days — reconnect it.')
      }
      const c = JSON.parse(decryptToken(card.credentialRef)) as { refresh: string | null; access: string; exp: number }
      let access = c.access
      if (c.exp < Date.now() + 60_000) {
        if (!c.refresh) throw new BudgetError('Access to this card has expired. Reconnect it.')
        const t = await refreshTokens(c.refresh)
        access = t.access_token
        await db
          .update(paymentCards)
          .set({ credentialRef: encryptToken(JSON.stringify({ refresh: t.refresh_token ?? c.refresh, access, exp: Date.now() + t.expires_in * 1000 })) })
          .where(eq(paymentCards.id, card.id))
      }
      const settled = (await tlTransactions(access, card.externalId, from, to)).map((t) => normaliseTrueLayerTx(t, 'settled'))
      const pending = (await pendingCardTransactions(access, card.externalId)).map((t) => normaliseTrueLayerTx(t, 'pending'))
      res = await storeTransactions(workspaceId, card, [...settled, ...pending], false)
    } else if (card.provider === 'airwallex') {
      if (!card.credentialRef || !card.externalId) throw new BudgetError('Reconnect this card.')
      const creds = JSON.parse(decryptToken(card.credentialRef)) as AirwallexCreds
      const token = await airwallexLogin(creds)
      const txs = (await airwallexTransactions(creds, token, card.externalId, from, to)).map(normaliseAirwallexTx).filter((t): t is NonNullable<typeof t> => t !== null)
      res = await storeTransactions(workspaceId, card, txs, false)
    } else {
      return res // statement cards update by import
    }
    await db.update(paymentCards).set({ lastSyncAt: new Date(), lastError: null, status: 'connected' }).where(eq(paymentCards.id, card.id))
    return res
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sync failed.'
    await db.update(paymentCards).set({ lastError: msg, status: 'error' }).where(eq(paymentCards.id, card.id))
    throw e instanceof BudgetError ? e : new BudgetError(msg)
  }
}

export async function setCardChannel(args: { workspaceId: string; actorId: string; cardId: string; channelKey: string | null; monthlyLimitPence?: number | null }) {
  if (args.channelKey && !channelDef(args.channelKey)) throw new BudgetError('Unknown budget line type.')
  const [card] = await db
    .update(paymentCards)
    .set({ channelKey: args.channelKey, ...(args.monthlyLimitPence !== undefined ? { monthlyLimitPence: args.monthlyLimitPence } : {}) })
    .where(and(eq(paymentCards.workspaceId, args.workspaceId), eq(paymentCards.id, args.cardId)))
    .returning()
  if (!card) throw new BudgetError('Card not found.')
  if (args.channelKey) {
    await db
      .update(cardTransactions)
      .set({ channelKey: args.channelKey, classifiedVia: 'card' })
      .where(and(eq(cardTransactions.cardId, card.id), sql`${cardTransactions.lineChannelKey} is null`, ne(cardTransactions.classifiedVia, 'manual')))
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.card_updated',
    subjectType: 'payment_card',
    subjectId: card.id,
    summary: args.channelKey ? `"${card.label}" dedicated to ${channelLabelFor(args.channelKey)}.` : `"${card.label}" is a shared card again.`,
  })
}

/**
 * Enforce a line's budget as the card's monthly limit (Airwallex only). The
 * platform-side cap is still the first line of defence; this one stops the
 * payment, not the delivery.
 */
export async function enforceCardLimit(args: { workspaceId: string; actorId: string; cardId: string; amountPence: number }) {
  const [card] = await db.select().from(paymentCards).where(and(eq(paymentCards.workspaceId, args.workspaceId), eq(paymentCards.id, args.cardId))).limit(1)
  if (!card) throw new BudgetError('Card not found.')
  if (card.provider !== 'airwallex' && card.provider !== 'simulated') throw new BudgetError('Only issued cards (Airwallex) can have their limit set from Aurea. Read-only cards are monitored, not controlled.')
  if (!(args.amountPence > 0)) throw new BudgetError('Set a limit above zero.')
  if (card.currency.toUpperCase() !== 'GBP') {
    throw new BudgetError(`This card is held in ${card.currency}. Budget lines are in GBP, so Aurea will not set its limit from one — set it in Airwallex in ${card.currency}.`)
  }
  let sent: Record<string, unknown> = { simulated: true }
  if (card.provider === 'airwallex') {
    if (!card.credentialRef || !card.externalId) throw new BudgetError('Reconnect this card.')
    const creds = JSON.parse(decryptToken(card.credentialRef)) as AirwallexCreds
    const token = await airwallexLogin(creds)
    sent = await airwallexSetMonthlyLimit(creds, token, card.externalId, args.amountPence, card.currency)
  }
  await db.update(paymentCards).set({ monthlyLimitPence: args.amountPence }).where(eq(paymentCards.id, card.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.card_limit_set',
    subjectType: 'payment_card',
    subjectId: card.id,
    summary: `Monthly limit on "${card.label}" set to ${money(args.amountPence)}${card.provider === 'simulated' ? ' (simulated card)' : ''}.`,
    payload: { previous: card.monthlyLimitPence, request: sent },
  })
}

export async function removeCard(args: { workspaceId: string; actorId: string; cardId: string }) {
  const [card] = await db.delete(paymentCards).where(and(eq(paymentCards.workspaceId, args.workspaceId), eq(paymentCards.id, args.cardId))).returning()
  if (!card) throw new BudgetError('Card not found.')
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.card_removed',
    subjectType: 'payment_card',
    subjectId: card.id,
    summary: `"${card.label}" disconnected and its transactions deleted. Revoke access at the bank or provider too.`,
  })
}

/**
 * Assign a transaction to a line (or mark it not marketing), and optionally
 * teach a rule so future charges from the same merchant follow.
 */
export async function assignTransaction(args: {
  workspaceId: string
  actorId: string
  txId: string
  channelKey: string | null
  ignore: boolean
  remember: string | null
}) {
  if (args.channelKey && !channelDef(args.channelKey)) throw new BudgetError('Unknown budget line type.')
  const [tx] = await db
    .update(cardTransactions)
    .set({ lineChannelKey: args.ignore ? null : args.channelKey, channelKey: args.ignore ? null : args.channelKey, ignored: args.ignore, classifiedVia: 'manual' })
    .where(and(eq(cardTransactions.workspaceId, args.workspaceId), eq(cardTransactions.id, args.txId)))
    .returning()
  if (!tx) throw new BudgetError('Transaction not found.')
  let applied = 0
  if (args.remember && args.remember.trim().length >= 3) {
    const contains = args.remember.trim().toUpperCase().slice(0, 80)
    if (!tx.descriptor.toUpperCase().includes(contains)) throw new BudgetError('The text to remember must appear in the merchant description.')
    await db
      .insert(merchantRules)
      .values({ workspaceId: args.workspaceId, contains, channelKey: args.ignore ? null : args.channelKey, ignore: args.ignore, createdBy: args.actorId })
      .onConflictDoUpdate({ target: [merchantRules.workspaceId, merchantRules.contains], set: { channelKey: args.ignore ? null : args.channelKey, ignore: args.ignore } })
    const res = await db
      .update(cardTransactions)
      .set({ channelKey: args.ignore ? null : args.channelKey, ignored: args.ignore, classifiedVia: 'rule' })
      .where(
        and(
          eq(cardTransactions.workspaceId, args.workspaceId),
          sql`upper(${cardTransactions.descriptor}) like ${'%' + contains.replace(/[%_\\]/g, (m) => '\\' + m) + '%'}`,
          sql`${cardTransactions.lineChannelKey} is null`,
          ne(cardTransactions.classifiedVia, 'card'),
          ne(cardTransactions.classifiedVia, 'manual'),
        ),
      )
      .returning({ id: cardTransactions.id })
    applied = res.length
  }
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.transaction_assigned',
    subjectType: 'card_transaction',
    subjectId: tx.id,
    summary: `${money(tx.amountPence)} "${tx.descriptor}" ${args.ignore ? 'marked not marketing' : `assigned to ${channelLabelFor(args.channelKey)}`}${args.remember ? `; future "${args.remember.trim()}" charges follow (${applied} updated)` : ''}.`,
  })
  return { applied }
}

export async function transactionsFor(workspaceId: string, from: string, to: string, limit = 500) {
  return db
    .select({ tx: cardTransactions, cardLabel: paymentCards.label, provider: paymentCards.provider })
    .from(cardTransactions)
    .innerJoin(paymentCards, eq(paymentCards.id, cardTransactions.cardId))
    .where(
      and(
        eq(cardTransactions.workspaceId, workspaceId),
        gte(cardTransactions.postedAt, new Date(`${from}T00:00:00Z`)),
        lte(cardTransactions.postedAt, new Date(`${to}T23:59:59Z`)),
      ),
    )
    .orderBy(desc(cardTransactions.postedAt))
    .limit(limit)
}

/* ======================================================== reconciliation */

export async function runReconciliation(args: { workspaceId: string; actorId: string | null; planId: string }) {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  const from = String(plan.periodStart)
  const to = String(plan.periodEnd)
  const t = today()

  const txRows = await db
    .select()
    .from(cardTransactions)
    .where(
      and(
        eq(cardTransactions.workspaceId, args.workspaceId),
        gte(cardTransactions.postedAt, new Date(`${from}T00:00:00Z`)),
        lte(cardTransactions.postedAt, new Date(`${to}T23:59:59Z`)),
      ),
    )
  const daysRows = await db
    .select()
    .from(budgetPlatformSpend)
    .where(and(eq(budgetPlatformSpend.workspaceId, args.workspaceId), gte(budgetPlatformSpend.day, from), lte(budgetPlatformSpend.day, to)))
  const platformDays = pickPlatformDays(daysRows, from, to)
  const connectedPlatforms = [...new Set(platformDays.map((d) => d.platform))]
  const accounts = await db.select({ id: adAccounts.customerId }).from(adAccounts).where(eq(adAccounts.workspaceId, args.workspaceId))

  const simulated = txRows.some((x) => x.simulated) || platformDays.some((d) => d.source === 'simulated')
  const report: ReconciliationReport = reconcile({
    periodStart: from,
    periodEnd: to,
    today: t,
    lines: plan.lines.map((l) => ({ id: l.id, key: l.channelKey, label: l.label, plannedPence: l.plannedPence })),
    txs: txRows.map((x) => ({
      id: x.id,
      cardId: x.cardId,
      externalId: x.externalId,
      // UK calendar day, so a charge at 00:30 BST lands on the day the statement shows.
      postedAt: `${londonDay(x.postedAt)}T${x.postedAt.toISOString().slice(11)}`,
      amountPence: x.amountPence,
      currency: x.currency,
      originalAmountMinor: x.originalAmountMinor,
      originalCurrency: x.originalCurrency,
      descriptor: x.descriptor,
      status: x.status as 'pending' | 'settled',
      platform: x.channelKey,
      lineId: null,
      accountRef: x.accountRef,
      ignored: x.ignored,
    })),
    platformDays,
    connectedPlatforms,
    knownGoogleAccounts: accounts.map((a) => a.id),
    cardCurrency: plan.currency,
    simulated,
  })

  const [row] = await db
    .insert(budgetReconciliations)
    .values({ workspaceId: args.workspaceId, planId: plan.id, report, reportHash: sha(report), createdBy: args.actorId })
    .returning()

  // Persist discrepancies by fingerprint.
  const existing = await db.select().from(budgetDiscrepancies).where(eq(budgetDiscrepancies.planId, plan.id))
  const byFp = new Map(existing.map((d) => [d.fingerprint, d]))
  const now = new Date()
  const fresh: typeof report.discrepancies = []
  for (const d of report.discrepancies) {
    const have = byFp.get(d.fingerprint)
    const values = {
      kind: d.kind,
      severity: d.severity,
      platform: d.platform,
      lineId: d.lineId,
      amountPence: d.amountPence,
      title: d.title,
      detail: d.detail,
      suggestion: d.suggestion,
      txIds: d.txIds,
      present: true,
      lastSeenAt: now,
    }
    if (have) {
      // A resolved problem that comes back is open again: resolving it did not fix it.
      const rankOf: Record<string, number> = { low: 0, medium: 1, high: 2 }
      const worse =
        have.status !== 'open' &&
        ((rankOf[d.severity] ?? 0) > (rankOf[have.severity] ?? 0) || d.amountPence > have.amountPence * 1.25 + 5_000)
      // Reopen when a resolved problem comes back, or an explained or resolved one gets materially worse.
      const reopened = (have.status === 'resolved' && !have.present) || worse
      await db
        .update(budgetDiscrepancies)
        .set({
          ...values,
          ...(reopened
            ? {
                status: 'open',
                resolvedAt: null,
                resolvedBy: null,
                note: worse ? `Reopened: it grew from ${money(have.amountPence)} (${have.severity}) after being marked ${have.status}. Earlier note: ${have.note ?? '—'}` : have.note,
              }
            : {}),
        })
        .where(eq(budgetDiscrepancies.id, have.id))
      if (reopened) fresh.push(d)
    } else {
      await db.insert(budgetDiscrepancies).values({ ...values, workspaceId: args.workspaceId, planId: plan.id, fingerprint: d.fingerprint })
      fresh.push(d)
    }
  }
  const seen = new Set(report.discrepancies.map((d) => d.fingerprint))
  for (const d of existing) {
    if (!seen.has(d.fingerprint) && d.present) {
      await db.update(budgetDiscrepancies).set({ present: false, ...(d.status === 'open' ? { status: 'resolved', note: d.note ?? 'No longer found by the reconciliation.' , resolvedAt: now } : {}) }).where(eq(budgetDiscrepancies.id, d.id))
    }
  }

  const urgent = fresh.filter((d) => d.severity === 'high')
  if (urgent.length && plan.status === 'active') await notifyFinance(args.workspaceId, urgent.map((d) => d.title))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'budget.reconciled',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Reconciled "${plan.name}": plan ${money(report.totals.plannedPence)}, platforms ${money(report.totals.platformPence)}, card ${money(report.totals.cardPence)}; ${report.discrepancies.length} discrepanc${report.discrepancies.length === 1 ? 'y' : 'ies'}${fresh.length ? ` (${fresh.length} new)` : ''}.`,
    payload: { reconciliationId: row.id, hash: row.reportHash, simulated },
  })
  return row
}

async function notifyFinance(workspaceId: string, titles: string[]) {
  const people = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['owner', 'admin'])))
  if (people.length === 0) return
  await db.insert(notifications).values(
    people.map((p) => ({
      workspaceId,
      userId: p.userId,
      type: 'budget.discrepancy',
      title: titles.length === 1 ? titles[0] : `${titles.length} new budget discrepancies need a look`,
      body: titles.length > 1 ? titles.slice(0, 3).join('; ') : null,
      href: '/budget?tab=reconcile',
    })),
  )
}

export async function discrepanciesFor(workspaceId: string, planId: string) {
  return db
    .select()
    .from(budgetDiscrepancies)
    .where(and(eq(budgetDiscrepancies.workspaceId, workspaceId), eq(budgetDiscrepancies.planId, planId)))
    .orderBy(asc(budgetDiscrepancies.status), desc(budgetDiscrepancies.amountPence))
}

export async function setDiscrepancyStatus(args: {
  workspaceId: string
  actorId: string
  id: string
  status: 'open' | 'explained' | 'resolved'
  note: string | null
}) {
  if (args.status !== 'open' && !args.note?.trim()) throw new BudgetError('Say what explains or resolved it. The note goes on the audit trail.')
  const [d] = await db
    .update(budgetDiscrepancies)
    .set({
      status: args.status,
      note: args.note?.trim() || null,
      resolvedBy: args.status === 'open' ? null : args.actorId,
      resolvedAt: args.status === 'open' ? null : new Date(),
    })
    .where(and(eq(budgetDiscrepancies.workspaceId, args.workspaceId), eq(budgetDiscrepancies.id, args.id)))
    .returning()
  if (!d) throw new BudgetError('Discrepancy not found.')
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'budget.discrepancy_updated',
    subjectType: 'budget_plan',
    subjectId: d.planId,
    summary: `"${d.title}" marked ${args.status}${args.note ? `: ${args.note.trim()}` : ''}.`,
    payload: { discrepancyId: d.id, amountPence: d.amountPence },
  })
}

/* ================================================================ pacing */

export type PacingView = {
  lines: (PacingLine & { channelKey: string; category: string; source: 'platform' | 'card' | 'none' })[]
  cash: CashForecast | null
  today: string
}

export async function pacingFor(workspaceId: string, plan: PlanWithLines): Promise<PacingView> {
  const t = today()
  const from = String(plan.periodStart)
  const to = String(plan.periodEnd)
  const histFrom = addDays(from, -56)
  const days = await db
    .select()
    .from(budgetPlatformSpend)
    .where(and(eq(budgetPlatformSpend.workspaceId, workspaceId), gte(budgetPlatformSpend.day, histFrom), lte(budgetPlatformSpend.day, to)))
  const perDay = new Map<string, { platform: string; day: string; spendPence: number; simulated: boolean }>()
  for (const d of pickPlatformDays(days, from, to)) perDay.set(`${d.platform}|${d.day}`, { platform: d.platform, day: d.day, spendPence: d.spendPence, simulated: d.source === 'simulated' })
  const txs = await db
    .select()
    .from(cardTransactions)
    .where(
      and(
        eq(cardTransactions.workspaceId, workspaceId),
        eq(cardTransactions.status, 'settled'),
        eq(cardTransactions.ignored, false),
        gte(cardTransactions.postedAt, new Date(`${from}T00:00:00Z`)),
        lte(cardTransactions.postedAt, new Date(`${to}T23:59:59Z`)),
      ),
    )
  const live = await db
    .select({ id: adCampaigns.id, daily: adCampaigns.dailyBudgetMicros, status: adCampaigns.status })
    .from(adCampaigns)
    .where(and(eq(adCampaigns.workspaceId, workspaceId), eq(adCampaigns.status, 'live')))

  const lines: PacingView['lines'] = plan.lines.map((l) => {
    const platformDaily = [...perDay.values()].filter((d) => d.platform === l.channelKey)
    const cardDaily = txs
      .filter((x) => x.channelKey === l.channelKey)
      .reduce((m, x) => {
        const d = londonDay(x.postedAt)
        m.set(d, (m.get(d) ?? 0) + x.amountPence)
        return m
      }, new Map<string, number>())
    const usePlatform = platformDaily.some((d) => d.day >= from)
    const source: 'platform' | 'card' | 'none' = usePlatform ? 'platform' : cardDaily.size ? 'card' : 'none'
    const daily = usePlatform
      ? platformDaily.filter((d) => d.day >= from).map((d) => ({ day: d.day, spendPence: d.spendPence }))
      : [...cardDaily.entries()].map(([day, spendPence]) => ({ day, spendPence }))
    const linkedLive = live.filter((c) => l.adCampaignIds.includes(c.id))
    const dailyBudget = linkedLive.length ? Math.round(linkedLive.reduce((a, c) => a + c.daily, 0) / 10_000) : null
    const p = paceLine({
      lineId: l.id,
      label: l.label,
      channelKey: l.channelKey,
      plannedPence: l.plannedPence,
      periodStart: from,
      periodEnd: to,
      today: t,
      daily,
      history: usePlatform ? platformDaily.map((d) => ({ day: d.day, spendPence: d.spendPence })) : undefined,
      dailyBudgetPence: dailyBudget,
    })
    if (source === 'none' && channelDef(l.channelKey)?.category !== 'paid_media') {
      const reserve = l.category === 'reserve'
      return {
        ...p,
        projectedPence: reserve ? 0 : l.plannedPence,
        status: 'no_data' as const,
        variancePct: 0,
        suggestedDailyPence: null,
        note: reserve
          ? 'Held in reserve. Nothing is drawn from it until a revision moves it to a line.'
          : 'Nothing recorded yet. This line is tracked from card charges (or imported history); none have arrived for it this period.',
        channelKey: l.channelKey,
        category: l.category,
        source,
      }
    }
    // Subscriptions and one-off costs land in lumps; a run rate from a lump is meaningless.
    if (source === 'card' && channelDef(l.channelKey)?.category !== 'paid_media') {
      const used = p.actualPence
      const over = used - l.plannedPence
      return {
        ...p,
        projectedPence: Math.max(used, l.plannedPence),
        status: over > 500 ? 'over' : 'on_track',
        variancePct: l.plannedPence ? Math.max(0, over) / l.plannedPence : 0,
        suggestedDailyPence: null,
        note: over > 500 ? `${money(over)} over plan already.` : `${money(used)} of ${money(l.plannedPence)} used. Costs on this line arrive as one-off charges, so no run rate is projected.`,
        channelKey: l.channelKey,
        category: l.category,
        source,
      }
    }
    return { ...p, channelKey: l.channelKey, category: l.category, source }
  })

  // Cash forecast across ad platforms, from the latest reconciliation.
  const recon = await latestReconciliation(workspaceId, plan.id)
  let cash: CashForecast | null = null
  const cards = await listCards(workspaceId)
  if (cards.length) {
    const charged = txs.reduce((a, x) => a + x.amountPence, 0)
    const paid = plan.lines.filter((l) => channelDef(l.channelKey)?.category === 'paid_media')
    const platforms = paid.map((l) => {
      const row = recon?.report.rows.find((r) => r.lineId === l.id || r.platform === l.channelKey)
      const recent = [...perDay.values()].filter((d) => d.platform === l.channelKey && d.day < t && d.day >= addDays(t, -7))
      const rate = recent.length ? recent.reduce((a, d) => a + d.spendPence, 0) / 7 : l.plannedPence / Math.max(1, daysBetween(from, to) + 1)
      const unbilled = row && row.platformPence !== null ? Math.max(0, row.platformPence - row.cardPence) : 0
      const def = channelDef(l.channelKey)
      return {
        platform: l.channelKey,
        label: l.label,
        unbilledPence: Math.min(unbilled, def?.billing?.thresholdPence ?? unbilled),
        dailyRatePence: Math.round(rate),
        thresholdPence: def?.billing?.thresholdPence ?? null,
        maxDaysBetweenCharges: 30,
        cashFactor: recon?.report.cashFactors[l.channelKey] ?? 1,
      }
    })
    const limit = plan.cardLimitPence ?? (cards.every((c) => c.monthlyLimitPence) ? cards.reduce((a, c) => a + (c.monthlyLimitPence ?? 0), 0) : null)
    cash = forecastCash({ today: t, periodEnd: to, platforms, alreadyChargedPence: charged, limitPence: limit })
  }
  return { lines, cash, today: t }
}

/* ======================================================= linked controls */

export type LinkedControl = {
  lineId: string
  lineLabel: string
  kind: 'ad_campaign' | 'video_ceiling' | 'card'
  id: string
  name: string
  status: string
  currentDailyPence: number | null
  recommendedDailyPence: number | null
  /** Whether Aurea can apply it, and if not, why. */
  canApply: boolean
  note: string
}

/**
 * Where the plan's money is actually controlled: Aurea Google Ads campaigns
 * linked to a line, the Video Studio monthly ceiling, and dedicated cards.
 * The recommended daily budget lands the line on plan from today.
 */
export async function linkedControls(workspaceId: string, plan: PlanWithLines): Promise<LinkedControl[]> {
  const t = today()
  const end = String(plan.periodEnd)
  const remainingDays = Math.max(1, daysBetween(t < String(plan.periodStart) ? String(plan.periodStart) : t, end) + 1)
  const pacing = plan.status === 'active' ? await pacingFor(workspaceId, plan) : null
  const out: LinkedControl[] = []
  const ids = plan.lines.flatMap((l) => l.adCampaignIds)
  const camps = ids.length
    ? await db.select().from(adCampaigns).where(and(eq(adCampaigns.workspaceId, workspaceId), inArray(adCampaigns.id, ids)))
    : []
  for (const l of plan.lines) {
    const mine = camps.filter((c) => l.adCampaignIds.includes(c.id))
    if (mine.length) {
      const actual = pacing?.lines.find((p) => p.lineId === l.id)?.actualPence ?? 0
      const remaining = Math.max(0, l.plannedPence - actual)
      const totalDaily = mine.reduce((a, c) => a + c.dailyBudgetMicros, 0)
      for (const c of mine) {
        const share = totalDaily > 0 ? c.dailyBudgetMicros / totalDaily : 1 / mine.length
        const rec = Math.round((remaining / remainingDays) * share)
        const pushed = c.status === 'live' || c.status === 'paused'
        out.push({
          lineId: l.id,
          lineLabel: l.label,
          kind: 'ad_campaign',
          id: c.id,
          name: c.name,
          status: c.status,
          currentDailyPence: Math.round(c.dailyBudgetMicros / 10_000),
          recommendedDailyPence: rec,
          canApply: !pushed && plan.status === 'active',
          note: pushed
            ? 'Already in Google. Change the daily budget there; Aurea does not edit live campaigns.'
            : plan.status !== 'active'
              ? 'Activate the plan first.'
              : 'Applying changes the draft and sends it back for approval, like any budget edit.',
        })
      }
    }
    if (l.channelKey === 'video_production') {
      out.push({
        lineId: l.id,
        lineLabel: l.label,
        kind: 'video_ceiling',
        id: 'video',
        name: 'Video Studio monthly ceiling',
        status: plan.status,
        currentDailyPence: null,
        recommendedDailyPence: null,
        canApply: plan.status === 'active',
        note: 'Sets the monthly generation ceiling in Video Studio from this line (converted to dollars at the configured rate).',
      })
    }
  }
  const cards = await listCards(workspaceId)
  for (const c of cards.filter((x) => x.channelKey)) {
    const l = plan.lines.find((x) => x.channelKey === c.channelKey)
    if (!l) continue
    const months = Math.max(1, Math.round((daysBetween(String(plan.periodStart), end) + 1) / 30.4))
    out.push({
      lineId: l.id,
      lineLabel: l.label,
      kind: 'card',
      id: c.id,
      name: `${c.label}${c.last4 ? ` ••${c.last4}` : ''}`,
      status: c.status,
      currentDailyPence: c.monthlyLimitPence,
      recommendedDailyPence: Math.round(l.plannedPence / months),
      canApply: (c.provider === 'airwallex' || c.provider === 'simulated') && plan.status === 'active',
      note:
        c.provider === 'airwallex' || c.provider === 'simulated'
          ? 'Sets the card’s monthly limit to this line’s monthly budget. A declined charge pauses delivery but does not cancel spend already delivered.'
          : 'Read-only card: monitored, not controlled.',
    })
  }
  return out
}

export async function applyAdDailyBudget(args: { workspaceId: string; actorId: string; planId: string; adCampaignId: string; dailyPence: number }) {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan || plan.status !== 'active') throw new BudgetError('Only a live plan can set campaign budgets.')
  if (!plan.lines.some((l) => l.adCampaignIds.includes(args.adCampaignId))) throw new BudgetError('That campaign is not linked to this plan.')
  if (!(args.dailyPence >= 100)) throw new BudgetError('A daily budget under £1 would not serve.')
  const [c] = await db.select().from(adCampaigns).where(and(eq(adCampaigns.workspaceId, args.workspaceId), eq(adCampaigns.id, args.adCampaignId))).limit(1)
  if (!c) throw new BudgetError('Campaign not found.')
  if (c.status === 'live' || c.status === 'paused') throw new BudgetError('This campaign is already in Google. Change its budget there.')
  await db
    .update(adCampaigns)
    .set({ dailyBudgetMicros: args.dailyPence * 10_000, status: 'draft', version: sql`${adCampaigns.version} + 1`, updatedAt: new Date() })
    .where(eq(adCampaigns.id, c.id))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'ads.budget_from_plan',
    subjectType: 'ad_campaign',
    subjectId: c.id,
    summary: `Daily budget of "${c.name}" set to ${money(args.dailyPence)} from budget plan "${plan.name}" (was ${money(Math.round(c.dailyBudgetMicros / 10_000))}). It needs approving again.`,
    payload: { planId: plan.id, fromMicros: c.dailyBudgetMicros, toMicros: args.dailyPence * 10_000 },
  })
}

/* ================================================================ demo */

/**
 * Fill a workspace with a simulated market: a year of weekly history across
 * five channels, daily platform spend for the plan period so far, and a
 * simulated card whose charges include the planted problems. Everything is
 * stored as simulated and labelled.
 */
export async function loadSimulation(args: { workspaceId: string; actorId: string | null; planId: string }) {
  const plan = await loadPlan(args.workspaceId, args.planId)
  if (!plan) throw new BudgetError('Plan not found.')
  const t = today()
  const history = simulateHistory({ endWeek: lastFullWeek(t), weeks: 60, seed: args.workspaceId.slice(0, 8) })
  const now = new Date()
  const obs = [...history.entries()].flatMap(([key, rows]) =>
    rows.map((o) => ({ workspaceId: args.workspaceId, channelKey: key, weekStart: o.weekStart, spendPence: o.spendPence, conversions: o.conversions, revenuePence: o.revenuePence, source: 'simulated', updatedAt: now })),
  )
  for (let i = 0; i < obs.length; i += 500) {
    await db
      .insert(budgetObservations)
      .values(obs.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [budgetObservations.workspaceId, budgetObservations.channelKey, budgetObservations.weekStart, budgetObservations.source],
        set: { spendPence: sql`excluded.spend_pence`, conversions: sql`excluded.conversions`, revenuePence: sql`excluded.revenue_pence`, updatedAt: now },
      })
  }
  // Platform spend for the period so far, paced to each paid line's plan (with a deliberate overspend on Google).
  const weeks = weeksIn(plan)
  const weekly: Record<string, number> = {}
  for (const l of plan.lines) {
    if (!['google_ads', 'meta_ads', 'linkedin_ads'].includes(l.channelKey)) continue
    weekly[l.channelKey] = Math.round((l.plannedPence / weeks) * (l.channelKey === 'google_ads' ? 1.14 : l.channelKey === 'linkedin_ads' ? 0.8 : 1))
  }
  const start = String(plan.periodStart)
  const yesterday = addDays(t, -1)
  const pFrom = addDays(start, -56)
  if (yesterday >= pFrom) {
    const days = simulatePlatformDays({ from: pFrom, to: yesterday < String(plan.periodEnd) ? yesterday : String(plan.periodEnd), seed: args.workspaceId.slice(0, 8), weekly })
    for (let i = 0; i < days.length; i += 500) {
      await db
        .insert(budgetPlatformSpend)
        .values(days.slice(i, i + 500).map((d) => ({ workspaceId: args.workspaceId, platform: d.platform, day: d.day, spendPence: d.spendPence, source: 'simulated', updatedAt: now })))
        .onConflictDoUpdate({
          target: [budgetPlatformSpend.workspaceId, budgetPlatformSpend.platform, budgetPlatformSpend.day, budgetPlatformSpend.source],
          set: { spendPence: sql`excluded.spend_pence`, updatedAt: now },
        })
    }
  }
  const existing = (await listCards(args.workspaceId)).find((c) => c.provider === 'simulated')
  if (existing) await syncSimulatedCard(args.workspaceId, existing, plan)
  else await addSimulatedCard({ workspaceId: args.workspaceId, actorId: args.actorId, planId: plan.id })
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'budget.simulation_loaded',
    subjectType: 'budget_plan',
    subjectId: plan.id,
    summary: `Simulated market loaded for "${plan.name}": 60 weeks of history on ${history.size} channels, platform spend and a simulated card.`,
  })
}

/* ================================================================= cron */

/** Nightly: refresh from Aurea, sync connected cards (at most every six hours), reconcile the live plan. */
export async function budgetTick(workspaceId: string): Promise<{ reconciled: boolean; cards: number }> {
  const plan = await activePlan(workspaceId)
  if (!plan) return { reconciled: false, cards: 0 }
  await syncFromAurea(workspaceId)
  let synced = 0
  for (const c of await listCards(workspaceId)) {
    if (c.provider !== 'truelayer' && c.provider !== 'airwallex') continue
    if (c.lastSyncAt && Date.now() - c.lastSyncAt.getTime() < 6 * 3_600_000) continue
    await syncCard(workspaceId, c.id).then(() => synced++).catch((e) => console.error(`budget: card sync ${c.id} failed`, e instanceof Error ? e.message : e))
  }
  await runReconciliation({ workspaceId, actorId: null, planId: plan.id })
  return { reconciled: true, cards: synced }
}

/* ============================================================== exports */

export function categoryGroups(plan: PlanWithLines) {
  const groups = new Map<string, { label: string; pence: number; lines: BudgetLine[] }>()
  for (const l of plan.lines) {
    const g = groups.get(l.category) ?? { label: CATEGORY_LABEL[l.category as LineCategory] ?? l.category, pence: 0, lines: [] }
    g.pence += l.plannedPence
    g.lines.push(l)
    groups.set(l.category, g)
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g }))
}

export function cardProviderLabel(p: CardProvider | string): string {
  return p === 'truelayer' ? 'Open Banking (TrueLayer)' : p === 'airwallex' ? 'Airwallex' : p === 'csv' ? 'Statement import' : 'Simulated'
}

export { dayRange }
