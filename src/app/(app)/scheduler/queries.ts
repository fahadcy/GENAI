import 'server-only'
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalRequests,
  assets,
  blackoutWindows,
  campaigns,
  frequencyCaps,
  scheduleItems,
  segments,
  users,
  type Channel,
} from '@/lib/db/schema'

/**
 * Read models for the Scheduler.
 *
 * Everything the calendar draws — items, blackout windows, cap pressure, the
 * approval gate's verdict on each unscheduled asset — comes from here. The
 * writes all live in `@/app/actions/scheduler`; this file never mutates.
 */

/* --------------------------------------------------------------- calendar */

export type CalendarItem = Awaited<ReturnType<typeof calendarItems>>[number]

export async function calendarItems(workspaceId: string, from: Date, to: Date) {
  return db
    .select({
      id: scheduleItems.id,
      scheduledAt: scheduleItems.scheduledAt,
      timezone: scheduleItems.timezone,
      channel: scheduleItems.channel,
      status: scheduleItems.status,
      sendTimeSource: scheduleItems.sendTimeSource,
      predictedLift: scheduleItems.predictedLift,
      sendTimeRationale: scheduleItems.sendTimeRationale,
      publishedAt: scheduleItems.publishedAt,
      externalRef: scheduleItems.externalRef,
      attempts: scheduleItems.attempts,
      lastError: scheduleItems.lastError,
      nextRetryAt: scheduleItems.nextRetryAt,
      assetId: scheduleItems.assetId,
      assetTitle: assets.title,
      assetStatus: assets.status,
      compositeScore: assets.compositeScore,
      segmentId: scheduleItems.segmentId,
      segmentName: segments.name,
      segmentReachable: segments.reachableSize,
      segmentReachability: segments.reachability,
      campaignId: scheduleItems.campaignId,
      campaignName: campaigns.name,
      createdByName: users.name,
      createdByHue: users.avatarHue,
    })
    .from(scheduleItems)
    .innerJoin(assets, eq(assets.id, scheduleItems.assetId))
    .leftJoin(segments, eq(segments.id, scheduleItems.segmentId))
    .leftJoin(campaigns, eq(campaigns.id, scheduleItems.campaignId))
    .leftJoin(users, eq(users.id, scheduleItems.createdBy))
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        ne(scheduleItems.status, 'cancelled'),
        gte(scheduleItems.scheduledAt, from),
        lte(scheduleItems.scheduledAt, to),
      ),
    )
    .orderBy(asc(scheduleItems.scheduledAt))
}

/* ------------------------------------------------------------- SC-5 rules */

export type Blackout = Awaited<ReturnType<typeof blackouts>>[number]

/** Every blackout window that overlaps the loaded calendar range, plus any still ahead. */
export async function blackouts(workspaceId: string, from: Date, to: Date) {
  return db
    .select()
    .from(blackoutWindows)
    .where(
      and(
        eq(blackoutWindows.workspaceId, workspaceId),
        lte(blackoutWindows.startsAt, to),
        gte(blackoutWindows.endsAt, from),
      ),
    )
    .orderBy(asc(blackoutWindows.startsAt))
}

export async function upcomingBlackouts(workspaceId: string) {
  return db
    .select()
    .from(blackoutWindows)
    .where(and(eq(blackoutWindows.workspaceId, workspaceId), gte(blackoutWindows.endsAt, new Date())))
    .orderBy(asc(blackoutWindows.startsAt))
}

export type CapPressure = {
  id: string
  channel: string
  maxPerContact: number
  windowDays: number
  /** The segment currently closest to the cap, and how close it is. */
  peakSegment: string | null
  peakCount: number
  segmentsAtCap: number
  totalPlaced: number
}

/**
 * How much headroom each frequency cap has left. `checkConflicts` counts items
 * within ±windowDays of a candidate slot, so the same window is measured here —
 * a panel that used a different window would tell a comfortable lie.
 */
