/**
 * Segment-engine tests. Rules compile to SQL against real contact rows, so
 * every operator needs a test that proves it selects what it claims to.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { eq } from 'drizzle-orm'
import { contacts, segmentMembers, segments, type SegmentRuleGroup } from '../src/lib/db/schema'
import {
  buildLookalike,
  describeRules,
  evaluateRules,
  predictConversion,
  refreshSegment,
} from '../src/lib/targeting/engine'
import { simulateInterpretation } from '../src/lib/ai/agents/segment'
import { FIELDS, FIELD_BY_KEY, OPERATORS } from '../src/lib/targeting/fields'

const fixtures: Fixture[] = []
let shared: Fixture

after(async () => {
  for (const f of fixtures) await destroyWorkspace(f)
  await db.$client.end()
})

const consent = (email = true, ads = true) => ({
  email,
  sms: false,
  push: false,
  ads,
  capturedAt: new Date().toISOString(),
  basis: 'consent',
})

async function seeded(): Promise<Fixture> {
  if (shared) return shared
  const f = await createWorkspace()
  fixtures.push(f)

  const now = Date.now()
  await db.insert(contacts).values([
    {
      workspaceId: f.ws.id, email: 'uk-big@t.invalid', name: 'UK Big', country: 'GB',
      employees: 500, industry: 'SaaS', jobTitle: 'Head of Marketing', lifecycleStage: 'customer',
      plan: 'growth', engagementScore: 80, engagementHour: 9, consent: consent(),
      lastActivityAt: new Date(now - 2 * 86_400_000),
    },
    {
      workspaceId: f.ws.id, email: 'uk-small@t.invalid', name: 'UK Small', country: 'GB',
      employees: 20, industry: 'SaaS', jobTitle: 'Marketing Manager', lifecycleStage: 'lead',
      plan: 'trial', engagementScore: 25, engagementHour: 14, consent: consent(),
      lastActivityAt: new Date(now - 120 * 86_400_000),
    },
    {
      workspaceId: f.ws.id, email: 'us-big@t.invalid', name: 'US Big', country: 'US',
      employees: 900, industry: 'E-commerce', jobTitle: 'CMO', lifecycleStage: 'mql',
      plan: 'none', engagementScore: 65, engagementHour: 10, consent: consent(true, false),
      lastActivityAt: new Date(now - 5 * 86_400_000),
    },
    {
      workspaceId: f.ws.id, email: 'suppressed@t.invalid', name: 'Suppressed', country: 'GB',
      employees: 400, industry: 'SaaS', jobTitle: 'Head of Growth', lifecycleStage: 'lead',
      engagementScore: 90, engagementHour: 9, consent: consent(), suppressed: true,
      lastActivityAt: new Date(now - 1 * 86_400_000),
    },
  ])

  shared = f
  return f
}

const group = (rules: SegmentRuleGroup['rules'], combinator: 'and' | 'or' = 'and'): SegmentRuleGroup => ({
  combinator,
  rules,
})

/* ------------------------------------------------------------- operators */

test('eq and neq on an enum field', async () => {
  const f = await seeded()
  const gb = await evaluateRules(f.ws.id, group([{ field: 'country', op: 'eq', value: 'GB' }]))
  assert.equal(gb.matched, 3)

  const notGb = await evaluateRules(f.ws.id, group([{ field: 'country', op: 'neq', value: 'GB' }]))
  assert.equal(notGb.matched, 1)
})

test('in and nin on a list', async () => {
  const f = await seeded()
  const some = await evaluateRules(
    f.ws.id,
    group([{ field: 'lifecycleStage', op: 'in', value: ['lead', 'mql'] }]),
  )
  assert.equal(some.matched, 3)

  const rest = await evaluateRules(
    f.ws.id,
    group([{ field: 'lifecycleStage', op: 'nin', value: ['lead', 'mql'] }]),
  )
  assert.equal(rest.matched, 1)
})

test('numeric comparisons', async () => {
  const f = await seeded()
  assert.equal((await evaluateRules(f.ws.id, group([{ field: 'employees', op: 'gt', value: 100 }]))).matched, 3)
  assert.equal((await evaluateRules(f.ws.id, group([{ field: 'employees', op: 'lt', value: 100 }]))).matched, 1)
  assert.equal((await evaluateRules(f.ws.id, group([{ field: 'employees', op: 'gte', value: 500 }]))).matched, 2)
})

test('contains is case-insensitive', async () => {
  const f = await seeded()
  const upper = await evaluateRules(f.ws.id, group([{ field: 'jobTitle', op: 'contains', value: 'HEAD OF' }]))
  const lower = await evaluateRules(f.ws.id, group([{ field: 'jobTitle', op: 'contains', value: 'head of' }]))
  assert.equal(upper.matched, lower.matched)
  assert.equal(upper.matched, 2)
})

test('within_days filters on recency', async () => {
  const f = await seeded()
  const recent = await evaluateRules(
    f.ws.id,
    group([{ field: 'lastActivityAt', op: 'within_days', value: 30 }]),
  )
  assert.equal(recent.matched, 3, 'the 120-day-old contact is excluded')
})

