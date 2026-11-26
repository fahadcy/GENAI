import { NextResponse, type NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { socialAccounts } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { encryptToken, tokenHint } from '@/lib/crypto-secrets'
import { facebookTargets, linkedinTargets, verifyState, OAuthError, type ConnectedTarget } from '@/lib/social/oauth'
import { recordAudit } from '@/lib/workflow/audit'

/**
 * Where LinkedIn and Facebook send the person back after they approve access.
 *
 * This route is reachable by anyone, so it trusts nothing in the query string
 * except what the signed `state` proves: which workspace started the flow, for
 * which provider, and that it happened in the last fifteen minutes. Everything
 * else — the code, any `error` parameter — is treated as hostile input.
 *
 * It never renders anything. Success or failure, the person ends up back on the
 * connectors screen with a message, because a bare JSON error page at the end
 * of an OAuth redirect is a dead end for a non-technical user.
 */

export const dynamic = 'force-dynamic'

function back(message: string, tone: 'ok' | 'error'): NextResponse {
  const url = new URL('/settings/connectors', env().APP_URL)
  url.searchParams.set('connect', tone)
  url.searchParams.set('message', message)
  return NextResponse.redirect(url)
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await context.params
  if (provider !== 'linkedin' && provider !== 'facebook') {
    return back('Unknown provider.', 'error')
  }

  const params = request.nextUrl.searchParams

  // The person pressed Cancel, or the platform refused. Both arrive here.
  const denied = params.get('error')
  if (denied) {
    const description = params.get('error_description') ?? params.get('error_reason') ?? denied
    return back(
      denied === 'user_cancelled_login' || denied === 'access_denied'
        ? 'Connection cancelled — nothing was changed.'
        : `${provider === 'linkedin' ? 'LinkedIn' : 'Facebook'} refused the connection: ${description}`,
      'error',
    )
  }

  const state = params.get('state')
  const code = params.get('code')
  if (!state || !code) return back('That connection link was incomplete. Start again from Settings.', 'error')

  const parsed = verifyState(state)
  if (!parsed || parsed.provider !== provider) {
    return back(
      'That connection link is no longer valid — it may have expired or been tampered with. Start again from Settings.',
      'error',
    )
  }

  let targets: ConnectedTarget[]
  try {
    targets =
      provider === 'linkedin'
        ? await linkedinTargets(code, parsed.kind)
        : await facebookTargets(code)
  } catch (error) {
    return back(
      error instanceof OAuthError ? error.message : 'Could not complete the connection. Please try again.',
      'error',
    )
  }

  const channel = provider === 'linkedin' ? 'linkedin' : 'facebook'

  // Whether this workspace already posts somewhere on this channel decides
  // whether a newly connected account should take over by default.
  const [existingDefault] = await db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.workspaceId, parsed.workspaceId),
        eq(socialAccounts.channel, channel),
        eq(socialAccounts.isDefault, true),
      ),
    )
    .limit(1)

  let first = true
  for (const target of targets) {
    const values = {
      workspaceId: parsed.workspaceId,
      provider,
      channel,
      kind: target.kind,
      externalId: target.externalId,
      authorUrn: target.authorUrn ?? null,
      displayName: target.displayName,
      avatarUrl: target.avatarUrl ?? null,
      accessTokenEnc: encryptToken(target.accessToken),
      tokenHint: tokenHint(target.accessToken),
      expiresAt: target.expiresAt,
      scopes: target.scopes,
      status: 'connected' as const,
      lastError: null,
      isDefault: !existingDefault && first,
      updatedAt: new Date(),
    }

    await db
      .insert(socialAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [socialAccounts.workspaceId, socialAccounts.provider, socialAccounts.externalId],
        // Reconnecting refreshes the credential and clears any previous error,
        // but must not silently steal the default away from another account.
        set: { ...values, isDefault: undefined },
      })
    first = false
  }

  await recordAudit({
    workspaceId: parsed.workspaceId,
    actorType: 'system',
    action: 'social.connected',
    subjectType: 'social_account',
    summary: `Connected ${targets.length} ${provider === 'linkedin' ? 'LinkedIn' : 'Facebook'} destination${
      targets.length === 1 ? '' : 's'
    }: ${targets.map((t) => t.displayName).join(', ')}.`,
    payload: { provider, kinds: targets.map((t) => t.kind) },
  })

  const names = targets.map((t) => t.displayName).join(', ')
  return back(
    targets.length === 1
      ? `Connected ${names}. Posts on this channel will now publish there for real.`
      : `Connected ${targets.length} destinations: ${names}. Choose which one posts should go to.`,
    'ok',
  )
}
