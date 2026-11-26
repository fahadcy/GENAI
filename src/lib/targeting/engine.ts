import 'server-only'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts, segmentMembers, segments } from '@/lib/db/schema'
import type { SegmentRule, SegmentRuleGroup } from '@/lib/db/schema'
import { FIELD_BY_KEY, describeField } from './fields'

/**
 * Segment engine.
 *
 * Rules are compiled to parameterised SQL against real contact rows, so
 * "estimated size" is an actual count rather than a guess, and AT-5 (consent
 * and suppression honoured 100% of the time) is enforced here — in the one
 * place every caller must go through — rather than at each call site.
 */

const isGroup = (r: SegmentRule | SegmentRuleGroup): r is SegmentRuleGroup => 'combinator' in r

function columnFor(field: string): SQL | null {
  const def = FIELD_BY_KEY.get(field)
  if (!def?.column) return null
  return sql.raw(`"contacts"."${def.column}"`)
}

function compileRule(rule: SegmentRule): SQL | null {
  const col = columnFor(rule.field)
  if (!col) return null
  const def = FIELD_BY_KEY.get(rule.field)!
  const v = rule.value

  switch (rule.op) {
    case 'eq':
      if (def.type === 'boolean') return sql`${col} = ${Boolean(v)}`
      if (def.type === 'number') return sql`${col} = ${Number(v)}`
      return sql`lower(${col}::text) = lower(${String(v)})`
    case 'neq':
      if (def.type === 'number') return sql`${col} <> ${Number(v)}`
      return sql`(${col} IS NULL OR lower(${col}::text) <> lower(${String(v)}))`
    case 'in': {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase())
      if (list.length === 0) return null
      return sql`lower(${col}::text) IN ${list}`
    }
    case 'nin': {
      const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase())
      if (list.length === 0) return null
      return sql`(${col} IS NULL OR lower(${col}::text) NOT IN ${list})`
    }
    case 'gt':
      return def.type === 'date' ? sql`${col} > ${new Date(String(v))}` : sql`${col} > ${Number(v)}`
    case 'gte':
      return def.type === 'date' ? sql`${col} >= ${new Date(String(v))}` : sql`${col} >= ${Number(v)}`
    case 'lt':
      return def.type === 'date' ? sql`${col} < ${new Date(String(v))}` : sql`${col} < ${Number(v)}`
    case 'lte':
      return def.type === 'date' ? sql`${col} <= ${new Date(String(v))}` : sql`${col} <= ${Number(v)}`
    case 'contains':
      return sql`${col}::text ILIKE ${'%' + String(v) + '%'}`
    case 'within_days': {
      const days = Number(v)
      if (!Number.isFinite(days) || days <= 0) return null
      return sql`${col} >= now() - ${sql.raw(`interval '${Math.floor(days)} days'`)}`
    }
    case 'exists':
      return sql`${col} IS NOT NULL`
    default:
      return null
  }
}

export function compileGroup(group: SegmentRuleGroup): SQL | null {
  const parts = group.rules
    .map((r) => (isGroup(r) ? compileGroup(r) : compileRule(r)))
    .filter((x): x is SQL => x !== null)
  if (parts.length === 0) return null
  const joiner = group.combinator === 'or' ? sql` OR ` : sql` AND `
  return sql`(${sql.join(parts, joiner)})`
}

/* ------------------------------------------------------------ evaluation */

export type Reachability = Record<string, number>

export type EvaluationResult = {
  matched: number
  suppressed: number
  reachable: number
  reachability: Reachability
  predictedConversion: number
  sample: { id: string; name: string | null; email: string; company: string | null; jobTitle: string | null; lifecycleStage: string; engagementScore: number }[]
}

/**
 * Which consent flag gates each channel. Exported so callers computing their own
 * reachability figures use the same mapping the engine enforces, rather than a
 * duplicate that can drift out of step with it.
 */
export const CHANNEL_CONSENT_KEY: Record<string, string | null> = {
  email: 'email',
  sms: 'sms',
  push: 'push',
  google_ads: 'ads',
  meta_ads: 'ads',
  linkedin: 'ads',
  facebook: 'ads',
  instagram: 'ads',
  x: 'ads',
  blog: null,
  web: null,
}

