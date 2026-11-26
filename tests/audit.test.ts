/**
 * Audit-trail tests.
 *
 * PRD AP-3 says every state change is logged and "cannot be edited after the
 * fact". A hash chain cannot literally prevent a database owner from editing a
 * row — what it can do is make the edit detectable. These tests prove exactly
 * that: we tamper with history deliberately and assert that verification
 * catches it and names the sequence number.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { asc, eq, sql } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { auditEvents } from '../src/lib/db/schema'
import { canonical, exportAuditCsv, hashEvent, recordAudit, verifyChain } from '../src/lib/workflow/audit'

const fixtures: Fixture[] = []
async function fresh() {
  const f = await createWorkspace()
  fixtures.push(f)
  return f
}

after(async () => {
  for (const f of fixtures) await destroyWorkspace(f)
  await db.$client.end()
})

/* ------------------------------------------------------- canonical form */

test('canonical serialisation is key-order independent', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }))
  assert.equal(canonical({ x: { p: 1, q: 2 } }), canonical({ x: { q: 2, p: 1 } }))
})

test('canonical serialisation is order-sensitive for arrays', () => {
  assert.notEqual(canonical([1, 2]), canonical([2, 1]))
})

test('hashing is stable and prev-hash sensitive', () => {
  const body = { action: 'x', n: 1 }
  assert.equal(hashEvent('abc', body), hashEvent('abc', body))
  assert.notEqual(hashEvent('abc', body), hashEvent('abd', body))
  assert.notEqual(hashEvent('abc', body), hashEvent('abc', { action: 'x', n: 2 }))
})

/* -------------------------------------------------------------- chaining */

test('a fresh chain verifies and links each event to the last', async () => {
  const f = await fresh()
  for (let i = 0; i < 5; i++) {
    await recordAudit({
      workspaceId: f.ws.id,
      actorId: f.owner.id,
      action: 'asset.generated',
      subjectType: 'asset',
      summary: `Event ${i}`,
      payload: { i },
    })
  }

  const result = await verifyChain(f.ws.id)
  assert.equal(result.ok, true, result.reason ?? '')
  assert.equal(result.checked, 5)

  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, f.ws.id))
    .orderBy(asc(auditEvents.seq))

  assert.equal(rows[0].prevHash, null, 'the first event has no predecessor')
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].prevHash, rows[i - 1].hash, `event ${i} must point at event ${i - 1}`)
  }
})

test('editing a historical summary is detected and located', async () => {
  const f = await fresh()
  for (let i = 0; i < 4; i++) {
    await recordAudit({
      workspaceId: f.ws.id,
      action: 'approval.approved',
      subjectType: 'asset',
      summary: `Original ${i}`,
    })
  }

  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, f.ws.id))
    .orderBy(asc(auditEvents.seq))
  const target = rows[1]

  // Tamper: rewrite the summary but leave the stored hash untouched, which is
  // exactly what someone quietly editing the record would do.
  await db
    .update(auditEvents)
    .set({ summary: 'Quietly rewritten' })
    .where(eq(auditEvents.id, target.id))

  const result = await verifyChain(f.ws.id)
  assert.equal(result.ok, false, 'tampering must be detected')
  assert.equal(result.brokenAtSeq, target.seq, 'verification must name the tampered event')
  assert.match(result.reason ?? '', /modified after it was written/)
})

test('deleting a historical event breaks the chain', async () => {
  const f = await fresh()
  for (let i = 0; i < 4; i++) {
    await recordAudit({
      workspaceId: f.ws.id,
      action: 'schedule.created',
      subjectType: 'schedule_item',
      summary: `Event ${i}`,
    })
  }
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, f.ws.id))
    .orderBy(asc(auditEvents.seq))

  await db.delete(auditEvents).where(eq(auditEvents.id, rows[1].id))

  const result = await verifyChain(f.ws.id)
  assert.equal(result.ok, false, 'a removed event must break verification')
  assert.equal(result.brokenAtSeq, rows[2].seq, 'the break surfaces at the orphaned successor')
  assert.match(result.reason ?? '', /inserted, removed or reordered/)
})

test('concurrent appends do not fork the chain', async () => {
  const f = await fresh()

  // The advisory lock in recordAudit is what makes this safe; without it two
  // writers can read the same predecessor and both claim it.
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      recordAudit({
        workspaceId: f.ws.id,
        action: 'asset.edited',
        subjectType: 'asset',
        summary: `Concurrent ${i}`,
      }),
    ),
  )

  const result = await verifyChain(f.ws.id)
  assert.equal(result.ok, true, result.reason ?? 'concurrent appends forked the chain')
  assert.equal(result.checked, 12)

  const [{ distinct }] = await db
    .select({ distinct: sql<number>`count(distinct ${auditEvents.prevHash})::int` })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, f.ws.id))
  assert.equal(distinct, 11, 'each prev-hash must be claimed exactly once')
})

test('one workspace chain is unaffected by another', async () => {
  const a = await fresh()
  const b = await fresh()

  await recordAudit({ workspaceId: a.ws.id, action: 'asset.generated', subjectType: 'asset', summary: 'A1' })
  await recordAudit({ workspaceId: b.ws.id, action: 'asset.generated', subjectType: 'asset', summary: 'B1' })
  await recordAudit({ workspaceId: a.ws.id, action: 'asset.generated', subjectType: 'asset', summary: 'A2' })

  assert.equal((await verifyChain(a.ws.id)).checked, 2)
  assert.equal((await verifyChain(b.ws.id)).checked, 1)
  assert.equal((await verifyChain(a.ws.id)).ok, true)
  assert.equal((await verifyChain(b.ws.id)).ok, true)
})

/* ---------------------------------------------------------------- export */

test('CSV export escapes commas, quotes and newlines', async () => {
  const f = await fresh()
  await recordAudit({
    workspaceId: f.ws.id,
    action: 'approval.rejected',
    subjectType: 'asset',
    summary: 'Contains, a comma and "quotes" and\na newline',
    payload: { note: 'x,y' },
  })

  const csv = await exportAuditCsv(f.ws.id)
  const [header] = csv.split('\n')
  assert.match(header, /^seq,timestamp/)
  assert.ok(csv.includes('"Contains, a comma and ""quotes"" and\na newline"'))
  assert.ok(csv.includes('hash'), 'the hash must be exportable for independent verification')
})
