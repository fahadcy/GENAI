/**
 * End-to-end pipeline tests: Generate → Review → Approve → Publish → Monitor.
 *
 * These assert the PRD's stated acceptance criteria against the real engine —
 * no mocks, no fixtures pre-set to the answer. Where the PRD says "nothing
 * publishes without passing its gate", there is a test that tries to publish
 * something that has not passed and asserts it is refused.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import {
  assets,
  assetVersions,
  approvalRequests,
  contacts,
  scheduleItems,
  segments,
  type AssetBody,
} from '../src/lib/db/schema'
import { scoreAsset } from '../src/lib/ai/guardrails'
import {
  assertPublishable,
  decide,
  GateError,
  matchChain,
  submitAssetForReview,
} from '../src/lib/workflow/approvals'
import { scheduleAsset } from '../src/lib/scheduler/schedule'
import { publishOne } from '../src/lib/scheduler/publish'
import { evaluateRules, refreshSegment } from '../src/lib/targeting/engine'
import { verifyChain } from '../src/lib/workflow/audit'

const fixtures: Fixture[] = []
async function fresh(opts?: Parameters<typeof createWorkspace>[0]) {
  const f = await createWorkspace(opts)
  fixtures.push(f)
  return f
}

after(async () => {
  for (const f of fixtures) await destroyWorkspace(f)
  await db.$client.end()
})

/* ------------------------------------------------------------- utilities */

async function makeAsset(
  f: Fixture,
  body: AssetBody,
  channel: 'email' | 'linkedin' | 'google_ads' = 'email',
) {
  const rules = [f.rule]
  const detail = scoreAsset({ body, channel, profile: f.profile, legalRules: rules })
  const [asset] = await db
    .insert(assets)
    .values({
      workspaceId: f.ws.id,
      channel,
      title: body.subject ?? body.headline ?? 'Untitled',
      body,
      brandScore: detail.brand.score,
      complianceScore: detail.compliance.score,
      compositeScore: detail.composite,
      scoreDetail: detail,
      createdBy: f.creator.id,
    })
    .returning()
  await db.insert(assetVersions).values({
    assetId: asset.id,
    version: 1,
    body,
    scoreDetail: detail,
    createdBy: f.creator.id,
  })
  return asset
}

/** A segment with contacts who have consented to email and are not suppressed. */
async function makeReachableSegment(f: Fixture): Promise<string> {
  await db.insert(contacts).values(
    ['r1', 'r2', 'r3'].map((k) => ({
      workspaceId: f.ws.id,
      email: `${k}-${f.ws.id.slice(0, 8)}@test.invalid`,
      name: k,
      lifecycleStage: 'lead',
      engagementScore: 70,
      engagementHour: 10,
      consent: {
        email: true,
        sms: false,
        push: false,
        ads: false,
        capturedAt: new Date().toISOString(),
        basis: 'consent',
      },
    })),
  )
  const [seg] = await db
    .insert(segments)
    .values({
      workspaceId: f.ws.id,
      name: 'Reachable leads',
      rules: { combinator: 'and', rules: [{ field: 'lifecycleStage', op: 'eq', value: 'lead' }] },
      syncTargets: ['email'],
    })
    .returning()
  await refreshSegment(f.ws.id, seg.id)
  return seg.id
}

const cleanBody: AssetBody = {
  subject: 'A specific, checkable claim',
  preheader: 'Two minutes to see how it works.',
  body: 'Most teams lose time between the steps, not inside them. Here is what changed when we joined them up.',
  cta: 'Book a walkthrough',
}

/* --------------------------------------------------------- the happy path */

test('an asset travels brief → review → approved → scheduled → published', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)

  assert.equal(asset.status, 'draft')
  assert.equal(asset.scoreDetail?.passed, true, 'clean copy should clear the guardrails')

  /* Review */
  const submission = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })
  const [afterSubmit] = await db.select().from(assets).where(eq(assets.id, asset.id))
  assert.equal(afterSubmit.status, 'in_review')
  assert.equal(afterSubmit.stage, 'review')

  /* Approve */
  const decision = await decide({
    workspaceId: f.ws.id,
    requestId: submission.requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'approve',
  })
  assert.equal(decision.status, 'approved')

  const [approved] = await db.select().from(assets).where(eq(assets.id, asset.id))
  assert.equal(approved.status, 'approved')

  /* Resolution time is measured, not estimated — this is the CC-2 KPI. */
  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, submission.requestId))
  assert.equal(req.status, 'approved')
  assert.ok(typeof req.resolutionMs === 'number' && req.resolutionMs >= 0)

  /* Publish — an addressed channel needs a real, reachable audience. */
  const segmentId = await makeReachableSegment(f)
  const placed = await scheduleAsset({
    workspaceId: f.ws.id,
    actorId: f.owner.id,
    assetId: asset.id,
    segmentId,
    scheduledAt: new Date(Date.now() - 60_000), // already due
  })
  const outcome = await publishOne(f.ws.id, placed.id)
  assert.equal(outcome.status, 'published', outcome.message)

  const [published] = await db.select().from(assets).where(eq(assets.id, asset.id))
  assert.equal(published.status, 'published')
  assert.equal(published.stage, 'monitor', 'a published asset moves into the monitor stage')

  /* The whole journey is on an intact, verifiable trail. */
  const chain = await verifyChain(f.ws.id)
  assert.equal(chain.ok, true, chain.reason ?? '')
  assert.ok(chain.checked >= 4, 'each stage transition should be recorded')
})

