import 'server-only'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { col } from '@/lib/db/sql-utils'
import {
  approvalChains,
  approvalDecisions,
  approvalRequests,
  assets,
  assetVersions,
  brandProfiles,
  briefs,
  campaigns,
  legalRules,
  users,
  type AssetStatus,
  type Channel,
} from '@/lib/db/schema'

export type StudioFilters = {
  status?: string
  channel?: string
  campaignId?: string
  briefId?: string
  authorId?: string
  q?: string
}

export async function listAssets(workspaceId: string, filters: StudioFilters = {}) {
  const conditions: SQL[] = [eq(assets.workspaceId, workspaceId)]

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'needs_work') {
      conditions.push(inArray(assets.status, ['draft', 'changes_requested']))
    } else if (filters.status === 'in_flight') {
      conditions.push(inArray(assets.status, ['in_review', 'approved', 'scheduled']))
    } else {
      conditions.push(eq(assets.status, filters.status as AssetStatus))
    }
  }
  if (filters.channel && filters.channel !== 'all') {
    conditions.push(eq(assets.channel, filters.channel as Channel))
  }
  if (filters.campaignId) conditions.push(eq(assets.campaignId, filters.campaignId))
  if (filters.briefId) conditions.push(eq(assets.briefId, filters.briefId))
  if (filters.authorId) conditions.push(eq(assets.createdBy, filters.authorId))
  if (filters.q?.trim()) {
    const q = `%${filters.q.trim()}%`
    conditions.push(sql`(${assets.title} ilike ${q} or ${assets.body}::text ilike ${q})`)
  }

  return db
    .select({
      id: assets.id,
      title: assets.title,
      channel: assets.channel,
      variantLabel: assets.variantLabel,
      status: assets.status,
      stage: assets.stage,
      composite: assets.compositeScore,
      brandScore: assets.brandScore,
      complianceScore: assets.complianceScore,
      scoreDetail: assets.scoreDetail,
      body: assets.body,
      version: assets.version,
      editedByHuman: assets.editedByHuman,
      updatedAt: assets.updatedAt,
      createdAt: assets.createdAt,
      briefId: assets.briefId,
      briefTitle: briefs.title,
      campaignId: assets.campaignId,
      campaignName: campaigns.name,
      authorName: users.name,
      authorHue: users.avatarHue,
    })
    .from(assets)
    .leftJoin(briefs, eq(briefs.id, assets.briefId))
    .leftJoin(campaigns, eq(campaigns.id, assets.campaignId))
    .leftJoin(users, eq(users.id, assets.createdBy))
    .where(and(...conditions))
    .orderBy(desc(assets.updatedAt))
    .limit(120)
}

export type StudioAsset = Awaited<ReturnType<typeof listAssets>>[number]

/** Counts for the filter tabs — computed in one pass so the tabs never lie. */
export async function assetCounts(workspaceId: string) {
  const rows = await db
    .select({ status: assets.status, n: sql<number>`count(*)::int` })
    .from(assets)
    .where(eq(assets.workspaceId, workspaceId))
    .groupBy(assets.status)

  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<AssetStatus, number>
  const get = (s: AssetStatus) => by[s] ?? 0
  return {
    all: rows.reduce((a, r) => a + r.n, 0),
    needs_work: get('draft') + get('changes_requested'),
    in_review: get('in_review'),
    approved: get('approved'),
    scheduled: get('scheduled'),
    published: get('published'),
    archived: get('archived'),
  }
}

export async function getAssetDetail(workspaceId: string, assetId: string) {
  const [row] = await db
    .select({
      asset: assets,
      brief: briefs,
      campaign: { id: campaigns.id, name: campaigns.name },
      author: { name: users.name, avatarHue: users.avatarHue },
    })
    .from(assets)
    .leftJoin(briefs, eq(briefs.id, assets.briefId))
    .leftJoin(campaigns, eq(campaigns.id, assets.campaignId))
    .leftJoin(users, eq(users.id, assets.createdBy))
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, assetId)))
    .limit(1)

  if (!row) return null

  const [versions, approval, siblings, profile, rules] = await Promise.all([
    db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, assetId))
      .orderBy(desc(assetVersions.version)),
    latestApproval(assetId),
    row.asset.briefId
      ? db
          .select({
            id: assets.id,
            title: assets.title,
            channel: assets.channel,
            variantLabel: assets.variantLabel,
            status: assets.status,
            composite: assets.compositeScore,
          })
          .from(assets)
          .where(and(eq(assets.briefId, row.asset.briefId), sql`${assets.id} <> ${assetId}`))
          .orderBy(assets.channel, assets.variantLabel)
      : Promise.resolve([]),
    db
      .select()
      .from(brandProfiles)
      .where(and(eq(brandProfiles.workspaceId, workspaceId), eq(brandProfiles.isDefault, true)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select().from(legalRules).where(eq(legalRules.workspaceId, workspaceId)),
  ])

  return { ...row, versions, approval, siblings, profile, rules }
}

