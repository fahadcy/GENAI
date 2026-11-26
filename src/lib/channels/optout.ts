import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts, workspaces } from '@/lib/db/schema'
import { recordAudit } from '@/lib/workflow/audit'
import { verifyUnsubscribeToken } from './unsubscribe'

/**
 * Recording an opt-out.
 *
 * Two things matter here and both are easy to get subtly wrong.
 *
 * It has to be idempotent. Mail clients prefetch links, people click twice, and
 * one-click unsubscribe fires a POST that may be retried. Someone who has
 * already opted out must see a calm confirmation, not an error and not a second
 * audit entry claiming they did it again.
 *
 * And it must not confirm or deny anything to a bad token. A response that
 * distinguishes "no such contact" from "already unsubscribed" turns this public
 * endpoint into a way of testing whether an address is on someone's list.
 */

export type OptOutResult = {
  ok: boolean
  /** Shown to the person. Never reveals whether the address exists. */
  message: string
  /** Who they opted out of, when we could determine it. */
  senderName?: string
  alreadyDone?: boolean
}

const GENERIC_FAILURE: OptOutResult = {
  ok: false,
  message:
    'This unsubscribe link is not valid. It may have been altered in transit. Reply to the email you received and ask to be removed, and that will be actioned.',
}

export async function applyOptOut(token: string, source: 'link' | 'one-click'): Promise<OptOutResult> {
  const claim = verifyUnsubscribeToken(token)
  if (!claim) return GENERIC_FAILURE

  const [row] = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      suppressed: contacts.suppressed,
      consent: contacts.consent,
      workspaceName: workspaces.name,
    })
    .from(contacts)
    .innerJoin(workspaces, eq(workspaces.id, contacts.workspaceId))
    .where(and(eq(contacts.id, claim.contactId), eq(contacts.workspaceId, claim.workspaceId)))
    .limit(1)

  // A valid signature over a contact that no longer exists: say the same thing
  // as success. They are not on the list, which is what they wanted.
  if (!row) {
    return { ok: true, message: 'You have been unsubscribed. You will not receive any further marketing from this sender.' }
  }

  if (row.suppressed) {
    return {
      ok: true,
      alreadyDone: true,
      senderName: row.workspaceName,
      message: 'You were already unsubscribed. Nothing further will be sent.',
    }
  }

  /**
   * Withdraw consent as well as suppressing. Suppression alone would stop the
   * sending, but the consent record is what the segment engine reads and what
   * would be produced as evidence if anyone ever asked on what basis this
   * person was being emailed.
   */
  const consent = {
    ...row.consent,
    ...(claim.channel === 'all'
      ? { email: false, sms: false, push: false }
      : { [claim.channel]: false }),
  }

  await db
    .update(contacts)
    .set({
      suppressed: true,
      suppressionReason:
        claim.channel === 'all'
          ? 'Unsubscribed from all marketing'
          : `Unsubscribed from ${claim.channel}`,
      consent,
    })
    .where(eq(contacts.id, row.id))

  await recordAudit({
    workspaceId: claim.workspaceId,
    actorType: 'system',
    action: 'contact.unsubscribed',
    subjectType: 'contact',
    subjectId: row.id,
    summary: `${row.email ?? 'A contact'} unsubscribed from ${claim.channel === 'all' ? 'all marketing' : claim.channel} via ${source === 'one-click' ? 'their mail client' : 'the unsubscribe link'}.`,
    payload: { channel: claim.channel, source },
  })

  return {
    ok: true,
    senderName: row.workspaceName,
    message: 'You have been unsubscribed. You will not receive any further marketing from this sender.',
  }
}
