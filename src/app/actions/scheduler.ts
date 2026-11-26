'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { scheduleItems } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import {
  cancelScheduleItem,
  checkConflicts,
  rescheduleItem,
  scheduleAsset,
  nextOccurrence,
  type ScheduleConflict,
} from '@/lib/scheduler/schedule'
import { publishDue, publishOne, replayDeadLetter } from '@/lib/scheduler/publish'
import { suggestSendTime } from '@/lib/scheduler/sendtime'
import { GateError } from '@/lib/workflow/approvals'
import type { ActionResult } from './content'

export type RescheduleResult =
  | { ok: true; message: string }
  | { ok: false; message: string; conflicts: ScheduleConflict[] }

export async function scheduleAssetAction(input: {
  assetId: string
  segmentId?: string | null
  scheduledAt?: string
  force?: boolean
}): Promise<ActionResult<{ scheduledAt: string; source: string; rationale: string | null }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:create')
  } catch {
    return { ok: false, message: 'Your role cannot schedule work.' }
  }

  try {
    const r = await scheduleAsset({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      assetId: input.assetId,
      segmentId: input.segmentId ?? null,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
      timezone: auth.workspace.settings.defaultTimezone,
      force: input.force,
    })
    revalidatePath('/scheduler')
    revalidatePath('/studio')
    revalidatePath('/command-center')
    return {
      ok: true,
      message:
        r.source === 'ai'
          ? `Placed at ${r.scheduledAt.toUTCString()} — the modelled best slot${r.lift ? ` (+${Math.round(r.lift * 100)}%)` : ''}.`
          : `Scheduled for ${r.scheduledAt.toUTCString()}.`,
      data: { scheduledAt: r.scheduledAt.toISOString(), source: r.source, rationale: r.rationale },
    }
  } catch (e) {
    return { ok: false, message: e instanceof GateError ? e.message : 'Could not schedule this asset.' }
  }
}

/**
 * Returns the structured conflicts alongside the message so the caller can
 * render one row per conflict with its kind, rather than parsing a concatenated
 * sentence back apart.
 */
export async function rescheduleAction(
  scheduleItemId: string,
  toIso: string,
  force?: boolean,
): Promise<RescheduleResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:edit')
  } catch {
    return { ok: false, message: 'Your role cannot move scheduled items.', conflicts: [] }
  }

  const [item] = await db
    .select({ assetId: scheduleItems.assetId, channel: scheduleItems.channel, segmentId: scheduleItems.segmentId })
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, auth.workspace.id), eq(scheduleItems.id, scheduleItemId)))
    .limit(1)
  if (!item) return { ok: false, message: 'Scheduled item not found.', conflicts: [] }

  try {
    await rescheduleItem({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      scheduleItemId,
      toDate: new Date(toIso),
      force,
    })
    revalidatePath('/scheduler')
    return { ok: true, message: 'Moved.' }
  } catch (e) {
    // Re-derive the conflicts so the caller can render one row per reason.
    const conflicts = await checkConflicts({
      workspaceId: auth.workspace.id,
      assetId: item.assetId,
      channel: item.channel,
      segmentId: item.segmentId,
      scheduledAt: new Date(toIso),
      ignoreScheduleItemId: scheduleItemId,
    })
    return {
      ok: false,
      message: e instanceof GateError ? e.message : 'Could not move this item.',
      conflicts,
    }
  }
}

export async function cancelScheduleAction(scheduleItemId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:edit')
  } catch {
    return { ok: false, message: 'Your role cannot cancel scheduled items.' }
  }
  try {
    await cancelScheduleItem(auth.workspace.id, auth.user.id, scheduleItemId)
    revalidatePath('/scheduler')
    return { ok: true, message: 'Cancelled. The asset is back in the approved pool.' }
  } catch (e) {
    return { ok: false, message: e instanceof GateError ? e.message : 'Could not cancel.' }
  }
}

export async function conflictsForAction(input: {
  assetId: string
  channel: string
  segmentId?: string | null
  scheduledAt: string
  /**
   * Exclude an item from collision and frequency-cap counting. Without this,
   * previewing conflicts at an item's own slot reports the item colliding with
   * itself and over-counts the frequency cap by one.
   */
  ignoreScheduleItemId?: string
}): Promise<ScheduleConflict[]> {
  const auth = await requireAuth()
  return checkConflicts({
    workspaceId: auth.workspace.id,
    assetId: input.assetId,
    channel: input.channel,
    segmentId: input.segmentId ?? null,
    scheduledAt: new Date(input.scheduledAt),
    ignoreScheduleItemId: input.ignoreScheduleItemId,
  })
}

/**
 * Returns a concrete instant as well as the weekday/hour, so callers do not have
 * to re-derive `nextOccurrence` client-side and risk drifting from the server's
 * idea of the next valid slot.
 */
export async function suggestSendTimeAction(channel: string, segmentId?: string | null) {
  const auth = await requireAuth()
  const notBefore = new Date(Date.now() + 3_600_000)
  const s = await suggestSendTime({
    workspaceId: auth.workspace.id,
    channel,
    segmentId: segmentId ?? null,
    notBefore,
  })
  return { ...s, scheduledAtIso: nextOccurrence(s.weekday, s.hour, notBefore).toISOString() }
}

/** Runs the publish worker on demand — SC-4 without waiting for cron. */
export async function runPublisherAction(): Promise<ActionResult<{ published: number; failed: number }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:publish')
  } catch {
    return { ok: false, message: 'Your role cannot publish.' }
  }
  const outcomes = await publishDue(auth.workspace.id, 25)
  revalidatePath('/scheduler')
  revalidatePath('/command-center')
  const published = outcomes.filter((o) => o.status === 'published').length
  const failed = outcomes.filter((o) => o.status !== 'published').length
  return {
    ok: true,
    message:
      outcomes.length === 0
        ? 'Nothing was due.'
        : `${published} published, ${failed} needing another attempt.`,
    data: { published, failed },
  }
}

export async function publishNowAction(scheduleItemId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:publish')
  } catch {
    return { ok: false, message: 'Your role cannot publish.' }
  }
  const outcome = await publishOne(auth.workspace.id, scheduleItemId)
  revalidatePath('/scheduler')
  return { ok: outcome.status === 'published', message: outcome.message }
}

export async function replayAction(scheduleItemId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'schedule:publish')
  } catch {
    return { ok: false, message: 'Your role cannot replay failed publishes.' }
  }
  const outcome = await replayDeadLetter(auth.workspace.id, auth.user.id, scheduleItemId)
  revalidatePath('/scheduler')
  return { ok: outcome.status === 'published', message: outcome.message }
}
