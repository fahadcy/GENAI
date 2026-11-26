import 'server-only'
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  assets,
  blackoutWindows,
  contacts,
  frequencyCaps,
  scheduleItems,
  segmentMembers,
  segments,
  type Channel,
} from '@/lib/db/schema'
import { assertPublishable, GateError } from '@/lib/workflow/approvals'
import { recordAudit } from '@/lib/workflow/audit'
import { suggestSendTime } from './sendtime'

/**
 * Scheduling rules (PRD SC-1, SC-3, SC-5).
 *
 * Every placement passes four checks in order, and each produces a *specific*
 * reason on failure — "blocked" with no explanation is what makes governance
 * features feel like obstruction rather than safety.
 */

/** Channels that address individual contacts and therefore require a segment. */
const ADDRESSED_CHANNELS = new Set(['email', 'sms', 'push'])

export type ScheduleConflict = {
  kind: 'approval' | 'blackout' | 'frequency' | 'collision'
  message: string
  detail?: string
  /** Nearest time that would clear this conflict, when we can compute one. */
  suggestion?: Date
}

export async function checkConflicts(args: {
  workspaceId: string
  assetId: string
  channel: string
  segmentId?: string | null
  scheduledAt: Date
  ignoreScheduleItemId?: string
}): Promise<ScheduleConflict[]> {
  const conflicts: ScheduleConflict[] = []

  /* 1. approval gate (SC-3) */
  try {
    await assertPublishable(args.workspaceId, args.assetId)
  } catch (e) {
    conflicts.push({
      kind: 'approval',
      message: 'Not approved',
      detail: e instanceof Error ? e.message : 'Approval check failed.',
    })
  }

  /* 2. blackout windows (SC-5) */
  const blackouts = await db
    .select()
    .from(blackoutWindows)
    .where(
      and(
        eq(blackoutWindows.workspaceId, args.workspaceId),
        lte(blackoutWindows.startsAt, args.scheduledAt),
        gte(blackoutWindows.endsAt, args.scheduledAt),
      ),
    )
  for (const b of blackouts) {
    if (b.channels.length > 0 && !b.channels.includes(args.channel)) continue
    conflicts.push({
      kind: 'blackout',
      message: `Inside the "${b.name}" blackout window`,
      detail: b.reason ?? `${b.startsAt.toUTCString()} — ${b.endsAt.toUTCString()}`,
      suggestion: new Date(b.endsAt.getTime() + 3_600_000),
    })
  }

  /* 3. frequency caps (SC-5) */
  const [cap] = await db
    .select()
    .from(frequencyCaps)
    .where(
      and(eq(frequencyCaps.workspaceId, args.workspaceId), eq(frequencyCaps.channel, args.channel as Channel)),
    )
    .limit(1)

  if (cap && args.segmentId) {
    const windowStart = new Date(args.scheduledAt.getTime() - cap.windowDays * 86_400_000)
    const windowEnd = new Date(args.scheduledAt.getTime() + cap.windowDays * 86_400_000)
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(scheduleItems)
      .where(
        and(
          eq(scheduleItems.workspaceId, args.workspaceId),
          eq(scheduleItems.channel, args.channel as Channel),
          eq(scheduleItems.segmentId, args.segmentId),
          gte(scheduleItems.scheduledAt, windowStart),
          lte(scheduleItems.scheduledAt, windowEnd),
          ne(scheduleItems.status, 'cancelled'),
          args.ignoreScheduleItemId ? ne(scheduleItems.id, args.ignoreScheduleItemId) : sql`true`,
        ),
      )
    if ((row?.n ?? 0) >= cap.maxPerContact) {
      conflicts.push({
        kind: 'frequency',
        message: `Frequency cap reached`,
        detail: `This segment would receive ${(row?.n ?? 0) + 1} ${args.channel} messages in ${cap.windowDays} days; the cap is ${cap.maxPerContact}.`,
      })
    }
  }

  /* 4. same-segment same-hour collision (SC-1) */
  if (args.segmentId) {
    const hourStart = new Date(args.scheduledAt)
    hourStart.setMinutes(0, 0, 0)
    const hourEnd = new Date(hourStart.getTime() + 3_600_000)
    const collisions = await db
      .select({ id: scheduleItems.id, at: scheduleItems.scheduledAt })
      .from(scheduleItems)
      .where(
        and(
          eq(scheduleItems.workspaceId, args.workspaceId),
          eq(scheduleItems.segmentId, args.segmentId),
          gte(scheduleItems.scheduledAt, hourStart),
          lte(scheduleItems.scheduledAt, hourEnd),
          ne(scheduleItems.status, 'cancelled'),
          args.ignoreScheduleItemId ? ne(scheduleItems.id, args.ignoreScheduleItemId) : sql`true`,
        ),
      )
    if (collisions.length > 0) {
      conflicts.push({
        kind: 'collision',
        message: 'Another send to this segment is already in this hour',
        detail: `${collisions.length} item(s) already placed between ${hourStart.toISOString().slice(11, 16)} and ${hourEnd.toISOString().slice(11, 16)}.`,
        suggestion: new Date(hourEnd.getTime() + 3_600_000),
      })
    }
  }

  return conflicts
}