/**
 * Evaluate rules without persisting. Used by the live preview as the marketer
 * edits, so segment size updates as rules change (AT-3).
 */
export async function evaluateRules(
  workspaceId: string,
  rules: SegmentRuleGroup,
  channels: string[] = ['email', 'linkedin', 'google_ads', 'sms'],
): Promise<EvaluationResult> {
  const predicate = compileGroup(rules)
  const base = predicate
    ? and(eq(contacts.workspaceId, workspaceId), predicate)!
    : eq(contacts.workspaceId, workspaceId)

  const [totals] = await db
    .select({
      matched: sql<number>`count(*)::int`,
      suppressed: sql<number>`count(*) filter (where ${contacts.suppressed})::int`,
      avgEngagement: sql<number>`coalesce(avg(${contacts.engagementScore}) filter (where not ${contacts.suppressed}), 0)::float`,
      customers: sql<number>`count(*) filter (where ${contacts.lifecycleStage} = 'customer')::int`,
    })
    .from(contacts)
    .where(base)

  const reachability: Reachability = {}
  for (const channel of channels) {
    const key = CHANNEL_CONSENT_KEY[channel]
    if (key === null) {
      // Untargeted channels reach everyone who is not suppressed.
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(base, eq(contacts.suppressed, false)))
      reachability[channel] = r?.n ?? 0
      continue
    }
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .where(
        and(
          base,
          eq(contacts.suppressed, false),
          sql`(${contacts.consent} ->> ${key})::boolean is true`,
        ),
      )
    reachability[channel] = r?.n ?? 0
  }

  const sample = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      company: contacts.company,
      jobTitle: contacts.jobTitle,
      lifecycleStage: contacts.lifecycleStage,
      engagementScore: contacts.engagementScore,
    })
    .from(contacts)
    .where(and(base, eq(contacts.suppressed, false)))
    .orderBy(sql`${contacts.engagementScore} desc`)
    .limit(8)

  const matched = totals?.matched ?? 0
  const suppressed = totals?.suppressed ?? 0
  const reachable = Math.max(...Object.values(reachability), 0)

  return {
    matched,
    suppressed,
    reachable,
    reachability,
    predictedConversion: predictConversion(totals?.avgEngagement ?? 0, totals?.customers ?? 0, matched),
    sample,
  }
}

/**
 * Predicted conversion rate. A transparent, explainable model rather than a
 * black box: engagement is the dominant signal, existing-customer density
 * lifts it, and very large segments regress toward the mean.
 */
export function predictConversion(avgEngagement: number, customers: number, matched: number): number {
  if (matched === 0) return 0
  const engagementTerm = (avgEngagement / 100) * 0.085
  const affinityTerm = (customers / matched) * 0.04
  const sizePenalty = matched > 5000 ? 0.985 : matched > 1500 ? 0.995 : 1
  const raw = (0.008 + engagementTerm + affinityTerm) * sizePenalty
  return Math.round(Math.min(0.22, raw) * 10000) / 10000
}

/* ---------------------------------------------------------- persistence */

/** Recompute membership and cached stats for a saved segment. */
export async function refreshSegment(workspaceId: string, segmentId: string): Promise<EvaluationResult> {
  const [seg] = await db
    .select()
    .from(segments)
    .where(and(eq(segments.workspaceId, workspaceId), eq(segments.id, segmentId)))
    .limit(1)
  if (!seg) throw new Error('Segment not found')

  const channels = seg.syncTargets.length ? seg.syncTargets : ['email', 'linkedin', 'google_ads', 'sms']
  const result = await evaluateRules(workspaceId, seg.rules, channels)

  const predicate = compileGroup(seg.rules)
  const base = predicate
    ? and(eq(contacts.workspaceId, workspaceId), predicate)!
    : eq(contacts.workspaceId, workspaceId)

  await db.delete(segmentMembers).where(eq(segmentMembers.segmentId, segmentId))

  // Materialise only reachable members: a suppressed contact must never end up
  // in a segment that something downstream could publish to.
  await db.execute(sql`
    insert into "segment_members" ("segment_id", "contact_id", "score")
    select ${segmentId}::uuid, "contacts"."id", greatest(0.05, least(1, "contacts"."engagement_score" / 100.0))
    from "contacts"
    where ${and(base, eq(contacts.suppressed, false))}
    on conflict do nothing
  `)

  await db
    .update(segments)
    .set({
      estimatedSize: result.matched,
      reachableSize: result.reachable,
      suppressedCount: result.suppressed,
      predictedConversion: result.predictedConversion,
      reachability: result.reachability,
      lastRefreshedAt: new Date(),
    })
    .where(eq(segments.id, segmentId))

  return result
}