/* ------------------------------------------------------------- the gates */

test('a blocking guardrail finding prevents submission entirely', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, {
    subject: 'Results guaranteed',
    body: 'We guarantee this will work for you.',
  })
  assert.equal(asset.scoreDetail?.passed, false)

  await assert.rejects(
    () => submitAssetForReview({ workspaceId: f.ws.id, assetId: asset.id, actorId: f.creator.id }),
    (e: unknown) => e instanceof GateError && /guarantee/i.test((e as Error).message),
    'a high-severity finding must block submission, not merely lower the score',
  )
})

test('an unapproved asset cannot be scheduled (SC-3)', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody, 'linkedin')

  await assert.rejects(
    () =>
      scheduleAsset({
        workspaceId: f.ws.id,
        actorId: f.owner.id,
        assetId: asset.id,
        scheduledAt: new Date(Date.now() + 86_400_000),
      }),
    (e: unknown) => e instanceof GateError,
  )
})

test('force cannot override the approval gate, only soft conflicts', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody, 'linkedin')

  await assert.rejects(
    () =>
      scheduleAsset({
        workspaceId: f.ws.id,
        actorId: f.owner.id,
        assetId: asset.id,
        scheduledAt: new Date(Date.now() + 86_400_000),
        force: true,
      }),
    (e: unknown) => e instanceof GateError,
    'force must never bypass approval',
  )
})

test('rejection requires a comment (AP-2)', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })

  await assert.rejects(
    () =>
      decide({
        workspaceId: f.ws.id,
        requestId,
        actorId: f.approver.id,
        actorRole: 'approver',
        decision: 'reject',
      }),
    (e: unknown) => e instanceof GateError && /comment is required/i.test((e as Error).message),
  )
})

test('a rejected asset returns to the author and cannot publish', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })

  const result = await decide({
    workspaceId: f.ws.id,
    requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'reject',
    comment: 'The second paragraph overstates the claim.',
  })
  assert.equal(result.status, 'rejected')

  const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
  assert.equal(row.status, 'changes_requested')
  await assert.rejects(() => assertPublishable(f.ws.id, asset.id), (e) => e instanceof GateError)
})

test('a reviewer without the step role cannot decide', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })

  await assert.rejects(
    () =>
      decide({
        workspaceId: f.ws.id,
        requestId,
        actorId: f.creator.id,
        actorRole: 'creator',
        decision: 'approve',
      }),
    (e: unknown) => e instanceof GateError && /not an eligible approver/i.test((e as Error).message),
  )
})

/* -------------------------------------------------- version drift (AP-3) */

test('editing an approved asset voids its approval', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })
  await decide({
    workspaceId: f.ws.id,
    requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'approve',
  })

  await assert.doesNotReject(() => assertPublishable(f.ws.id, asset.id))

  // Simulate an edit landing after approval: the version moves on.
  await db.update(assets).set({ version: 2 }).where(eq(assets.id, asset.id))

  await assert.rejects(
    () => assertPublishable(f.ws.id, asset.id),
    (e: unknown) => e instanceof GateError && /edited after approval/i.test((e as Error).message),
    'the approved version must be the version that publishes',
  )
})

test('the publisher re-checks the gate at send time, not only at schedule time', async () => {
  const f = await fresh()
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })
  await decide({
    workspaceId: f.ws.id,
    requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'approve',
  })

  const placed = await scheduleAsset({
    workspaceId: f.ws.id,
    actorId: f.owner.id,
    assetId: asset.id,
    segmentId: await makeReachableSegment(f),
    scheduledAt: new Date(Date.now() - 60_000),
  })

  // Between scheduling and sending, someone edits the asset.
  await db.update(assets).set({ version: 3 }).where(eq(assets.id, asset.id))

  const outcome = await publishOne(f.ws.id, placed.id)
  assert.equal(outcome.status, 'blocked', 'the send-time re-check must catch post-approval drift')

  const [item] = await db.select().from(scheduleItems).where(eq(scheduleItems.id, placed.id))
  assert.equal(item.status, 'cancelled')
})

/* ------------------------------------------------------ multi-step chains */

