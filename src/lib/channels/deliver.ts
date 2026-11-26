import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaces } from '@/lib/db/schema'
import type { Asset } from '@/lib/db/schema'
import type { PublishResult } from '@/lib/connectors/adapter'
import { hasClickSend, hasSendGrid, hasWordPress } from '@/lib/env'
import { sendEmail } from './sendgrid'
import { sendSms } from './clicksend'
import { publishToBlog } from './wordpress'

/**
 * The one place that decides whether an email, a text or a blog post actually
 * leaves the building.
 *
 * The publisher asks this first. A null answer means "no live delivery is
 * configured for this channel" and the caller falls back to the simulator —
 * which is the honest outcome, because the audit trail then records a
 * simulated send rather than claiming a real one.
 *
 * Two things are deliberately *not* decided here: whether the asset is
 * approved (the gate runs before this is called) and who the recipients are
 * (each adapter resolves those itself, against live suppression, at the moment
 * of sending). This function only routes.
 */

export type DeliveryChannel = 'email' | 'sms' | 'blog'

/** Channels this module can deliver for real, given the current configuration. */
export function liveDeliveryFor(channel: string): DeliveryChannel | null {
  if (channel === 'email' && hasSendGrid()) return 'email'
  if (channel === 'sms' && hasClickSend()) return 'sms'
  // 'web' is the same destination under a different name in the channel list.
  if ((channel === 'blog' || channel === 'web') && hasWordPress()) return 'blog'
  return null
}

export async function deliver(args: {
  workspaceId: string
  channel: DeliveryChannel
  segmentId: string | null
  asset: Pick<Asset, 'id' | 'title' | 'body'>
}): Promise<PublishResult> {
  /* A blog post has no audience to resolve: it goes to one website. */
  if (args.channel === 'blog') {
    const out = await publishToBlog({ asset: args.asset })
    if (!out.ok) {
      return { ok: false, retryable: out.retryable, error: out.error ?? 'The website refused the post.' }
    }
    const draft = out.status !== 'publish'
    return {
      ok: true,
      externalRef: out.url ?? `wordpress_${out.postId}`,
      // A page has readers, not recipients. Reporting a number here would be
      // an invention.
      acceptedRecipients: 0,
      note: draft
        ? 'saved as a draft on the website — open it and press Publish once the page looks right. Set WORDPRESS_POST_STATUS="publish" to skip that step in future.'
        : 'live on the website',
    }
  }

  /* Email and SMS address individual people. Without a segment there is no
     list, and sending to "everyone by default" is exactly the mistake that
     costs money and goodwill — so it is refused, permanently, not retried. */
  if (!args.segmentId) {
    return {
      ok: false,
      retryable: false,
      error: `A ${args.channel === 'sms' ? 'text message' : 'email'} needs an audience. Pick a segment before scheduling it.`,
    }
  }

  const senderName = await workspaceName(args.workspaceId)

  if (args.channel === 'email') {
    const out = await sendEmail({
      workspaceId: args.workspaceId,
      segmentId: args.segmentId,
      asset: args.asset,
      senderName,
    })
    return out.ok
      ? {
          ok: true,
          // SendGrid's own batch id when it gave one, so a support ticket can
          // be traced; otherwise something stable enough to find in the log.
          externalRef: out.messageId ?? `sendgrid_${args.asset.id}`,
          acceptedRecipients: out.accepted,
        }
      : { ok: false, retryable: out.retryable, error: out.error ?? 'SendGrid refused the send.' }
  }

  const out = await sendSms({
    workspaceId: args.workspaceId,
    segmentId: args.segmentId,
    asset: args.asset,
  })

  /* A partial SMS failure is still a success: the messages that went are gone
     and billed. Retrying the whole batch would text everyone twice, so the
     rejections are reported rather than replayed. */
  return out.ok
    ? {
        ok: true,
        externalRef: `clicksend_${args.asset.id}`,
        acceptedRecipients: out.accepted,
        note: smsNote(out.cost, out.failed),
      }
    : { ok: false, retryable: out.retryable, error: out.error ?? 'ClickSend refused the send.' }
}

/** Real spend, in words, because a texting bill should never be a surprise. */
function smsNote(cost: number, failed: number): string | undefined {
  const parts: string[] = []
  if (cost > 0) parts.push(`cost ${cost.toFixed(4)} on the ClickSend account`)
  if (failed > 0) parts.push(`${failed} number${failed === 1 ? '' : 's'} rejected by the carrier`)
  return parts.length > 0 ? parts.join('; ') : undefined
}

async function workspaceName(workspaceId: string): Promise<string> {
  const [row] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row?.name ?? 'Aurea'
}