/**
 * Lookalike expansion (AT-2). Scores every non-member against the seed's
 * centroid over the numeric/categorical profile, and takes everyone above the
 * similarity threshold. Explainable by construction: we can show which
 * attributes drove the match.
 */
export async function buildLookalike(
  workspaceId: string,
  seedSegmentId: string,
  threshold: number,
): Promise<{ centroid: Record<string, unknown>; matched: number; contactIds: string[] }> {
  const seedRows = await db
    .select({
      employees: contacts.employees,
      industry: contacts.industry,
      country: contacts.country,
      engagementScore: contacts.engagementScore,
      lifecycleStage: contacts.lifecycleStage,
      id: contacts.id,
    })
    .from(segmentMembers)
    .innerJoin(contacts, eq(contacts.id, segmentMembers.contactId))
    .where(eq(segmentMembers.segmentId, seedSegmentId))

  if (seedRows.length === 0) return { centroid: {}, matched: 0, contactIds: [] }

  const seedIds = new Set(seedRows.map((r) => r.id))
  const avgEmployees = mean(seedRows.map((r) => r.employees ?? 0))
  const avgEngagement = mean(seedRows.map((r) => r.engagementScore))
  const industryMode = mode(seedRows.map((r) => r.industry ?? ''))
  const countryMode = mode(seedRows.map((r) => r.country ?? ''))

  const pool = await db
    .select({
      id: contacts.id,
      employees: contacts.employees,
      industry: contacts.industry,
      country: contacts.country,
      engagementScore: contacts.engagementScore,
    })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.suppressed, false)))

  const scored = pool
    .filter((c) => !seedIds.has(c.id))
    .map((c) => {
      const sizeSim = 1 - Math.min(1, Math.abs((c.employees ?? 0) - avgEmployees) / Math.max(200, avgEmployees * 2))
      const engSim = 1 - Math.min(1, Math.abs(c.engagementScore - avgEngagement) / 100)
      const indSim = c.industry === industryMode ? 1 : 0
      const geoSim = c.country === countryMode ? 1 : 0.35
      const score = sizeSim * 0.3 + engSim * 0.3 + indSim * 0.25 + geoSim * 0.15
      return { id: c.id, score }
    })
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)

  return {
    centroid: {
      employees: Math.round(avgEmployees),
      engagementScore: Math.round(avgEngagement),
      industry: industryMode,
      country: countryMode,
      seedSize: seedRows.length,
    },
    matched: scored.length,
    contactIds: scored.map((s) => s.id),
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
function mode(xs: string[]): string {
  const counts = new Map<string, number>()
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best = ''
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n]
  return best
}

/* ------------------------------------------------------------- display */

export function describeRules(group: SegmentRuleGroup, depth = 0): string {
  const parts = group.rules.map((r) =>
    isGroup(r) ? `(${describeRules(r, depth + 1)})` : describeRule(r),
  )
  return parts.join(group.combinator === 'or' ? ' or ' : ' and ')
}

export function describeRule(rule: SegmentRule): string {
  if (rule.label) return rule.label
  const field = describeField(rule.field)
  const v = Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value)
  const verbs: Record<string, string> = {
    eq: 'is', neq: 'is not', in: 'is any of', nin: 'is none of',
    gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'contains', within_days: 'within the last', exists: 'is known',
  }
  if (rule.op === 'within_days') return `${field} within the last ${v} days`
  if (rule.op === 'exists') return `${field} is known`
  return `${field} ${verbs[rule.op] ?? rule.op} ${v}`
}