test('a two-step chain does not approve until both steps pass', async () => {
  const f = await fresh({
    chainSteps: [
      { name: 'Legal review', role: 'approver', mode: 'any', slaHours: 12 },
      { name: 'Ops sign-off', role: 'admin', mode: 'any', slaHours: 6 },
    ],
  })
  const asset = await makeAsset(f, cleanBody)
  const { requestId } = await submitAssetForReview({
    workspaceId: f.ws.id,
    assetId: asset.id,
    actorId: f.creator.id,
  })

  const first = await decide({
    workspaceId: f.ws.id,
    requestId,
    actorId: f.approver.id,
    actorRole: 'approver',
    decision: 'approve',
  })
  assert.equal(first.status, 'pending', 'step 1 of 2 must not complete the approval')
  assert.equal(first.nextStep, 'Ops sign-off')

  const [midway] = await db.select().from(assets).where(eq(assets.id, asset.id))
  assert.equal(midway.status, 'in_review', 'the asset stays in review between steps')

  const second = await decide({
    workspaceId: f.ws.id,
    requestId,
    actorId: f.admin.id,
    actorRole: 'admin',
    decision: 'approve',
  })
  assert.equal(second.status, 'approved')
})

test('chain matching prefers the more specific chain', async () => {
  const f = await fresh()
  const { approvalChains } = await import('../src/lib/db/schema')
  await db.insert(approvalChains).values({
    workspaceId: f.ws.id,
    name: 'Paid media',
    scope: { channels: ['google_ads'] },
    steps: [{ name: 'Legal review', role: 'approver', mode: 'any', slaHours: 12 }],
    priority: 10,
  })

  const paid = await matchChain(f.ws.id, { channel: 'google_ads', subjectType: 'asset' })
  assert.equal(paid?.name, 'Paid media')

  const owned = await matchChain(f.ws.id, { channel: 'email', subjectType: 'asset' })
  assert.equal(owned?.name, 'Test chain', 'an unmatched channel falls back to the default chain')
})

/* -------------------------------------------------- consent + suppression */

test('suppressed and non-consenting contacts never enter a segment (AT-5)', async () => {
  const f = await fresh()

  const mk = (
    email: string,
    over: { suppressed?: boolean; emailConsent?: boolean; stage?: string } = {},
  ) => ({
    workspaceId: f.ws.id,
    email,
    name: email,
    lifecycleStage: over.stage ?? 'lead',
    suppressed: over.suppressed ?? false,
    engagementScore: 50,
    consent: {
      email: over.emailConsent ?? true,
      sms: false,
      push: false,
      ads: false,
      capturedAt: new Date().toISOString(),
      basis: 'consent',
    },
  })

  await db.insert(contacts).values([
    mk('a@test.invalid'),
    mk('b@test.invalid'),
    mk('c@test.invalid', { suppressed: true }),
    mk('d@test.invalid', { emailConsent: false }),
  ])

  const rules = {
    combinator: 'and' as const,
    rules: [{ field: 'lifecycleStage', op: 'eq' as const, value: 'lead' }],
  }

  const evaluation = await evaluateRules(f.ws.id, rules, ['email'])
  assert.equal(evaluation.matched, 4, 'all four match the rule')
  assert.equal(evaluation.suppressed, 1, 'one is suppressed')
  assert.equal(
    evaluation.reachability.email,
    2,
    'reachable excludes both the suppressed contact and the one without email consent',
  )

  /* Materialised membership must also exclude the suppressed contact. */
  const [seg] = await db
    .insert(segments)
    .values({ workspaceId: f.ws.id, name: 'Leads', rules, syncTargets: ['email'] })
    .returning()
  await refreshSegment(f.ws.id, seg.id)

  const { segmentMembers } = await import('../src/lib/db/schema')
  const members = await db
    .select({ id: segmentMembers.contactId })
    .from(segmentMembers)
    .where(eq(segmentMembers.segmentId, seg.id))
  assert.equal(members.length, 3, 'suppressed contacts are never materialised into a segment')
})

/* ------------------------------------------------------ tenant isolation */

test('one workspace cannot act on another workspace\'s asset', async () => {
  const a = await fresh()
  const b = await fresh()
  const asset = await makeAsset(a, cleanBody)

  await assert.rejects(
    () => submitAssetForReview({ workspaceId: b.ws.id, assetId: asset.id, actorId: b.creator.id }),
    (e: unknown) => e instanceof GateError && /not found/i.test((e as Error).message),
    'a cross-tenant reference must read as not found, never as permitted',
  )

  await assert.rejects(
    () => assertPublishable(b.ws.id, asset.id),
    (e: unknown) => e instanceof GateError,
  )

  const visible = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, b.ws.id), eq(assets.id, asset.id)))
  assert.equal(visible.length, 0)
})