test('or combines rather than intersects', async () => {
  const f = await seeded()
  const either = await evaluateRules(
    f.ws.id,
    group(
      [
        { field: 'country', op: 'eq', value: 'US' },
        { field: 'employees', op: 'lt', value: 100 },
      ],
      'or',
    ),
  )
  assert.equal(either.matched, 2)
})

test('nested groups mix and with or', async () => {
  const f = await seeded()
  const nested = await evaluateRules(
    f.ws.id,
    group([
      { field: 'country', op: 'eq', value: 'GB' },
      group(
        [
          { field: 'employees', op: 'gt', value: 300 },
          { field: 'plan', op: 'eq', value: 'trial' },
        ],
        'or',
      ),
    ]),
  )
  assert.equal(nested.matched, 3, 'GB and (large or trialing)')
})

test('an empty rule group matches the whole workspace, not nothing', async () => {
  const f = await seeded()
  const all = await evaluateRules(f.ws.id, group([]))
  assert.equal(all.matched, 4)
})

test('an unknown field is ignored rather than throwing', async () => {
  const f = await seeded()
  const result = await evaluateRules(
    f.ws.id,
    group([{ field: 'notARealField', op: 'eq', value: 'x' }]),
  )
  assert.equal(result.matched, 4, 'an uncompilable rule drops out instead of breaking the query')
})

/* ------------------------------------------------- consent + suppression */

test('reachability is consent-aware per channel', async () => {
  const f = await seeded()
  const result = await evaluateRules(f.ws.id, group([]), ['email', 'google_ads'])
  assert.equal(result.matched, 4)
  assert.equal(result.suppressed, 1)
  assert.equal(result.reachability.email, 3, 'suppressed excluded')
  assert.equal(result.reachability.google_ads, 2, 'suppressed and non-ads-consenting excluded')
})

/* -------------------------------------------------------------- lookalike */

test('a lookalike excludes the seed members and respects the threshold', async () => {
  const f = await seeded()
  const [seed] = await db
    .insert(segments)
    .values({
      workspaceId: f.ws.id,
      name: 'Seed',
      rules: group([{ field: 'country', op: 'eq', value: 'GB' }]),
    })
    .returning()
  await refreshSegment(f.ws.id, seed.id)

  const loose = await buildLookalike(f.ws.id, seed.id, 0.1)
  const strict = await buildLookalike(f.ws.id, seed.id, 0.99)

  assert.ok(loose.matched >= strict.matched, 'a higher threshold cannot match more people')
  assert.ok(loose.centroid.seedSize, 'the centroid explains what it matched on')

  // A lookalike must reach *new* people — returning the seed back would make
  // the expansion figure meaningless.
  const seedMembers = await db
    .select({ id: segmentMembers.contactId })
    .from(segmentMembers)
    .where(eq(segmentMembers.segmentId, seed.id))
  const seedIds = new Set(seedMembers.map((m) => m.id))
  assert.ok(seedIds.size > 0, 'the seed segment should have members to expand from')

  const overlap = loose.contactIds.filter((id) => seedIds.has(id))
  assert.equal(overlap.length, 0, 'no seed member may appear in its own lookalike')
})

/* ------------------------------------------------------------ prediction */

test('predicted conversion rises with engagement and stays bounded', () => {
  assert.ok(predictConversion(80, 10, 100) > predictConversion(20, 10, 100))
  assert.ok(predictConversion(100, 100, 100) <= 0.22, 'the prediction is capped')
  assert.equal(predictConversion(50, 5, 0), 0, 'an empty segment converts at zero, not NaN')
})

/* ------------------------------------------- natural-language translation */

test('the NL simulator only emits fields from the catalogue', () => {
  const queries = [
    'UK companies with more than 100 employees active in the last 30 days',
    'heads of marketing at SaaS companies',
    'trial users in Germany who have gone quiet',
    'something entirely unparseable ~~~',
  ]
  for (const q of queries) {
    const result = simulateInterpretation(q)
    assert.ok(result.rules.rules.length > 0, `no rules produced for "${q}"`)
    for (const rule of result.rules.rules) {
      if ('combinator' in rule) continue
      assert.ok(FIELD_BY_KEY.has(rule.field), `unknown field "${rule.field}" from "${q}"`)
      const def = FIELD_BY_KEY.get(rule.field)!
      const allowed = OPERATORS[def.type].map((o) => o.op)
      assert.ok(allowed.includes(rule.op), `operator "${rule.op}" is not valid for ${rule.field}`)
    }
    assert.ok(result.interpretation.length > 0, 'every interpretation is explained in plain English')
  }
})

test('the NL simulator never targets the suppression flag', () => {
  const result = simulateInterpretation('everyone who is not suppressed')
  const fields = result.rules.rules.filter((r) => !('combinator' in r)).map((r) => (r as { field: string }).field)
  assert.ok(!fields.includes('suppressed'), 'suppression is enforced by the engine, never by a rule')
})

test('every catalogue field has at least one valid operator', () => {
  for (const field of FIELDS) {
    assert.ok(OPERATORS[field.type]?.length > 0, `${field.key} has no operators`)
  }
})

test('rules describe themselves in readable English', () => {
  const text = describeRules(
    group([
      { field: 'country', op: 'eq', value: 'GB' },
      { field: 'employees', op: 'gt', value: 100 },
    ]),
  )
  assert.match(text, /Country is GB/)
  assert.match(text, /and/)
})