export async function scheduleAsset(args: {
  workspaceId: string
  actorId: string
  assetId: string
  segmentId?: string | null
  campaignId?: string | null
  /** Omit to let the model choose the slot (SC-2). */
  scheduledAt?: Date
  timezone?: string
  force?: boolean
}): Promise<{ id: string; scheduledAt: Date; source: 'ai' | 'manual'; rationale: string | null; lift: number | null }> {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, args.workspaceId), eq(assets.id, args.assetId)))
    .limit(1)
  if (!asset) throw new GateError('Asset not found.')

  // Gate first — SC-3 says an unapproved asset cannot be scheduled at all, and
  // force must never override the approval gate (only soft conflicts).
  await assertPublishable(args.workspaceId, args.assetId)

  // Addressed channels need an audience. Without this the item schedules
  // happily and only fails at send time with "no reachable recipients", which
  // surfaces as a dead letter hours later instead of an error the marketer can
  // act on now.
  if (ADDRESSED_CHANNELS.has(asset.channel)) {
    if (!args.segmentId) {
      throw new GateError(
        `${asset.channel === 'email' ? 'Email' : asset.channel.toUpperCase()} needs an audience. Choose a segment before scheduling.`,
      )
    }
    const reachable = await recipientCount(args.workspaceId, args.segmentId, asset.channel)
    if (reachable === 0) {
      throw new GateError(
        `That segment has no reachable contacts on ${asset.channel} — everyone in it is suppressed or has not consented to this channel. Pick a different audience.`,
      )
    }
  }

  let scheduledAt = args.scheduledAt
  let source: 'ai' | 'manual' = 'manual'
  let rationale: string | null = null
  let lift: number | null = null

  if (!scheduledAt) {
    const suggestion = await suggestSendTime({
      workspaceId: args.workspaceId,
      channel: asset.channel,
      segmentId: args.segmentId ?? null,
      notBefore: new Date(Date.now() + 3_600_000),
    })
    scheduledAt = nextOccurrence(suggestion.weekday, suggestion.hour)
    source = 'ai'
    rationale = suggestion.rationale
    lift = suggestion.predictedLift
  }

  const conflicts = await checkConflicts({
    workspaceId: args.workspaceId,
    assetId: args.assetId,
    channel: asset.channel,
    segmentId: args.segmentId,
    scheduledAt,
  })

  const hard = conflicts.filter((c) => c.kind === 'approval')
  if (hard.length > 0) throw new GateError(hard[0].detail ?? hard[0].message)

  if (conflicts.length > 0 && !args.force) {
    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: 'schedule.blocked',
      subjectType: 'asset',
      subjectId: args.assetId,
      summary: `Scheduling blocked: ${conflicts.map((c) => c.message).join('; ')}`,
      payload: { conflicts },
    })
    const err = new GateError(conflicts.map((c) => `${c.message}. ${c.detail ?? ''}`.trim()).join(' '))
    throw err
  }

  const [row] = await db
    .insert(scheduleItems)
    .values({
      workspaceId: args.workspaceId,
      campaignId: args.campaignId ?? asset.campaignId,
      assetId: args.assetId,
      segmentId: args.segmentId ?? null,
      channel: asset.channel,
      scheduledAt,
      timezone: args.timezone ?? 'Europe/London',
      status: 'scheduled',
      sendTimeSource: source,
      predictedLift: lift,
      sendTimeRationale: rationale,
      createdBy: args.actorId,
    })
    .returning({ id: scheduleItems.id })

  await db
    .update(assets)
    .set({ status: 'scheduled', stage: 'publish', updatedAt: new Date() })
    .where(eq(assets.id, args.assetId))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'schedule.created',
    subjectType: 'schedule_item',
    subjectId: row.id,
    summary: `"${asset.title}" scheduled for ${scheduledAt.toUTCString()} on ${asset.channel}${source === 'ai' ? ' (AI-selected slot)' : ''}.`,
    payload: { assetId: args.assetId, scheduledAt: scheduledAt.toISOString(), source, lift, forced: Boolean(args.force) },
  })

  return { id: row.id, scheduledAt, source, rationale, lift }
}

