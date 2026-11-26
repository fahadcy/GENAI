/**
 * The growth agent inside Aurea, against the real database: connecting the
 * CRM (token tested, then stored encrypted), settings, the brain built from
 * what Aurea already knows, runs stored whole and metered and audited, the
 * one-run-at-a-time lock, crash recovery, the schedule, and permissions.
 * The CRM itself is a fake; the CRM's own API is tested in the CRM codebase.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { agentConnections, agentRuns, aiRuns, auditEvents, serpTwinProfiles } from '../src/lib/db/schema'
import {
  agentTick,
  AgentError,
  brainPatchFor,
  connectCrm,
  connectionView,
  getConnection,
  openQuestions,
  saveSettings,
  startRun,
} from '../src/lib/agent/service'
import { decryptToken } from '../src/lib/crypto-secrets'
import { can } from '../src/lib/auth/rbac'
import { SimulatedModel } from '../src/lib/agent/agent/simulator'
import { FakeCrm, lead } from './agent-fakes'

const TOKEN = 'cya_' + 'ab12'.repeat(10)

function crmFetch(status = 200, businesses = [{ id: 1, bkey: 'easy_liquidation', name: 'Easy Liquidation' }], scopes = ['read', 'write']) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    if (status !== 200) return new Response(JSON.stringify({ ok: false, error: 'Missing or invalid agent token' }), { status })
    return new Response(JSON.stringify({ ok: true, token: { name: 'test', scopes }, businesses }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, calls }
}

function fakeDeps(crm = new FakeCrm()) {
  return { crm, ch: null, site: null, model: new SimulatedModel(), businessId: 1, petitions: async () => [] }
}

describe('growth agent in Aurea', () => {
  let fx: Fixture
  before(async () => { fx = await createWorkspace() })
  after(async () => { await destroyWorkspace(fx) })

  test('connecting tests the token first, then stores it encrypted', async () => {
    await assert.rejects(connectCrm({ workspaceId: fx.ws.id, actorId: fx.owner.id, crmUrl: 'https://crm.example.co.uk', crmToken: 'not-a-token' }), /starts with cya_/)
    const bad = crmFetch(401)
    await assert.rejects(connectCrm({ workspaceId: fx.ws.id, actorId: fx.owner.id, crmUrl: 'https://crm.example.co.uk', crmToken: TOKEN, fetchImpl: bad.f }), /refused that token/)
    await assert.rejects(connectCrm({ workspaceId: fx.ws.id, actorId: fx.owner.id, crmUrl: 'http://crm.example.co.uk', crmToken: TOKEN }), /https/)
    assert.equal(await getConnection(fx.ws.id), null, 'nothing saved after a failed test')

    const ok = crmFetch()
    const r = await connectCrm({ workspaceId: fx.ws.id, actorId: fx.owner.id, crmUrl: 'crm.example.co.uk/agent_api.php', crmToken: TOKEN, fetchImpl: ok.f })
    assert.deepEqual(r.businesses, [{ id: 1, name: 'Easy Liquidation' }])
    assert.equal(ok.calls[0]!.url, 'https://crm.example.co.uk/agent_api.php')
    assert.equal(ok.calls[0]!.headers.Authorization, `Bearer ${TOKEN}`)
    const c = (await getConnection(fx.ws.id))!
    assert.equal(c.crmBusinessId, 1, 'a single business is chosen automatically')
    assert.ok(!c.crmTokenEnc!.includes(TOKEN.slice(4, 20)), 'token is not stored in clear')
    assert.equal(decryptToken(c.crmTokenEnc!), TOKEN)
    const v = (await connectionView(fx.ws.id))!
    assert.ok(!JSON.stringify(v).includes(TOKEN.slice(4)), 'the screen never gets the token')
    assert.ok(v.crmTokenHint)
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, fx.ws.id), eq(auditEvents.action, 'agent.crm_connected')))
    assert.ok(audit, 'connection is on the audit trail')
    assert.ok(!JSON.stringify(audit).includes(TOKEN.slice(4)), 'audit never holds the token')
  })

  test('settings are cleaned; answers become owner facts and close questions', async () => {
    const before = await openQuestions(fx.ws.id)
    await saveSettings({
      workspaceId: fx.ws.id, actorId: fx.owner.id,
      targets: { sicCodes: ['41100', 'abc', '41100', '43999'], locations: [' Stoke-on-Trent ', ''], excludedSections: ['k', 'zz'] },
      answers: { idealCustomer: 'Construction firms in the Midlands with HMRC arrears', capacityPerMonth: '12', bogus: 'x' } as Record<string, string>,
    })
    const c = (await getConnection(fx.ws.id))!
    assert.deepEqual(c.targets.sicCodes, ['41100', '43999'])
    assert.deepEqual(c.targets.locations, ['Stoke-on-Trent'])
    assert.deepEqual(c.targets.excludedSections, ['K'])
    assert.equal(c.answers.bogus, undefined)
    const patch = await brainPatchFor(fx.ws.id, c)
    assert.equal(patch.idealCustomer?.source, 'owner')
    assert.equal(patch.capacityPerMonth?.value, 12)
    assert.deepEqual(patch.targets?.value.sicCodes, ['41100', '43999'])
    const afterQ = await openQuestions(fx.ws.id)
    assert.ok(afterQ.length < before.length, 'answered questions are no longer asked')
    assert.ok(!afterQ.some((q) => q.field === 'idealCustomer' || q.field === 'targets'))
  })

  test('services and capacity come from the PPC & SEO business setup', async () => {
    await db.insert(serpTwinProfiles).values({ workspaceId: fx.ws.id, profile: { services: [{ id: 's1', name: 'Creditors\' voluntary liquidation', keywords: [], adGroupIds: [], marginPerCustomer: 900, weeklyCapacity: 3, bookedThisWeek: 0, landingPages: ['https://www.easyliquidation.co.uk/company-liquidate'], growthPriority: 'grow' }], serviceAreas: [], notOffered: [], followUpSlaHours: 4, unreachableAfterAttempts: 3, maxWeeklyBudgetChange: 0.2 } as never })
    const c = (await getConnection(fx.ws.id))!
    await saveSettings({ workspaceId: fx.ws.id, actorId: fx.owner.id, answers: { capacityPerMonth: '' } })
    const patch = await brainPatchFor(fx.ws.id, (await getConnection(fx.ws.id))!)
    assert.equal(patch.services?.value[0]?.name, 'Creditors\' voluntary liquidation')
    assert.equal(patch.capacityPerMonth?.value, 13)   // 3 a week × 4.33
    void c
  })

  test('a run is stored whole, metered and audited', async () => {
    const crm = new FakeCrm()
    crm.snapshot = { business_id: 1, days: 90, stages: [{ key: 'contacted', name: 'Contacted', is_won: false, is_lost: false, count: 9, value: 0, stale_14d: 6 }],
      by_channel: [], won: { count: 0, median_days_to_win: null }, weekly_new_leads: [], overdue_tasks: 0, unassigned_open_leads: 0, generated_at: '' }
    crm.leads = [lead({ id: 7, stage: 'contacted', stage_id: 2, stage_entered_at: '2026-01-01 09:00:00', channel: 'website', found_by_agent: false })]
    const run = await startRun({ workspaceId: fx.ws.id, goal: 'daily_brief', actorId: fx.creator.id, trigger: 'manual', deps: fakeDeps(crm) })
    assert.equal(run.status, 'done')
    assert.equal(run.simulated, true)
    assert.ok(run.report!.includes('6 of 9 leads in Contacted'))
    assert.ok(run.steps.some((s) => s.tool === 'pipeline_insights'))
    assert.ok(run.evidence.length > 0)
    assert.deepEqual(crm.tasks.map((t) => t.leadId), [7])
    assert.deepEqual(run.dropped, [])
    const [meter] = await db.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, fx.ws.id), eq(aiRuns.subjectId, run.id)))
    assert.equal(meter?.agent, 'growth.daily_brief')
    assert.equal(meter?.provider, 'simulator')
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, fx.ws.id), eq(auditEvents.subjectId, run.id)))
    assert.equal(audit?.action, 'agent.run_completed')
  })

  test('one run at a time; a crashed run is recovered', async () => {
    const [stuck] = await db.insert(agentRuns).values({ workspaceId: fx.ws.id, goal: 'find_leads', trigger: 'manual', status: 'running' }).returning()
    await assert.rejects(startRun({ workspaceId: fx.ws.id, goal: 'daily_brief', actorId: fx.owner.id, trigger: 'manual', deps: fakeDeps() }), (e: unknown) => e instanceof AgentError && /already working on "Find leads"/.test(e.message))
    await db.update(agentRuns).set({ startedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(agentRuns.id, stuck!.id))
    const ok = await startRun({ workspaceId: fx.ws.id, goal: 'ask', question: 'What needs my attention?', actorId: fx.owner.id, trigger: 'chat', deps: fakeDeps() })
    assert.equal(ok.status, 'done')
    assert.equal(ok.question, 'What needs my attention?')
    const [recovered] = await db.select().from(agentRuns).where(eq(agentRuns.id, stuck!.id))
    assert.equal(recovered!.status, 'failed')
  })

  test('a CRM failure mid-run is recorded, not thrown', async () => {
    const crm = new FakeCrm()
    crm.pipelineSnapshot = async () => { throw new Error('CRM down') }
    const run = await startRun({ workspaceId: fx.ws.id, goal: 'daily_brief', actorId: null, trigger: 'manual', deps: fakeDeps(crm) })
    assert.equal(run.status, 'done')
    assert.ok(run.steps.some((s) => !s.ok && /CRM down/.test(s.summary)))
  })

  test('schedule: UK times, weekdays, once a day, outreach only with the scope', async () => {
    await saveSettings({ workspaceId: fx.ws.id, actorId: fx.owner.id, schedule: { dailyBrief: true, findLeads: true, outreach: true } })
    const tue0730 = new Date('2026-11-10T07:30:00Z')   // GMT: 07:30 UK
    assert.deepEqual(await agentTick(fx.ws.id, tue0730, fakeDeps()), [])
    const tue0745 = new Date('2026-11-10T07:45:00Z')
    assert.deepEqual(await agentTick(fx.ws.id, tue0745, fakeDeps()), ['daily_brief:done'])
    assert.deepEqual(await agentTick(fx.ws.id, new Date('2026-11-10T08:05:00Z'), fakeDeps()), [], 'not twice in a day')
    const thu0915 = new Date('2026-11-12T09:15:00Z')
    const thu = await agentTick(fx.ws.id, thu0915, fakeDeps())
    assert.deepEqual(thu, ['daily_brief:done', 'find_leads:done'])
    const r = await agentTick(fx.ws.id, new Date('2026-11-12T09:45:00Z'), fakeDeps())
    assert.ok(!r.some((x) => x.startsWith('outreach')), 'no outreach without the CRM outreach scope')
    assert.deepEqual(await agentTick(fx.ws.id, new Date('2026-11-14T09:45:00Z'), fakeDeps()), [], 'weekends off')
    const scheduled = await db.select().from(agentRuns).where(and(eq(agentRuns.workspaceId, fx.ws.id), eq(agentRuns.trigger, 'schedule')))
    assert.equal(scheduled.length, 3)
  })

  test('permissions', () => {
    assert.ok(can('strategist', 'agent:run'))
    assert.ok(!can('strategist', 'agent:outreach'))
    assert.ok(!can('strategist', 'agent:configure'))
    assert.ok(can('admin', 'agent:outreach') && can('admin', 'agent:configure'))
    assert.ok(!can('creator', 'agent:run'))
    assert.ok(!can('approver', 'agent:run'))
    assert.ok(!can('analyst', 'agent:run'))
  })

  test('the connection row disappears with the workspace', async () => {
    const other = await createWorkspace()
    await db.insert(agentConnections).values({ workspaceId: other.ws.id, crmUrl: 'https://x.example' })
    await destroyWorkspace(other)
    assert.equal((await db.select().from(agentConnections).where(eq(agentConnections.workspaceId, other.ws.id))).length, 0)
  })
})
