'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { socialAccounts } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { authorizeUrl } from '@/lib/social/oauth'
import { socialConfigured, socialMissing } from '@/lib/env'
import { recordAudit } from '@/lib/workflow/audit'
import type { ActionResult } from './content'

/**
 * Connecting and managing the accounts posts are published to.
 *
 * None of these ever return a token. The connect action returns a URL the
 * browser is sent to; the tokens arrive on the callback route, are encrypted
 * before they touch the database, and are only ever decrypted inside the
 * publisher.
 */

export async function beginConnectAction(input: {
  provider: 'linkedin' | 'facebook'
  /** LinkedIn only: posting as the person, or as a company page. */
  kind?: 'member' | 'organization'
}): Promise<ActionResult<{ url: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can connect accounts.' }
  }

  if (!socialConfigured(input.provider)) {
    const missing = socialMissing(input.provider).join(', ')
    return {
      ok: false,
      message: `${input.provider === 'linkedin' ? 'LinkedIn' : 'Facebook'} is not set up on the server yet. Missing: ${missing}.`,
    }
  }

  const kind = input.provider === 'facebook' ? 'page' : (input.kind ?? 'member')
  return {
    ok: true,
    message: 'Redirecting…',
    data: { url: authorizeUrl(input.provider, auth.workspace.id, kind) },
  }
}

/** Choose which account a channel publishes through when several are connected. */
export async function setDefaultAccountAction(id: string): Promise<ActionResult<null>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can change this.' }
  }

  const [account] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, auth.workspace.id), eq(socialAccounts.id, id)))
    .limit(1)
  if (!account) return { ok: false, message: 'That account is no longer connected.' }

  await db.transaction(async (tx) => {
    // Exactly one default per channel, enforced here rather than hoped for.
    await tx
      .update(socialAccounts)
      .set({ isDefault: false })
      .where(
        and(
          eq(socialAccounts.workspaceId, auth.workspace.id),
          eq(socialAccounts.channel, account.channel),
          ne(socialAccounts.id, id),
        ),
      )
    await tx.update(socialAccounts).set({ isDefault: true, updatedAt: new Date() }).where(eq(socialAccounts.id, id))
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'social.default_changed',
    subjectType: 'social_account',
    subjectId: id,
    summary: `${account.channel} posts will now publish to "${account.displayName}".`,
  })

  revalidatePath('/settings/connectors')
  return { ok: true, message: `${account.displayName} is now where ${account.channel} posts go.`, data: null }
}

export async function disconnectAccountAction(id: string): Promise<ActionResult<null>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can disconnect accounts.' }
  }

  const [account] = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, auth.workspace.id), eq(socialAccounts.id, id)))
    .limit(1)
  if (!account) return { ok: false, message: 'That account is already disconnected.' }

  // Deleted outright rather than flagged: the row's only real content is a
  // credential, and keeping a revoked one serves nobody. The audit trail
  // records that it existed and when it went.
  await db.delete(socialAccounts).where(eq(socialAccounts.id, id))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'social.disconnected',
    subjectType: 'social_account',
    subjectId: id,
    summary: `Disconnected "${account.displayName}" (${account.provider}). Scheduled ${account.channel} posts will fall back to the simulator until another account is connected.`,
    payload: { provider: account.provider, externalId: account.externalId },
  })

  revalidatePath('/settings/connectors')
  revalidatePath('/scheduler')
  return { ok: true, message: `Disconnected ${account.displayName}.`, data: null }
}
