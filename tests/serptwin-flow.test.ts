/**
 * PPC & SEO — the governed loop, end to end against a real database.
 *
 * Analyse → send a recommendation for approval → refused apply while pending →
 * approve → apply (recorded as simulated, with its undo) → refused second
 * apply → revert. Then the audit chain must still verify, and a tampered
 * report must be refused before anything can be submitted from it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { auditEvents, serpTwinActions, serpTwinRuns } from '../src/lib/db/schema'
import { decide, pendingQueue } from '../src/lib/workflow/approvals'
import { loadSubject } from '../src/lib/workflow/subjects'
import { verifyChain } from '../src/lib/workflow/audit'
import { can } from '../src/lib/auth/rbac'
import {
  applyAction,
  ensureAction,
  hashReport,
  loadLeadRows,
  loadProfile,
  offlineConversionsCsv,
  revertAction,
  saveProfile,
  updateLeadOutcome,
  runAnalysis,
  submitRecommendation,
} from '../src/lib/search/service'
import { briefHref } from '../src/lib/search/brief'

let f: Fixture

test.before(async () => {
  f = await createWorkspace()
})
test.after(async () => {
  await destroyWorkspace(f)
})

test('permissions: growth marketers analyse, only owners and marketing ops apply', () => {
  assert.equal(can('strategist', 'search:analyse'), true)
  assert.equal(can('strategist', 'search:apply'), false)
  assert.equal(can('admin', 'search:apply'), true)
  assert.equal(can('owner', 'search:apply'), true)
  assert.equal(can('creator', 'search:analyse'), false)
  assert.equal(can('analyst', 'search:analyse'), false)
})

test('the governed loop: analyse, approve, apply, revert', async () => {
  const run = await runAnalysis({ workspaceId: f.ws.id, actorId: f.owner.id })
  assert.equal(run.source, 'simulated')
  assert.equal(run.reportHash, hashReport(run.report))
  assert.ok(run.recommendationCount > 5)

  // Pick a recommendation that touches money: the intent-drift negatives.
  const rec = run.report.recommendations.find((r) => r.engine === 'drift')!
  assert.ok(rec, 'expected a drift recommendation in the simulated account')

  const submitted = await submitRecommendation({
    workspaceId: f.ws.id,
    runId: run.id,
    recommendationId: rec.id,
    actorId: f.admin.id,
  })

  // The approval subject reports the money at stake so spend-threshold chains apply.
  const subject = await loadSubject('search_action', f.ws.id, submitted.actionId)
  assert.equal(subject?.status, 'in_review')
  assert.equal(subject?.channel, 'google_ads')
  assert.ok((subject?.spend ?? 0) > 0)

  // It shows up in the approvals queue under its own title, not "Untitled".
  const queue = await pendingQueue(f.ws.id)
  const item = queue.find((q) => q.request.id === submitted.requestId)
  assert.equal(item?.display.title, rec.title)
  assert.equal(item?.display.href, `/search/actions/${submitted.actionId}`)

  // Cannot be applied while waiting.
  await assert.rejects(
    applyAction({ workspaceId: f.ws.id, actionId: submitted.actionId, actorId: f.admin.id }),
    /not been approved/,
  )

  const decision = await decide({
    workspaceId: f.ws.id,
    requestId: submitted.requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'approve',
  })
  assert.equal(decision.status, 'approved')

  const applied = await applyAction({
    workspaceId: f.ws.id,
    actionId: submitted.actionId,
    actorId: f.admin.id,
  })
  assert.equal(applied.simulated, true)
  const [row] = await db.select().from(serpTwinActions).where(eq(serpTwinActions.id, submitted.actionId))
  assert.equal(row.status, 'applied')

  // The undo is in the audit payload, captured at apply time.
  const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, submitted.actionId))
  const applyEvent = events.find((e) => e.action === 'search.applied')!
  assert.ok(applyEvent.summary.startsWith('Simulated:'))
  const undo = (applyEvent.payload as { undo: unknown[] }).undo
  assert.ok(Array.isArray(undo) && undo.length > 0 && undo.every(Boolean))

  await assert.rejects(
    applyAction({ workspaceId: f.ws.id, actionId: submitted.actionId, actorId: f.admin.id }),
    /already been applied/,
  )

  await revertAction({ workspaceId: f.ws.id, actionId: submitted.actionId, actorId: f.admin.id })
  const [reverted] = await db.select().from(serpTwinActions).where(eq(serpTwinActions.id, submitted.actionId))
  assert.equal(reverted.status, 'reverted')

  const chain = await verifyChain(f.ws.id)
  assert.equal(chain.ok, true, chain.reason ?? '')
})

test('a recommendation that changes nothing live cannot be sent for approval', async () => {
  const run = await runAnalysis({ workspaceId: f.ws.id, actorId: f.owner.id })
  const briefOnly = run.report.recommendations.find((r) => r.actions.every((a) => !a.requiresApproval))!
  await assert.rejects(
    submitRecommendation({
      workspaceId: f.ws.id,
      runId: run.id,
      recommendationId: briefOnly.id,
      actorId: f.admin.id,
    }),
    /does not need approval/,
  )
  const gap = run.report.recommendations.find((r) =>
    r.actions.some((a) => a.kind === 'create_content_brief'),
  )!
  assert.match(briefHref(gap)!, /^\/studio\/new\?title=/)
})

test('a tampered report is refused before anything is submitted from it', async () => {
  const run = await runAnalysis({ workspaceId: f.ws.id, actorId: f.owner.id })
  const report = structuredClone(run.report)
  report.recommendations[0].monthlyImpact = 999_999
  await db.update(serpTwinRuns).set({ report }).where(eq(serpTwinRuns.id, run.id))
  await assert.rejects(
    ensureAction({
      workspaceId: f.ws.id,
      runId: run.id,
      recommendationId: report.recommendations[0].id,
      actorId: f.admin.id,
    }),
    /no longer matches its hash/,
  )
  const created = await db.select().from(serpTwinActions).where(eq(serpTwinActions.runId, run.id))
  assert.equal(created.length, 0)
})

test('business setup and sales outcomes feed the next analysis', async () => {
  const first = await runAnalysis({ workspaceId: f.ws.id, actorId: f.owner.id })
  const profile = await loadProfile(f.ws.id)
  assert.ok(profile, 'the first run stores the example setup')
  const rows = await loadLeadRows(f.ws.id)
  assert.equal(rows.length, first.report.leads!.total)

  // Implementation frees up: the engine stops easing off it for being booked out.
  const before = first.report.budgets!.find((p) => p.serviceId === 'implementation')!
  assert.equal(before.decision, 'reduce')
  profile!.services.find((s) => s.id === 'implementation')!.bookedThisWeek = 0
  await saveProfile({ workspaceId: f.ws.id, profile: profile!, actorId: f.admin.id })

  // Sales closes an open enquiry.
  const open = rows.find((r) => r.outcome === 'open' && r.source === 'ppc' && r.gclid)!
  await updateLeadOutcome({ workspaceId: f.ws.id, leadId: open.id, actorId: f.admin.id, outcome: 'won', value: 1400 })

  const second = await runAnalysis({ workspaceId: f.ws.id, actorId: f.owner.id })
  const after = second.report.budgets!.find((p) => p.serviceId === 'implementation')!
  assert.doesNotMatch(after.reason, /Fully booked/)
  assert.equal(second.report.leads!.counts.won, first.report.leads!.counts.won + 1)
  assert.ok(second.report.leads!.offlineRows.some((r) => r.gclid === open.gclid && r.conversionName === 'Customer'))

  const csv = offlineConversionsCsv(second.report).split('\n')
  assert.equal(csv[0], 'Parameters:TimeZone=Europe/London')
  assert.equal(csv.length, 2 + second.report.leads!.offlineRows.length)
  assert.match(csv[2]!, /^sim-[^,]+,(Qualified enquiry|Customer),\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+\.\d{2},GBP$/)

  // No personal data goes into the audit trail with an outcome change.
  const ev = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, open.id))
  assert.equal(ev.length, 1)
  assert.doesNotMatch(ev[0]!.summary, /@|07700/)
  const chain = await verifyChain(f.ws.id)
  assert.equal(chain.ok, true, chain.reason ?? '')
})
