import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/lib/db'
import { col } from '@/lib/db/sql-utils'
import { connectors, contacts, segmentMembers, segments, users } from '@/lib/db/schema'
import type { SegmentRuleGroup } from '@/lib/db/schema'
import { predictConversion } from '@/lib/targeting/engine'
import { CONNECTOR_BY_PROVIDER } from '@/lib/connectors/registry'
import type { ConnectorStatus } from '@/components/targeting/sync'

/**
 * Read models for the Audience Targeting surface. Everything the screen shows
 * is counted here against the live contact table — nothing is cached in the
 * page or approximated.
 */

/**
 * The consent flag each channel is gated on. Duplicated from the engine's
 * private table because the engine does not export it; kept to the same
 * channels the engine evaluates by default.
 */
const CONSENT_KEY: Record<string, string> = {
  email: 'email',
  sms: 'sms',
  push: 'push',
  linkedin: 'ads',
  google_ads: 'ads',
  meta_ads: 'ads',
}

export type SegmentListItem = {
  id: string
  name: string
  description: string | null
  nlQuery: string | null
  rules: SegmentRuleGroup
  sourceType: string
  seedSegmentId: string | null
  seedName: string | null
  similarityThreshold: number
  estimatedSize: number
  reachableSize: number
  suppressedCount: number
  predictedConversion: number | null
  reachability: Record<string, number>
  syncTargets: string[]
  lastRefreshedAt: Date | null
  createdAt: Date
  createdByName: string | null
  createdByHue: number | null
  memberCount: number
}

export async function listSegments(workspaceId: string): Promise<SegmentListItem[]> {
  const seed = alias(segments, 'seed')
  const rows = await db
    .select({
      seg: segments,
      createdByName: users.name,
      createdByHue: users.avatarHue,
      seedName: seed.name,
      memberCount: sql<number>`(select count(*) from "segment_members" m where m."segment_id" = ${col(segments.id)})::int`,
    })
    .from(segments)
    .leftJoin(users, eq(users.id, segments.createdBy))
    .leftJoin(seed, eq(seed.id, segments.seedSegmentId))
    .where(eq(segments.workspaceId, workspaceId))
    .orderBy(desc(segments.createdAt))

  return rows.map((r) => ({
    id: r.seg.id,
    name: r.seg.name,
    description: r.seg.description,
    nlQuery: r.seg.nlQuery,
    rules: r.seg.rules,
    sourceType: r.seg.sourceType,
    seedSegmentId: r.seg.seedSegmentId,
    seedName: r.seedName,
    similarityThreshold: r.seg.similarityThreshold,
    estimatedSize: r.seg.estimatedSize,
    reachableSize: r.seg.reachableSize,
    suppressedCount: r.seg.suppressedCount,
    predictedConversion: r.seg.predictedConversion,
    reachability: r.seg.reachability,
    syncTargets: r.seg.syncTargets,
    lastRefreshedAt: r.seg.lastRefreshedAt,
    createdAt: r.seg.createdAt,
    createdByName: r.createdByName,
    createdByHue: r.createdByHue,
    memberCount: Number(r.memberCount ?? 0),
  }))
}

export async function getSegment(workspaceId: string, id: string): Promise<SegmentListItem | null> {
  const all = await listSegments(workspaceId)
  return all.find((s) => s.id === id) ?? null
}

/* --------------------------------------------------------- workspace view */

export type AudienceOverview = {
  total: number
  suppressed: number
  consent: Record<'email' | 'sms' | 'push' | 'ads', number>
  avgEngagement: number
}

export async function audienceOverview(workspaceId: string): Promise<AudienceOverview> {
  const flag = (key: string) =>
    sql<number>`count(*) filter (where not ${contacts.suppressed} and (${contacts.consent} ->> ${key})::boolean is true)::int`

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      suppressed: sql<number>`count(*) filter (where ${contacts.suppressed})::int`,
      email: flag('email'),
      sms: flag('sms'),
      push: flag('push'),
      ads: flag('ads'),
      avgEngagement: sql<number>`coalesce(avg(${contacts.engagementScore}), 0)::float`,
    })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId))

  return {
    total: Number(row?.total ?? 0),
    suppressed: Number(row?.suppressed ?? 0),
    consent: {
      email: Number(row?.email ?? 0),
      sms: Number(row?.sms ?? 0),
      push: Number(row?.push ?? 0),
      ads: Number(row?.ads ?? 0),
    },
    avgEngagement: Number(row?.avgEngagement ?? 0),
  }
}