async function latestApproval(assetId: string) {
  const [req] = await db
    .select({
      request: approvalRequests,
      chain: approvalChains,
    })
    .from(approvalRequests)
    .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .where(
      and(eq(approvalRequests.subjectType, 'asset'), eq(approvalRequests.subjectId, assetId)),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1)

  if (!req) return null

  const decisions = await db
    .select({
      decision: approvalDecisions,
      userName: users.name,
      userHue: users.avatarHue,
    })
    .from(approvalDecisions)
    .leftJoin(users, eq(users.id, approvalDecisions.userId))
    .where(eq(approvalDecisions.requestId, req.request.id))
    .orderBy(approvalDecisions.createdAt)

  return { ...req, decisions }
}

/** Briefs with their variant counts, for the brief-first view. */
export async function listBriefs(workspaceId: string) {
  return db
    .select({
      id: briefs.id,
      title: briefs.title,
      objective: briefs.objective,
      channels: briefs.channels,
      createdAt: briefs.createdAt,
      campaignName: campaigns.name,
      campaignId: briefs.campaignId,
      authorName: users.name,
      authorHue: users.avatarHue,
      variants: sql<number>`(select count(*) from assets a where a.brief_id = ${col(briefs.id)})::int`,
      avgScore: sql<number>`(select avg(a.composite_score) from assets a where a.brief_id = ${col(briefs.id)})::float`,
      approved: sql<number>`(select count(*) from assets a where a.brief_id = ${col(briefs.id)} and a.status in ('approved','scheduled','published'))::int`,
    })
    .from(briefs)
    .leftJoin(campaigns, eq(campaigns.id, briefs.campaignId))
    .leftJoin(users, eq(users.id, briefs.createdBy))
    .where(eq(briefs.workspaceId, workspaceId))
    .orderBy(desc(briefs.createdAt))
    .limit(50)
}

export async function studioOptions(workspaceId: string) {
  const [campaignRows, brandRow, channelRows] = await Promise.all([
    db
      .select({ id: campaigns.id, name: campaigns.name, channels: campaigns.channels })
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), inArray(campaigns.status, ['draft', 'planning', 'active'])))
      .orderBy(campaigns.name),
    db
      .select()
      .from(brandProfiles)
      .where(and(eq(brandProfiles.workspaceId, workspaceId), eq(brandProfiles.isDefault, true)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({ channel: assets.channel, n: sql<number>`count(*)::int` })
      .from(assets)
      .where(eq(assets.workspaceId, workspaceId))
      .groupBy(assets.channel),
  ])
  return { campaigns: campaignRows, profile: brandRow, channelsInUse: channelRows }
}

/**
 * The pass-rate figure the PRD holds Content Studio to: at least 95% of
 * generated assets should clear the brand check without a manual edit.
 * Measured against AI-generated assets only — a hand-written asset passing
 * says nothing about generation quality.
 */
export async function brandPassRate(workspaceId: string) {
  const [row] = await db
    .select({
      generated: sql<number>`count(*) filter (where ${assets.aiGenerated})::int`,
      passedUnedited: sql<number>`count(*) filter (where ${assets.aiGenerated} and not ${assets.editedByHuman} and (${assets.scoreDetail}->>'passed')::boolean)::int`,
      edited: sql<number>`count(*) filter (where ${assets.editedByHuman})::int`,
      avgComposite: sql<number>`avg(${assets.compositeScore})::float`,
    })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), sql`${assets.scoreDetail} is not null`))

  const generated = row?.generated ?? 0
  return {
    generated,
    passedUnedited: row?.passedUnedited ?? 0,
    edited: row?.edited ?? 0,
    avgComposite: row?.avgComposite ?? null,
    rate: generated > 0 ? (row?.passedUnedited ?? 0) / generated : null,
  }
}
