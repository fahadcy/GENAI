import 'server-only'
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { assets, connectors, scheduleItems } from '@/lib/db/schema'
import { adapterFor, defaultProviderFor, type PublishResult } from '@/lib/connectors/adapter'
import { accountFor, publishToSocial } from '@/lib/social/publish'
import { deliver, liveDeliveryFor } from '@/lib/channels/deliver'
import { assertPublishable } from '@/lib/workflow/approvals'
import { recordAudit } from '@/lib/workflow/audit'
import { recipientCount } from './schedule'

/**
 * Publishing pipeline (PRD SC-4 and the 99.9% reliability NFR:
 * "publishing retries with dead-letter handling so a channel outage never
 * loses a post").
 *
 * Retry uses exponential backoff with a cap. After MAX_ATTEMPTS the item moves
 * to `dead_letter` — visible, replayable, never silently dropped.
 */

const MAX_ATTEMPTS = 5

/** Channels that can be published to a real social network. */
const SOCIAL_CHANNELS = new Set(['linkedin', 'facebook'])

/** What the audit trail should name when a send was real rather than simulated. */
const LIVE_PROVIDER = { email: 'sendgrid', sms: 'clicksend', blog: 'wordpress' } as const
const BASE_BACKOFF_MS = 30_000

export type PublishOutcome = {
  scheduleItemId: string
  status: 'published' | 'retrying' | 'dead_letter' | 'blocked'
  message: string
}

export async function publishDue(workspaceId: string, limit = 25): Promise<PublishOutcome[]> {
  const now = new Date()
  const due = await db
    .select()
    .from(scheduleItems)
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        or(
          and(eq(scheduleItems.status, 'scheduled'), lte(scheduleItems.scheduledAt, now)),
          and(eq(scheduleItems.status, 'failed'), lte(scheduleItems.nextRetryAt, now)),
        ),
      ),
    )
    .orderBy(scheduleItems.scheduledAt)
    .limit(limit)

  const outcomes: PublishOutcome[] = []
  for (const item of due) {
    outcomes.push(await publishOne(workspaceId, item.id))
  }
  return outcomes
}

export async function publishOne(workspaceId: string, scheduleItemId: string): Promise<PublishOutcome> {
  const [item] = await db
    .select()
    .from(scheduleItems)
    .where(and(eq(scheduleItems.workspaceId, workspaceId), eq(scheduleItems.id, scheduleItemId)))
    .limit(1)

  if (!item) return { scheduleItemId, status: 'blocked', message: 'Scheduled item not found.' }
  if (item.status === 'published') {
    return { scheduleItemId, status: 'published', message: 'Already published.' }
  }
  if (item.status === 'cancelled') {
    return { scheduleItemId, status: 'blocked', message: 'Item is cancelled.' }
  }

  /* The gate is re-checked at publish time, not only at schedule time: an
     approval can be revoked or the asset edited in between. */
  let asset
  try {
    asset = await assertPublishable(workspaceId, item.assetId)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Approval gate failed.'
    await db
      .update(scheduleItems)
      .set({ status: 'cancelled', lastError: message })
      .where(eq(scheduleItems.id, item.id))
    await recordAudit({
      workspaceId,
      actorType: 'system',
      action: 'publish.failed',
      subjectType: 'schedule_item',
      subjectId: item.id,
      summary: `Publish refused by the approval gate: ${message}`,
      payload: { assetId: item.assetId },
    })
    return { scheduleItemId, status: 'blocked', message }
  }

  await db.update(scheduleItems).set({ status: 'publishing' }).where(eq(scheduleItems.id, item.id))

  const provider = await providerFor(workspaceId, item.channel)
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.provider, provider)))
    .limit(1)

  const recipients = await recipientCount(workspaceId, item.segmentId, item.channel)
  const attempt = item.attempts

  /**
   * A connected LinkedIn or Facebook account takes precedence over the
   * simulator. This is the only place the choice is made, so a post cannot
   * reach a real network by any path that skipped the approval gate above.
   */
  const social = SOCIAL_CHANNELS.has(item.channel) ? await accountFor(workspaceId, item.channel) : null

  /**
   * Email and SMS go out for real only when the account is configured for it.
   * `liveDeliveryFor` returns null otherwise and the simulator runs instead —
   * which is why nothing here has to be turned off to demo the product.
   */
  const delivery = social ? null : liveDeliveryFor(item.channel)

  const result: PublishResult = social
    ? await publishToSocial({ workspaceId, account: social, asset, attempt }).then((r) =>
        r.ok
          ? { ok: true as const, externalRef: r.externalRef, acceptedRecipients: 1 }
          : { ok: false as const, retryable: r.retryable, error: r.error },
      )
    : delivery
      ? await deliver({ workspaceId, channel: delivery, segmentId: item.segmentId, asset })
      : await adapterFor(provider).publish({
          asset,
          recipients,
          scheduledAt: item.scheduledAt,
          connector: connector ?? null,
          attempt,
        })

  /* What the timeline should name. A live send must never be attributed to
     the connector the workspace happens to have listed. */
  const reportedProvider = delivery ? LIVE_PROVIDER[delivery] : provider

  if (result.ok) {
    const publishedAt = new Date()
    // Live delivery counts the people it actually reached; the simulator can
    // only report the planned figure.
    const reached = delivery ? result.acceptedRecipients : recipients
    await db
      .update(scheduleItems)
      .set({
        status: 'published',
        publishedAt,
        externalRef: result.externalRef,
        attempts: attempt + 1,
        lastError: null,
        nextRetryAt: null,
      })
      .where(eq(scheduleItems.id, item.id))

    await db
      .update(assets)
      .set({ status: 'published', stage: 'monitor', updatedAt: publishedAt })
      .where(eq(assets.id, item.assetId))

    await recordAudit({
      workspaceId,
      actorType: 'system',
      action: 'publish.succeeded',
      subjectType: 'schedule_item',
      subjectId: item.id,
      summary: `"${asset.title}" published to ${item.channel} via ${reportedProvider}${reached ? ` (${reached.toLocaleString()} recipients)` : ''}${result.note ? ` — ${result.note}` : ''}.`,
      payload: {
        externalRef: result.externalRef,
        provider: reportedProvider,
        recipients: reached,
        live: Boolean(delivery || social),
        note: result.note,
        attempts: attempt + 1,
      },
    })

    return {
      scheduleItemId,
      status: 'published',
      message: `Published to ${item.channel}.${result.note ? ` ${capitalise(result.note)}.` : ''}`,
    }
  }

  /* ---------------------------------------------------------- failure */
  const attempts = attempt + 1
  const terminal = !result.retryable || attempts >= MAX_ATTEMPTS

  if (terminal) {
    await db
      .update(scheduleItems)
      .set({ status: 'dead_letter', attempts, lastError: result.error, nextRetryAt: null })
      .where(eq(scheduleItems.id, item.id))

    await recordAudit({
      workspaceId,
      actorType: 'system',
      action: 'publish.dead_letter',
      subjectType: 'schedule_item',
      subjectId: item.id,
      summary: `Publishing "${asset.title}" to ${item.channel} failed permanently after ${attempts} attempt(s): ${result.error}`,
      payload: { provider: reportedProvider, error: result.error, attempts, retryable: result.retryable },
    })
    return { scheduleItemId, status: 'dead_letter', message: result.error }
  }

  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, 30 * 60_000)
  await db
    .update(scheduleItems)
    .set({
      status: 'failed',
      attempts,
      lastError: result.error,
      nextRetryAt: new Date(Date.now() + backoff),
    })
    .where(eq(scheduleItems.id, item.id))

  await recordAudit({
    workspaceId,
    actorType: 'system',
    action: 'publish.failed',
    subjectType: 'schedule_item',
    subjectId: item.id,
    summary: `Attempt ${attempts} to publish "${asset.title}" failed: ${result.error} Retrying in ${Math.round(backoff / 1000)}s.`,
    payload: { provider: reportedProvider, error: result.error, attempts, backoffMs: backoff },
  })

  return { scheduleItemId, status: 'retrying', message: `${result.error} Retry in ${Math.round(backoff / 1000)}s.` }
}

