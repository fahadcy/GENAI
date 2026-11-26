/**
 * Competitor intelligence end to end, against the database, with no keys:
 * discovery falls back to the simulated market, scans read simulated
 * evidence, the landscape is built and hashed, the generators get their
 * context, and the guardrail flags a named competitor. Nothing here touches
 * the network — simulated domains are on `.example`, which the reader refuses.
 */
// Must come first: it pins a keyless environment before helpers loads .env.local.
import './no-keys'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { competitors, competitorScans, notifications } from '../src/lib/db/schema'
import {
  addCompetitorManually,
  buildLandscapeFor,
  competitorContextFor,
  competitorContextSummary,
  CompetitorError,
  latestLandscape,
  latestScan,
  listCompetitors,
  loadProfile,
  refreshDue,
  runDiscovery,
  saveProfile,
  scanCompetitor,
  scanSelf,
  setCompetitorStatus,
  sha256,
} from '../src/lib/competitors/service'
import { verifyChain } from '../src/lib/workflow/audit'
import { scoreAsset } from '../src/lib/ai/guardrails'
import type { CompanyProfile } from '../src/lib/competitors/types'

let fx: Fixture

const PROFILE: CompanyProfile = {
  companyName: 'Flow Test Insolvency Ltd',
  companyNumber: null,
  sicCodes: ['70221'],
  domain: null,
  postcode: 'M2 3AW',
  locality: 'Manchester',
  lat: 53.479,
  lng: -2.245,
  businessType: 'insolvency practitioner',
  keywords: ['insolvency practitioner', 'company liquidation', 'business recovery'],
  scope: 'hybrid',
  confidence: 0.8,
  radiusKm: 25,
  source: 'manual',
}

before(async () => {
  fx = await createWorkspace()
})
after(async () => {
  await destroyWorkspace(fx)
})