export async function capPressure(workspaceId: string): Promise<CapPressure[]> {
  const caps = await db
    .select()
    .from(frequencyCaps)
    .where(eq(frequencyCaps.workspaceId, workspaceId))
    .orderBy(asc(frequencyCaps.channel))

  const now = Date.now()

  return Promise.all(
    caps.map(async (cap) => {
      const span = cap.windowDays * 86_400_000
      const rows = await db
        .select({
          segmentId: scheduleItems.segmentId,
          segmentName: segments.name,
          n: sql<number>`count(*)::int`,
        })
        .from(scheduleItems)
        .leftJoin(segments, eq(segments.id, scheduleItems.segmentId))
        .where(
          and(
            eq(scheduleItems.workspaceId, workspaceId),
            eq(scheduleItems.channel, cap.channel),
            ne(scheduleItems.status, 'cancelled'),
            gte(scheduleItems.scheduledAt, new Date(now - span)),
            lte(scheduleItems.scheduledAt, new Date(now + span)),
            sql`${scheduleItems.segmentId} is not null`,
          ),
        )
        .groupBy(scheduleItems.segmentId, segments.name)
        .orderBy(desc(sql`count(*)`))

      return {
        id: cap.id,
        channel: cap.channel as string,
        maxPerContact: cap.maxPerContact,
        windowDays: cap.windowDays,
        peakSegment: rows[0]?.segmentName ?? null,
        peakCount: rows[0]?.n ?? 0,
        segmentsAtCap: rows.filter((r) => r.n >= cap.maxPerContact).length,
        totalPlaced: rows.reduce((a, r) => a + r.n, 0),
      }
    }),
  )
}

/* ------------------------------------------------- SC-3 the approval gate */

export type Candidate = {
  assetId: string
  title: string
  channel: string
  status: string
  version: number
  compositeScore: number | null
  campaignId: string | null
  campaignName: string | null
  updatedAt: Date
  ready: boolean
  /** Why this asset cannot be placed. Null when it can. */
  blockedReason: string | null
}

/**
 * Assets that are candidates for a calendar slot, split by whether the gate lets
 * them through. The blocked ones are shown too, with the specific reason —
 * "you can't do that" without a why is what makes governance feel like
 * obstruction rather than safety (SC-3).
 */
