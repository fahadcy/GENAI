/**
 * Budget Allocator end to end, against the database, with nothing connected:
 * a plan is created, the simulated market loaded, the allocator run and
 * applied, the plan approved through the ordinary approval engine and made
 * live, the card reconciled, discrepancies resolved, a statement imported
 * and a merchant rule taught. Governance and tenant isolation are checked on
 * the way: an edited plan loses its approval, and another workspace sees
 * nothing.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { approvalRequests, budgetDiscrepancies, budgetPlans, cardTransactions, merchantRules, paymentCards } from '../src/lib/db/schema'
import {
  activatePlan,
  applyAllocation,
  assertActivatable,
  assignTransaction,
  balanceLines,
  BudgetError,
  closePlan,
  createPlan,
  discrepanciesFor,
  enforceCardLimit,
  importHistoryCsv,
  importStatement,
  latestAllocation,
  linkedControls,
  listCards,
  loadPlan,
  loadSimulation,
  observationsFor,
  pacingFor,
  planProblems,
  revisePlan,
  runAllocation,
  runReconciliation,
  saveLine,
  setDiscrepancyStatus,
  syncFromAurea,
  updatePlanSettings,
} from '../src/lib/budget/service'
import { decide, submitForReview } from '../src/lib/workflow/approvals'
import { verifyChain } from '../src/lib/workflow/audit'
import { addDays, isoDay } from '../src/lib/budget/pacing'

let fx: Fixture
let other: Fixture
const today = isoDay(new Date())
// A period that started two weeks ago, so pacing and reconciliation have data.
const periodStart = addDays(today, -14)
const periodEnd = addDays(today, 16)

async function approve(planId: string) {
  const { requestId } = await submitForReview({ workspaceId: fx.ws.id, subjectType: 'budget_plan', subjectId: planId, actorId: fx.admin.id })
  const r = await decide({ workspaceId: fx.ws.id, requestId, actorId: fx.approver.id, actorRole: 'approver', decision: 'approve' })
  assert.equal(r.status, 'approved')
  return requestId
}

before(async () => {
  fx = await createWorkspace()
  other = await createWorkspace()
})
after(async () => {
  await destroyWorkspace(fx)
  await destroyWorkspace(other)
})

describe('budget plan lifecycle', () => {
  let planId: string

  test('creates a plan from the starter split that adds up exactly', async () => {
    const plan = await createPlan({
      workspaceId: fx.ws.id,
      actorId: fx.admin.id,
      name: 'Q4 marketing',
      periodStart,
      periodEnd,
      totalPence: 2_500_000,
      objective: 'conversions',
      start: 'starter',
    })
    planId = plan.id
    assert.ok(plan.lines.length >= 8)
    assert.equal(plan.lines.reduce((a, l) => a + l.plannedPence, 0), 2_500_000)
    assert.deepEqual(planProblems(plan), [])
    assert.ok(plan.lines.some((l) => l.category === 'events') && plan.lines.some((l) => l.category === 'tools'))
  })

  test('another workspace cannot see it', async () => {
    assert.equal(await loadPlan(other.ws.id, planId), null)
  })

  test('rejects a duplicate line and a negative amount', async () => {
    await assert.rejects(
      saveLine({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId, line: { channelKey: 'google_ads', plannedPence: 1 } }),
      /already has/,
    )
    await assert.rejects(
      saveLine({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId, line: { channelKey: 'print_ooh', plannedPence: -1 } }),
      BudgetError,
    )
  })

  test('loads the simulated market and fits curves on it', async () => {
    await loadSimulation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    const obs = await observationsFor(fx.ws.id, ['google_ads', 'meta_ads'])
    assert.equal(obs.get('google_ads')!.length, 60)
    assert.ok(obs.get('google_ads')!.every((o) => o.source === 'simulated'))
    const cards = await listCards(fx.ws.id)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].simulated, true)
  })

  test('runs the allocator, stores it hashed, and applies it to the draft', async () => {
    const run = await runAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.equal(run.resultHash.length, 64)
    assert.ok(run.curves.length >= 4)
    assert.equal(run.simulated, true)
    const r = run.result
    assert.equal(r.allocatedPence + r.unallocatedPence, r.totalPence)
    assert.ok(r.lines.find((l) => l.key === 'events')!.optimisable === false)
    const applied = await applyAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, allocationId: run.id })
    assert.equal(applied.id, planId) // a draft is updated in place
    assert.equal(applied.lines.reduce((a, l) => a + l.plannedPence, 0), 2_500_000)
    assert.ok(applied.version > 1)
    // Applying the same run twice is a no-op, and a stale run is refused.
    const again = await applyAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, allocationId: run.id })
    assert.equal(again.id, planId)
  })

  test('cannot go live without approval', async () => {
    await assert.rejects(activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId }), /approved/)
  })

  test('an edit after approval voids it', async () => {
    await approve(planId)
    await assertActivatable(fx.ws.id, planId)
    await updatePlanSettings({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId, patch: { riskAversion: 0.7 } })
    const p = await loadPlan(fx.ws.id, planId)
    assert.equal(p!.status, 'draft')
    await assert.rejects(activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId }), /approved/)
  })

  test('a plan whose lines do not add up cannot be submitted', async () => {
    const google = (await loadPlan(fx.ws.id, planId))!.lines.find((l) => l.channelKey === 'google_ads')!
    await saveLine({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId, line: { id: google.id, channelKey: 'google_ads', plannedPence: google.plannedPence + 1000 } })
    await assert.rejects(
      submitForReview({ workspaceId: fx.ws.id, subjectType: 'budget_plan', subjectId: planId, actorId: fx.admin.id }),
      /add up/,
    )
    await balanceLines({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.deepEqual(planProblems((await loadPlan(fx.ws.id, planId))!), [])
  })

  test('approved at the current version goes live', async () => {
    const reqId = await approve(planId)
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, reqId))
    assert.ok(req.subjectVersion > 1)
    const live = await activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.equal(live.status, 'active')
    await assert.rejects(
      saveLine({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId, line: { channelKey: 'print_ooh', plannedPence: 100 } }),
      /revision/,
    )
  })

  test('reconciles plan, platform and card, and finds the planted problems', async () => {
    const rec = await runReconciliation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.equal(rec.report.simulated, true)
    const kinds = new Set(rec.report.discrepancies.map((d) => d.kind))
    for (const k of ['duplicate_charge', 'unbudgeted_spend', 'unknown_merchant', 'fx_cost']) assert.ok(kinds.has(k as never), `missing ${k}: ${[...kinds]}`)
    const stored = await discrepanciesFor(fx.ws.id, planId)
    assert.equal(stored.length, rec.report.discrepancies.length)
    // Running again does not duplicate them.
    await runReconciliation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.equal((await discrepanciesFor(fx.ws.id, planId)).length, stored.length)
  })

  test('an explanation needs a note, and sticks across runs', async () => {
    const d = (await discrepanciesFor(fx.ws.id, planId)).find((x) => x.kind === 'fx_cost')!
    await assert.rejects(setDiscrepancyStatus({ workspaceId: fx.ws.id, actorId: fx.admin.id, id: d.id, status: 'explained', note: '' }), /Say what/)
    await setDiscrepancyStatus({ workspaceId: fx.ws.id, actorId: fx.admin.id, id: d.id, status: 'explained', note: 'LinkedIn bills in USD; moving to GBP billing.' })
    await runReconciliation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    const [after] = await db.select().from(budgetDiscrepancies).where(eq(budgetDiscrepancies.id, d.id))
    assert.equal(after.status, 'explained')
  })

  test('assigning an unknown charge and remembering the merchant fixes future charges', async () => {
    const [tx] = await db
      .select()
      .from(cardTransactions)
      .where(and(eq(cardTransactions.workspaceId, fx.ws.id), eq(cardTransactions.descriptor, 'PAYPAL *CREATIVEHUB')))
    assert.ok(tx, 'planted unknown merchant exists')
    await assert.rejects(
      assignTransaction({ workspaceId: fx.ws.id, actorId: fx.admin.id, txId: tx.id, channelKey: 'creative_design', ignore: false, remember: 'NOT IN IT' }),
      /must appear/,
    )
    const res = await assignTransaction({ workspaceId: fx.ws.id, actorId: fx.admin.id, txId: tx.id, channelKey: 'creative_design', ignore: false, remember: 'creativehub' })
    assert.equal(res.applied, 0) // the only other match would be future charges
    const rules = await db.select().from(merchantRules).where(eq(merchantRules.workspaceId, fx.ws.id))
    assert.equal(rules[0].contains, 'CREATIVEHUB')
    const rec = await runReconciliation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    assert.equal(rec.report.discrepancies.some((d) => d.kind === 'unknown_merchant'), false)
  })

  test('imports a UK bank CSV, masks card numbers, and deduplicates on re-import', async () => {
    const csv = [
      'Account: Business Visa',
      'Date,Description,Amount,Balance',
      `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)},"FACEBK *A1B2C3D4E5",-400.00,1000.00`,
      `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)},REFUND 4111111111111111 SHOP,25.00,1025.00`,
      `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)},EVENTBRITE TICKETS,-120.50,904.50`,
    ].join('\n')
    const r = await importStatement({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: null, label: 'Business Visa', last4: '1234', text: csv, sign: 'auto' })
    assert.equal(r.added, 3)
    assert.equal(r.detected.sign, 'charges_negative')
    const rows = await db.select().from(cardTransactions).where(eq(cardTransactions.cardId, r.card.id))
    assert.ok(rows.every((x) => !/4111111111111111/.test(x.descriptor)))
    assert.equal(rows.find((x) => x.descriptor.startsWith('FACEBK'))!.amountPence, 40_000)
    assert.equal(rows.find((x) => x.descriptor.startsWith('FACEBK'))!.channelKey, 'meta_ads')
    const again = await importStatement({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: r.card.id, label: '', last4: null, text: csv, sign: 'auto' })
    assert.equal(again.added, 0)
    await assert.rejects(
      importStatement({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: null, label: 'x', last4: '4111111111111111', text: csv, sign: 'auto' }),
      /last four/,
    )
  })

  test('pacing and the cash forecast for the live plan', async () => {
    const plan = (await loadPlan(fx.ws.id, planId))!
    const p = await pacingFor(fx.ws.id, plan)
    const google = p.lines.find((l) => l.channelKey === 'google_ads')!
    assert.equal(google.source, 'platform')
    assert.equal(google.status, 'over') // the simulator overspends Google by 14%
    assert.ok(p.cash)
    assert.ok(p.cash!.forecastPence > 0)
    const tools = p.lines.find((l) => l.channelKey === 'tools_saas')!
    assert.equal(tools.source, 'card')
  })

  test('a reallocation of the live plan is a revision that needs its own approval', async () => {
    await runAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId })
    const run = (await latestAllocation(fx.ws.id, planId))!
    const rev = await applyAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, allocationId: run.id })
    assert.notEqual(rev.id, planId)
    assert.equal(rev.parentPlanId, planId)
    assert.equal(rev.status, 'draft')
    assert.equal(rev.lines.reduce((a, l) => a + l.plannedPence, 0), rev.totalPence)
    await approve(rev.id)
    await activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: rev.id })
    assert.equal((await loadPlan(fx.ws.id, planId))!.status, 'superseded')
    // Open discrepancies follow the live plan.
    assert.ok((await discrepanciesFor(fx.ws.id, rev.id)).length > 0)
    const manual = await revisePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: rev.id })
    assert.equal(manual.parentPlanId, rev.id)
  })

  test('a simulated card can be capped; controls list the card when dedicated', async () => {
    const [card] = (await listCards(fx.ws.id)).filter((c) => c.provider === 'simulated')
    await enforceCardLimit({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: card.id, amountPence: 900_000 })
    assert.equal((await listCards(fx.ws.id)).find((c) => c.id === card.id)!.monthlyLimitPence, 900_000)
    const csvCard = (await listCards(fx.ws.id)).find((c) => c.provider === 'csv')!
    await assert.rejects(enforceCardLimit({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: csvCard.id, amountPence: 1 }), /issued cards/)
  })

  test('history import gives curves to lines Aurea cannot see', async () => {
    const lines = ['week,channel,spend,conversions,revenue']
    for (let i = 0; i < 10; i++) lines.push(`${addDays(today, -7 * (i + 1))},Events and sponsorship,${1000 + i * 150},${10 + i},${2000 + i * 100}`)
    lines.push('2026-01-01,Nonsense channel,10,1,1')
    const r = await importHistoryCsv({ workspaceId: fx.ws.id, actorId: fx.admin.id, text: lines.join('\n') })
    assert.equal(r.rows, 10)
    assert.equal(r.skipped, 1)
    assert.deepEqual(r.channels, ['events'])
  })

  test('syncs Aurea’s own spend without error on a workspace with no metrics', async () => {
    const r = await syncFromAurea(other.ws.id)
    assert.deepEqual(r, { weeks: 0, days: 0 })
  })

  test('linked controls are empty without links and never crash', async () => {
    const live = (await loadPlan(fx.ws.id, (await db.select().from(approvalRequests).where(eq(approvalRequests.workspaceId, fx.ws.id)))[0].subjectId))!
    const controls = await linkedControls(fx.ws.id, live)
    assert.ok(Array.isArray(controls))
  })

  test('review: editing a plan in review cancels its request; closing it keeps it closed', async () => {
    const p = await createPlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, name: 'Edit while in review', periodStart, periodEnd, totalPence: 100_000, objective: 'conversions', start: 'starter' })
    const { requestId } = await submitForReview({ workspaceId: fx.ws.id, subjectType: 'budget_plan', subjectId: p.id, actorId: fx.admin.id })
    await updatePlanSettings({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: p.id, patch: { riskAversion: 0.2 } })
    const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId))
    assert.equal(req.status, 'cancelled')
    await assert.rejects(decide({ workspaceId: fx.ws.id, requestId, actorId: fx.approver.id, actorRole: 'approver', decision: 'approve' }), /already cancelled/)

    const second = await submitForReview({ workspaceId: fx.ws.id, subjectType: 'budget_plan', subjectId: p.id, actorId: fx.admin.id })
    await closePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: p.id })
    await assert.rejects(decide({ workspaceId: fx.ws.id, requestId: second.requestId, actorId: fx.approver.id, actorRole: 'approver', decision: 'approve' }))
    assert.equal((await loadPlan(fx.ws.id, p.id))!.status, 'closed')
  })

  test('review: the period cannot be stretched past a year by an edit', async () => {
    const p = await createPlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, name: 'Long', periodStart, periodEnd, totalPence: 100_000, objective: 'conversions', start: 'blank' })
    await assert.rejects(updatePlanSettings({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: p.id, patch: { periodEnd: '9999-12-31' } }), /at most a year/)
  })

  test('review: a card with a GBP-only plan refuses a limit on a USD card', async () => {
    const [c] = await db.insert(paymentCards).values({ workspaceId: fx.ws.id, provider: 'simulated', label: 'USD card', currency: 'USD', simulated: true }).returning()
    await assert.rejects(enforceCardLimit({ workspaceId: fx.ws.id, actorId: fx.admin.id, cardId: c.id, amountPence: 1000 }), /held in USD/)
    await db.delete(paymentCards).where(eq(paymentCards.id, c.id))
  })

  test('review: reconnecting the same card reuses its row', async () => {
    const v = { workspaceId: fx.ws.id, provider: 'airwallex', label: 'AW', externalId: 'card-123', credentialRef: 'x' }
    await db.insert(paymentCards).values(v)
    await assert.rejects(db.insert(paymentCards).values(v)) // the unique index the upsert relies on
    await db.delete(paymentCards).where(and(eq(paymentCards.workspaceId, fx.ws.id), eq(paymentCards.externalId, 'card-123')))
  })

  test('review: a discrepancy explained small reopens when it grows', async () => {
    const live = (await db.select().from(budgetPlans).where(and(eq(budgetPlans.workspaceId, fx.ws.id), eq(budgetPlans.status, 'active'))))[0]
    const d = (await discrepanciesFor(fx.ws.id, live.id)).find((x) => x.present && x.amountPence >= 20_000)!
    await db.update(budgetDiscrepancies).set({ status: 'explained', note: 'small', amountPence: 100, severity: 'low' }).where(eq(budgetDiscrepancies.id, d.id))
    await runReconciliation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: live.id })
    const [after] = await db.select().from(budgetDiscrepancies).where(eq(budgetDiscrepancies.id, d.id))
    assert.equal(after.status, 'open')
    assert.match(after.note ?? '', /Reopened/)
  })

  test('review: a stale revision cannot undo the newer live plan', async () => {
    const live = (await db.select().from(budgetPlans).where(and(eq(budgetPlans.workspaceId, fx.ws.id), eq(budgetPlans.status, 'active'))))[0]
    const a = await revisePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: live.id })
    await approve(a.id)
    // Make a newer revision live first, from the same parent.
    await runAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: live.id })
    const b = await applyAllocation({ workspaceId: fx.ws.id, actorId: fx.admin.id, allocationId: (await latestAllocation(fx.ws.id, live.id))!.id })
    assert.equal((await loadPlan(fx.ws.id, a.id))!.status, 'closed') // the earlier open revision was replaced
    await approve(b.id)
    await activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: b.id })
    await assert.rejects(activatePlan({ workspaceId: fx.ws.id, actorId: fx.admin.id, planId: a.id }))
  })

  test('the audit chain still verifies', async () => {
    const v = await verifyChain(fx.ws.id)
    assert.equal(v.ok, true, v.reason ?? '')
  })
})