describe('competitor flow (simulated)', () => {
  test('refuses to discover before a profile exists', async () => {
    await assert.rejects(runDiscovery({ workspaceId: fx.ws.id, actorId: fx.owner.id }), CompetitorError)
  })

  test('profile is stored', async () => {
    await saveProfile({ workspaceId: fx.ws.id, actorId: fx.owner.id, profile: PROFILE })
    const p = await loadProfile(fx.ws.id)
    assert.equal(p?.businessType, 'insolvency practitioner')
  })

  test('first discovery finds a simulated market and tracks the top five', async () => {
    const r = await runDiscovery({ workspaceId: fx.ws.id, actorId: fx.owner.id })
    assert.equal(r.simulated, true)
    assert.equal(r.tracked, 5)
    const all = await listCompetitors(fx.ws.id)
    assert.ok(all.length >= 6)
    assert.equal(all.filter((c) => c.status === 'tracked').length, 5)
    assert.ok(all.every((c) => c.simulated))
    assert.ok(all.every((c) => c.domain?.endsWith('.example')))
  })

  test('a second discovery adds nothing new and keeps decisions', async () => {
    const before = await listCompetitors(fx.ws.id)
    const victim = before.find((c) => c.status === 'suggested')!
    await setCompetitorStatus({ workspaceId: fx.ws.id, actorId: fx.owner.id, id: victim.id, status: 'dismissed' })
    const r = await runDiscovery({ workspaceId: fx.ws.id, actorId: fx.owner.id })
    assert.equal(r.added, 0)
    assert.equal(r.tracked, 0)
    const again = await listCompetitors(fx.ws.id)
    assert.equal(again.find((c) => c.id === victim.id)?.status, 'dismissed')
    assert.equal(again.filter((c) => c.status === 'tracked').length, 5)
  })

  test('scans store evidence, an analysis and a verifiable hash', async () => {
    await scanSelf({ workspaceId: fx.ws.id, actorId: fx.owner.id })
    const tracked = (await listCompetitors(fx.ws.id)).filter((c) => c.status === 'tracked')
    for (const c of tracked) await scanCompetitor({ workspaceId: fx.ws.id, actorId: fx.owner.id, competitorId: c.id })
    const s = await latestScan(fx.ws.id, tracked[0].id)
    assert.ok(s)
    assert.equal(s!.simulated, true)
    assert.equal(s!.snapshotHash, sha256(s!.snapshot))
    assert.ok(s!.analysis)
    assert.ok(s!.analysis!.advantage.text.length > 5)
    assert.ok(s!.analysis!.threat.score >= 0 && s!.analysis!.threat.score <= 100)
    const row = (await listCompetitors(fx.ws.id)).find((c) => c.id === tracked[0].id)!
    assert.ok(row.lastScannedAt)
    assert.equal(row.threatScore, s!.analysis!.threat.score)
  })

  test('the landscape is built, hashed, and produces plays', async () => {
    const l = await buildLandscapeFor({ workspaceId: fx.ws.id, actorId: fx.owner.id })
    assert.equal(l.reportHash, sha256(l.report))
    assert.equal(l.report.competitorIds.length, 5)
    assert.ok(l.report.summary.length > 10)
    assert.ok(l.report.plays.length > 0)
    assert.equal((await latestLandscape(fx.ws.id))?.id, l.id)
  })

  test('generators get context that never names a competitor', async () => {
    const ctx = await competitorContextFor(fx.ws.id)
    assert.ok(ctx)
    const names = (await listCompetitors(fx.ws.id)).filter((c) => c.status === 'tracked').map((c) => c.name)
    for (const n of names) assert.ok(!ctx!.text.includes(n), n)
    assert.ok(ctx!.brandNames.some((b) => names.includes(b)))
    const summary = await competitorContextSummary(fx.ws.id)
    assert.equal(summary?.competitors, 5)
  })

  test('the guardrail flags copy that names a tracked competitor', async () => {
    const ctx = (await competitorContextFor(fx.ws.id))!
    const rival = ctx.brandNames[0]
    const detail = scoreAsset({
      body: { body: `Unlike ${rival}, we are the best in Manchester.` },
      channel: 'linkedin',
      profile: fx.profile,
      legalRules: [],
      competitorNames: ctx.brandNames,
    })
    const ids = detail.compliance.findings.map((f) => f.ruleId)
    assert.ok(ids.some((i) => i.startsWith('competitor:') && i !== 'competitor:comparative'))
    assert.ok(ids.includes('competitor:comparative'))
    const clean = scoreAsset({
      body: { body: 'A fixed fee agreed before we start, and one adviser from start to finish.' },
      channel: 'linkedin',
      profile: fx.profile,
      legalRules: [],
      competitorNames: ctx.brandNames,
    })
    assert.ok(!clean.compliance.findings.some((f) => f.ruleId.startsWith('competitor:')))
    // Without competitor names the check is off, so existing scores are unchanged.
    const off = scoreAsset({ body: { body: `Unlike ${rival}, we are the best.` }, channel: 'linkedin', profile: fx.profile, legalRules: [] })
    assert.ok(!off.compliance.findings.some((f) => f.ruleId.startsWith('competitor:')))
  })

  test('a rescan with nothing new reports no changes and notifies nobody', async () => {
    const c = (await listCompetitors(fx.ws.id)).find((x) => x.status === 'tracked')!
    const s = await scanCompetitor({ workspaceId: fx.ws.id, actorId: fx.owner.id, competitorId: c.id })
    assert.deepEqual(s.changes, [])
    const n = await db.select().from(notifications).where(and(eq(notifications.workspaceId, fx.ws.id), eq(notifications.type, 'competitor.changed')))
    assert.equal(n.length, 0)
  })

  test('a competitor added by address is tracked; an unreachable site fails alone', async () => {
    const c = await addCompetitorManually({ workspaceId: fx.ws.id, actorId: fx.owner.id, name: 'Rival Ltd', domain: 'https://www.rival.example/' })
    assert.equal(c.status, 'tracked')
    assert.equal(c.domain, 'rival.example')
    const s = await scanCompetitor({ workspaceId: fx.ws.id, actorId: fx.owner.id, competitorId: c.id })
    const web = s.snapshot.sources.find((x) => x.source === 'website')
    // Refused by the address check before any request is made.
    assert.equal(web?.status, 'error')
    assert.match(web?.note ?? '', /public host/)
    assert.ok(s.analysis, 'still analysed, from what little there is')
    await assert.rejects(
      addCompetitorManually({ workspaceId: fx.ws.id, actorId: fx.owner.id, name: 'Bad', domain: 'not a domain' }),
      CompetitorError,
    )
  })

  test('the worker rescans only what is due, then rebuilds the landscape', async () => {
    assert.equal(await refreshDue(fx.ws.id, 2), 0)
    const [one] = (await listCompetitors(fx.ws.id)).filter((c) => c.status === 'tracked')
    await db.update(competitors).set({ lastScannedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(competitors.id, one.id))
    const before = await latestLandscape(fx.ws.id)
    assert.equal(await refreshDue(fx.ws.id, 2), 1)
    const after = await latestLandscape(fx.ws.id)
    assert.notEqual(after?.id, before?.id)
  })

  test('tenant isolation: another workspace sees nothing', async () => {
    const other = await createWorkspace()
    try {
      assert.equal((await listCompetitors(other.ws.id)).length, 0)
      assert.equal(await competitorContextFor(other.ws.id), null)
      const c = (await listCompetitors(fx.ws.id))[0]
      await assert.rejects(
        setCompetitorStatus({ workspaceId: other.ws.id, actorId: other.owner.id, id: c.id, status: 'dismissed' }),
        CompetitorError,
      )
      const scans = await db.select().from(competitorScans).where(eq(competitorScans.workspaceId, other.ws.id))
      assert.equal(scans.length, 0)
    } finally {
      await destroyWorkspace(other)
    }
  })

  test('every step left an intact audit trail', async () => {
    const v = await verifyChain(fx.ws.id)
    assert.equal(v.ok, true)
  })
})