export async function scheduleCandidates(workspaceId: string): Promise<Candidate[]> {
  const rows = await db
    .select({
      assetId: assets.id,
      title: assets.title,
      channel: assets.channel,
      status: assets.status,
      version: assets.version,
      compositeScore: assets.compositeScore,
      campaignId: assets.campaignId,
      campaignName: campaigns.name,
      updatedAt: assets.updatedAt,
      approvedVersion: sql<
        number | null
      >`(select ar.subject_version from approval_requests ar where ar.subject_type = 'asset' and ar.subject_id = ${assets.id} and ar.status = 'approved' order by ar.completed_at desc nulls last limit 1)::int`,
      pendingStep: approvalRequests.currentStep,
      pendingDueAt: approvalRequests.dueAt,
      chainName: approvalChains.name,
      chainSteps: approvalChains.steps,
    })
    .from(assets)
    .leftJoin(campaigns, eq(campaigns.id, assets.campaignId))
    .leftJoin(
      approvalRequests,
      and(
        eq(approvalRequests.subjectType, 'asset'),
        eq(approvalRequests.subjectId, assets.id),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .leftJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .where(
      and(
        eq(assets.workspaceId, workspaceId),
        inArray(assets.status, ['draft', 'in_review', 'changes_requested', 'approved']),
        // An asset already holding a live slot is on the calendar, not in the tray.
        sql`not exists (select 1 from schedule_items si where si.asset_id = ${assets.id} and si.status <> 'cancelled')`,
      ),
    )
    .orderBy(desc(assets.updatedAt))
    .limit(60)

  return rows.map((r) => {
    const base = {
      assetId: r.assetId,
      title: r.title,
      channel: r.channel as string,
      status: r.status as string,
      version: r.version,
      compositeScore: r.compositeScore,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      updatedAt: r.updatedAt,
    }

    // Mirrors assertPublishable() so the tray and the action agree on the verdict.
    if (r.status === 'approved') {
      if (r.approvedVersion === null) {
        return { ...base, ready: false, blockedReason: 'Marked approved but no completed approval is on record. Resubmit it for review.' }
      }
      if (r.approvedVersion !== r.version) {
        return {
          ...base,
          ready: false,
          blockedReason: `Edited after approval — v${r.approvedVersion} was signed off, the current draft is v${r.version}. Resubmit for review.`,
        }
      }
      return { ...base, ready: true, blockedReason: null }
    }

    if (r.status === 'in_review') {
      const total = r.chainSteps?.length ?? 0
      const step = r.chainSteps?.[r.pendingStep ?? 0]
      const where = step ? `${r.chainName} — step ${(r.pendingStep ?? 0) + 1} of ${total}, with ${step.name}.` : 'Awaiting a reviewer.'
      const overdue = r.pendingDueAt && r.pendingDueAt.getTime() < Date.now()
      return { ...base, ready: false, blockedReason: `Still in review. ${where}${overdue ? ' The SLA has already lapsed.' : ''}` }
    }

    if (r.status === 'changes_requested') {
      return { ...base, ready: false, blockedReason: 'A reviewer requested changes. It has to go back through review before it can be placed.' }
    }

    return { ...base, ready: false, blockedReason: 'Still a draft — it has never been submitted for approval.' }
  })
}

/* ------------------------------------------------------- SC-4 publishing */

export type AttentionItem = Awaited<ReturnType<typeof needsAttention>>[number]

/** Dead-lettered and retrying items — the queue's failures, never hidden. */
export async function needsAttention(workspaceId: string) {
  return db
    .select({
      id: scheduleItems.id,
      status: scheduleItems.status,
      channel: scheduleItems.channel,
      scheduledAt: scheduleItems.scheduledAt,
      attempts: scheduleItems.attempts,
      lastError: scheduleItems.lastError,
      nextRetryAt: scheduleItems.nextRetryAt,
      assetId: scheduleItems.assetId,
      assetTitle: assets.title,
      campaignName: campaigns.name,
    })
    .from(scheduleItems)
    .innerJoin(assets, eq(assets.id, scheduleItems.assetId))
    .leftJoin(campaigns, eq(campaigns.id, scheduleItems.campaignId))
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        inArray(scheduleItems.status, ['dead_letter', 'failed']),
      ),
    )
    .orderBy(asc(scheduleItems.scheduledAt))
}

/* -------------------------------------------------- SC-2 send-time model */

/** How much of the calendar the model chose, and what it claimed for it. */
export async function sendTimeSummary(workspaceId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      ai: sql<number>`count(*) filter (where ${scheduleItems.sendTimeSource} = 'ai')::int`,
      manual: sql<number>`count(*) filter (where ${scheduleItems.sendTimeSource} <> 'ai')::int`,
      avgLift: sql<number>`avg(${scheduleItems.predictedLift}) filter (where ${scheduleItems.sendTimeSource} = 'ai')::float`,
      aiUpcoming: sql<number>`count(*) filter (where ${scheduleItems.sendTimeSource} = 'ai' and ${scheduleItems.status} = 'scheduled')::int`,
    })
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, workspaceId), ne(scheduleItems.status, 'cancelled')))

  return {
    total: Number(row?.total ?? 0),
    ai: Number(row?.ai ?? 0),
    manual: Number(row?.manual ?? 0),
    avgLift: row?.avgLift ?? null,
    aiUpcoming: Number(row?.aiUpcoming ?? 0),
  }
}

/* ------------------------------------------------------------- reference */

/** Segments a marketer can target, ordered by how many people they actually reach. */
export async function targetableSegments(workspaceId: string) {
  return db
    .select({
      id: segments.id,
      name: segments.name,
      reachableSize: segments.reachableSize,
      reachability: segments.reachability,
    })
    .from(segments)
    .where(eq(segments.workspaceId, workspaceId))
    .orderBy(desc(segments.reachableSize))
}

/** Channels this workspace actually schedules on, for the calendar filter. */
export async function activeChannels(workspaceId: string): Promise<Channel[]> {
  const rows = await db
    .selectDistinct({ channel: scheduleItems.channel })
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, workspaceId), ne(scheduleItems.status, 'cancelled')))
  return rows.map((r) => r.channel)
}