/** AT-5: name the reasons, so "suppressed" is not an unexplained deduction. */
export async function suppressionReasons(
  workspaceId: string,
): Promise<{ reason: string; count: number }[]> {
  const rows = await db
    .select({
      reason: sql<string>`coalesce(${contacts.suppressionReason}, 'unspecified')`,
      count: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.suppressed, true)))
    .groupBy(sql`coalesce(${contacts.suppressionReason}, 'unspecified')`)
    .orderBy(sql`count(*) desc`)

  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }))
}

/* --------------------------------------------------------- lookalike view */

export type MemberEvaluation = {
  matched: number
  reachable: number
  reachability: Record<string, number>
  predictedConversion: number
}

/**
 * Stats for a segment whose membership is materialised rather than derived from
 * rules — a lookalike. Re-evaluating its (empty) rule set would match the whole
 * workspace, so the numbers come from the member table instead.
 */
export async function memberEvaluation(
  segmentId: string,
  channels: string[] = ['email', 'linkedin', 'google_ads', 'sms'],
): Promise<MemberEvaluation> {
  const consentCount = (channel: string) => {
    const key = CONSENT_KEY[channel]
    if (!key) return sql<number>`count(*)::int`
    return sql<number>`count(*) filter (where (${contacts.consent} ->> ${key})::boolean is true)::int`
  }

  const selection: Record<string, ReturnType<typeof consentCount>> = {}
  for (const c of channels) selection[c] = consentCount(c)

  const [row] = await db
    .select({
      matched: sql<number>`count(*)::int`,
      avgEngagement: sql<number>`coalesce(avg(${contacts.engagementScore}), 0)::float`,
      customers: sql<number>`count(*) filter (where ${contacts.lifecycleStage} = 'customer')::int`,
      ...selection,
    })
    .from(segmentMembers)
    .innerJoin(contacts, eq(contacts.id, segmentMembers.contactId))
    .where(and(eq(segmentMembers.segmentId, segmentId), eq(contacts.suppressed, false)))

  const source = (row ?? {}) as Record<string, number>
  const matched = Number(source.matched ?? 0)
  const reachability: Record<string, number> = {}
  for (const c of channels) reachability[c] = Number(source[c] ?? 0)

  return {
    matched,
    reachable: Math.max(0, ...Object.values(reachability)),
    reachability,
    predictedConversion: predictConversion(
      Number(source.avgEngagement ?? 0),
      Number(source.customers ?? 0),
      matched,
    ),
  }
}

export type MemberSample = {
  id: string
  name: string | null
  email: string
  company: string | null
  jobTitle: string | null
  lifecycleStage: string
  engagementScore: number
}

export async function memberSample(segmentId: string, limit = 8): Promise<MemberSample[]> {
  return db
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      company: contacts.company,
      jobTitle: contacts.jobTitle,
      lifecycleStage: contacts.lifecycleStage,
      engagementScore: contacts.engagementScore,
    })
    .from(segmentMembers)
    .innerJoin(contacts, eq(contacts.id, segmentMembers.contactId))
    .where(and(eq(segmentMembers.segmentId, segmentId), eq(contacts.suppressed, false)))
    .orderBy(desc(segmentMembers.score))
    .limit(limit)
}

/* ------------------------------------------------------------- connectors */

export async function connectorStatuses(workspaceId: string): Promise<Record<string, ConnectorStatus>> {
  const rows = await db
    .select({
      provider: connectors.provider,
      displayName: connectors.displayName,
      status: connectors.status,
      lastSyncAt: connectors.lastSyncAt,
    })
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId))

  const map: Record<string, ConnectorStatus> = {}
  for (const r of rows) {
    map[r.provider] = {
      provider: r.provider,
      displayName: r.displayName,
      status: r.status,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      supportsAudienceSync:
        CONNECTOR_BY_PROVIDER.get(r.provider)?.capabilities.includes('audience_sync') ?? false,
    }
  }
  return map
}