export async function rescheduleItem(args: {
  workspaceId: string
  actorId: string
  scheduleItemId: string
  toDate: Date
  force?: boolean
}) {
  const [item] = await db
    .select()
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, args.workspaceId), eq(scheduleItems.id, args.scheduleItemId)))
    .limit(1)
  if (!item) throw new GateError('Scheduled item not found.')
  if (item.status === 'published') throw new GateError('This item has already published.')

  const conflicts = await checkConflicts({
    workspaceId: args.workspaceId,
    assetId: item.assetId,
    channel: item.channel,
    segmentId: item.segmentId,
    scheduledAt: args.toDate,
    ignoreScheduleItemId: item.id,
  })

  const blocking = conflicts.filter((c) => c.kind === 'approval' || !args.force)
  if (blocking.length > 0) {
    throw new GateError(blocking.map((c) => `${c.message}. ${c.detail ?? ''}`.trim()).join(' '))
  }

  await db
    .update(scheduleItems)
    .set({ scheduledAt: args.toDate, sendTimeSource: 'manual', predictedLift: null, sendTimeRationale: null })
    .where(eq(scheduleItems.id, item.id))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'schedule.moved',
    subjectType: 'schedule_item',
    subjectId: item.id,
    summary: `Moved from ${item.scheduledAt.toUTCString()} to ${args.toDate.toUTCString()}.`,
    payload: { from: item.scheduledAt.toISOString(), to: args.toDate.toISOString() },
  })
}

export async function cancelScheduleItem(workspaceId: string, actorId: string, id: string) {
  const [item] = await db
    .select()
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, workspaceId), eq(scheduleItems.id, id)))
    .limit(1)
  if (!item) throw new GateError('Not found.')
  if (item.status === 'published') throw new GateError('Already published.')

  await db.update(scheduleItems).set({ status: 'cancelled' }).where(eq(scheduleItems.id, id))
  await db.update(assets).set({ status: 'approved', stage: 'approve' }).where(eq(assets.id, item.assetId))

  await recordAudit({
    workspaceId,
    actorId,
    action: 'schedule.moved',
    subjectType: 'schedule_item',
    subjectId: id,
    summary: 'Scheduled item cancelled; asset returned to approved.',
    payload: {},
  })
}

/** Reachable recipient count for a scheduled item, honouring consent. */
/**
 * How many people a send would actually reach, counted now.
 *
 * The segment carries a cached reachability figure from the last time it was
 * materialised, and that number is fine for showing a marketer the size of an
 * audience while they plan. It is not fine at send time: anyone who suppressed
 * or withdrew consent since that refresh is still in the cache, so trusting it
 * is what mails somebody who opted out.
 *
 * So this re-reads the members and applies suppression and per-channel consent
 * against their current state. It costs one indexed query per send, which is
 * nothing next to the alternative.
 */
export async function recipientCount(workspaceId: string, segmentId: string | null, channel: string): Promise<number> {
  if (!segmentId) return 0

  const consentKey = channel === 'email' || channel === 'sms' || channel === 'push' ? channel : null

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(segmentMembers)
    .innerJoin(
      contacts,
      and(eq(contacts.id, segmentMembers.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(segmentMembers.segmentId, segmentId),
        eq(contacts.suppressed, false),
        // Channels that address a person individually need consent for that
        // channel specifically. A published post has no recipient to consent.
        consentKey ? sql`(${contacts.consent} ->> ${consentKey})::boolean is true` : undefined,
      ),
    )

  return row?.n ?? 0
}

/** The planning-time figure, from the segment's own cache. Never used to send. */
export async function cachedReach(workspaceId: string, segmentId: string, channel: string): Promise<number> {
  const [seg] = await db
    .select({ reachability: segments.reachability, reachable: segments.reachableSize })
    .from(segments)
    .where(and(eq(segments.workspaceId, workspaceId), eq(segments.id, segmentId)))
    .limit(1)
  return seg ? (seg.reachability[channel] ?? seg.reachable) : 0
}

export function nextOccurrence(weekday: number, hour: number, from = new Date()): Date {
  const d = new Date(from)
  d.setMinutes(0, 0, 0)
  for (let i = 0; i < 8; i++) {
    const c = new Date(d)
    c.setDate(d.getDate() + i)
    c.setHours(hour, 0, 0, 0)
    if (c.getDay() === weekday && c.getTime() > from.getTime()) return c
  }
  const fallback = new Date(from.getTime() + 86_400_000)
  fallback.setHours(hour, 0, 0, 0)
  return fallback
}