/** Operator action: push a dead-lettered item back into the queue. */
export async function replayDeadLetter(workspaceId: string, actorId: string, scheduleItemId: string) {
  await db
    .update(scheduleItems)
    .set({ status: 'scheduled', attempts: 0, lastError: null, nextRetryAt: null })
    .where(
      and(
        eq(scheduleItems.workspaceId, workspaceId),
        eq(scheduleItems.id, scheduleItemId),
        inArray(scheduleItems.status, ['dead_letter', 'failed']),
      ),
    )
  await recordAudit({
    workspaceId,
    actorId,
    action: 'schedule.moved',
    subjectType: 'schedule_item',
    subjectId: scheduleItemId,
    summary: 'Dead-lettered item replayed into the publish queue.',
    payload: {},
  })
  return publishOne(workspaceId, scheduleItemId)
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function providerFor(workspaceId: string, channel: string): Promise<string> {
  const rows = await db
    .select({ provider: connectors.provider })
    .from(connectors)
    .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.status, 'connected')))
  const { connectorsForChannel } = await import('@/lib/connectors/registry')
  const candidates = connectorsForChannel(channel).map((c) => c.provider)
  const connected = rows.find((r) => candidates.includes(r.provider))
  return connected?.provider ?? defaultProviderFor(channel)
}

/** Queue health for the Command Center and the scheduler's status strip. */
export async function queueHealth(workspaceId: string) {
  const [row] = await db
    .select({
      scheduled: sql<number>`count(*) filter (where ${scheduleItems.status} = 'scheduled')::int`,
      failed: sql<number>`count(*) filter (where ${scheduleItems.status} = 'failed')::int`,
      deadLetter: sql<number>`count(*) filter (where ${scheduleItems.status} = 'dead_letter')::int`,
      published: sql<number>`count(*) filter (where ${scheduleItems.status} = 'published')::int`,
      dueNow: sql<number>`count(*) filter (where ${scheduleItems.status} = 'scheduled' and ${scheduleItems.scheduledAt} <= now())::int`,
    })
    .from(scheduleItems)
    .where(eq(scheduleItems.workspaceId, workspaceId))
  return (
    row ?? { scheduled: 0, failed: 0, deadLetter: 0, published: 0, dueNow: 0 }
  )
}
