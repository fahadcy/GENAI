import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Connecting a LinkedIn or Facebook account.
 *
 * Both are ordinary OAuth 2.0 authorisation-code flows, but they differ in what
 * you get at the end, and the difference shapes everything downstream:
 *
 *   LinkedIn hands back one token that acts for the signed-in member. Posting
 *   as a *company page* needs a second scope that LinkedIn grants only after a
 *   manual review, so a connection can legitimately succeed while offering
 *   personal posting and nothing else.
 *
 *   Facebook hands back a short-lived user token. That is not what you publish
 *   with. It gets exchanged for a long-lived user token, which is then used to
 *   list the Pages the person administers — and each Page carries its own
 *   token, which is the one that actually posts. Page tokens derived this way
 *   do not expire, which is why they are worth encrypting properly.
 */

export type Provider = 'linkedin' | 'facebook'

/* ------------------------------------------------------------------ state */

/**
 * The `state` parameter, signed rather than stored.
 *
 * It has to survive a round trip through the platform's servers and come back
 * proving three things: the request started here, it started in this workspace,
 * and it is recent. An HMAC over those facts does that without a database row
 * that would need cleaning up, and without a cookie that a stricter
 * SameSite policy might drop on the redirect back.
 */
export function signState(workspaceId: string, provider: Provider, kind: string): string {
  const nonce = randomBytes(9).toString('base64url')
  const issued = Date.now().toString(36)
  const body = [workspaceId, provider, kind, issued, nonce].join('~')
  const mac = createHmac('sha256', env().AUTH_SECRET).update(body).digest('base64url').slice(0, 32)
  return `${Buffer.from(body).toString('base64url')}.${mac}`
}

export type ParsedState = { workspaceId: string; provider: Provider; kind: string }

const STATE_TTL_MS = 15 * 60 * 1000

export function verifyState(state: string): ParsedState | null {
  const [encoded, mac] = state.split('.')
  if (!encoded || !mac) return null

  let body: string
  try {
    body = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', env().AUTH_SECRET).update(body).digest('base64url').slice(0, 32)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const [workspaceId, provider, kind, issued] = body.split('~')
  if (!workspaceId || (provider !== 'linkedin' && provider !== 'facebook')) return null
  // A stale state is a replayed or abandoned attempt; start again rather than
  // completing a connection someone walked away from a day ago.
  if (Date.now() - parseInt(issued, 36) > STATE_TTL_MS) return null

  return { workspaceId, provider, kind }
}

/* -------------------------------------------------------------- redirects */

export function redirectUri(provider: Provider): string {
  return `${env().APP_URL.replace(/\/$/, '')}/api/connect/${provider}/callback`
}

/**
 * LinkedIn scopes.
 *
 * `w_member_social` is self-serve and posts as the person. `w_organization_social`
 * posts as a company page and requires LinkedIn to approve the application
 * first — asking for it before approval makes the whole authorisation fail, so
 * the two are requested separately depending on what is being connected.
 */
const LINKEDIN_SCOPES = {
  member: ['openid', 'profile', 'w_member_social'],
  organization: ['openid', 'profile', 'r_organization_admin', 'w_organization_social'],
} as const

const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']

export function authorizeUrl(provider: Provider, workspaceId: string, kind: 'member' | 'organization' | 'page'): string {
  const e = env()
  const state = signState(workspaceId, provider, kind)

  if (provider === 'linkedin') {
    const scopes = kind === 'organization' ? LINKEDIN_SCOPES.organization : LINKEDIN_SCOPES.member
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: e.LINKEDIN_CLIENT_ID ?? '',
      redirect_uri: redirectUri('linkedin'),
      state,
      scope: scopes.join(' '),
    })
    return `https://www.linkedin.com/oauth/v2/authorization?${params}`
  }

  const params = new URLSearchParams({
    client_id: e.META_APP_ID ?? '',
    redirect_uri: redirectUri('facebook'),
    state,
    response_type: 'code',
    scope: META_SCOPES.join(','),
  })
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`
}

/* ----------------------------------------------------------------- Graph */

/**
 * Meta versions its API and retires each version after roughly two years. An
 * unpinned client breaks on a date nobody wrote down, so the version is a
 * single named constant that the health check can report.
 */
export const GRAPH_VERSION = 'v25.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

/** LinkedIn versions by month and expects it on every request. */
export const LINKEDIN_VERSION = '202602'

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly detail: { provider: Provider; status?: number; raw?: unknown },
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

/* --------------------------------------------------------------- LinkedIn */

export type ConnectedTarget = {
  externalId: string
  displayName: string
  avatarUrl?: string | null
  /** LinkedIn only. */
  authorUrn?: string
  accessToken: string
  expiresAt: Date | null
  scopes: string[]
  kind: 'member' | 'organization' | 'page'
}

async function linkedinToken(code: string): Promise<{ token: string; expiresIn: number; scope: string }> {
  const e = env()
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri('linkedin'),
      client_id: e.LINKEDIN_CLIENT_ID ?? '',
      client_secret: e.LINKEDIN_CLIENT_SECRET ?? '',
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    scope?: string
    error_description?: string
    error?: string
  }
  if (!res.ok || !body.access_token) {
    throw new OAuthError(
      `LinkedIn would not complete the connection: ${body.error_description ?? body.error ?? res.statusText}`,
      { provider: 'linkedin', status: res.status, raw: body },
    )
  }
  return { token: body.access_token, expiresIn: body.expires_in ?? 5_184_000, scope: body.scope ?? '' }
}

/** Everything this LinkedIn login can publish as. */
export async function linkedinTargets(code: string, kind: string): Promise<ConnectedTarget[]> {
  const { token, expiresIn, scope } = await linkedinToken(code)
  const scopes = scope.split(/[\s,]+/).filter(Boolean)
  const expiresAt = new Date(Date.now() + expiresIn * 1000)

  const targets: ConnectedTarget[] = []

  // The member themself, from the OpenID userinfo endpoint.
  const me = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  const profile = (await me.json().catch(() => ({}))) as {
    sub?: string
    name?: string
    picture?: string
  }
  if (me.ok && profile.sub) {
    targets.push({
      externalId: profile.sub,
      displayName: profile.name ?? 'LinkedIn profile',
      avatarUrl: profile.picture ?? null,
      authorUrn: `urn:li:person:${profile.sub}`,
      accessToken: token,
      expiresAt,
      scopes,
      kind: 'member',
    })
  }

  // Company pages, only when the organisation scope was actually granted.
  if (kind === 'organization' && scopes.includes('r_organization_admin')) {
    const res = await fetch(
      'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(id,localizedName,logoV2)))',
      {
        headers: {
          authorization: `Bearer ${token}`,
          'LinkedIn-Version': LINKEDIN_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
        signal: AbortSignal.timeout(20_000),
      },
    )
    const body = (await res.json().catch(() => ({}))) as {
      elements?: { 'organization~'?: { id?: number | string; localizedName?: string } }[]
    }
    for (const element of body.elements ?? []) {
      const org = element['organization~']
      if (!org?.id) continue
      targets.push({
        externalId: String(org.id),
        displayName: org.localizedName ?? `Company page ${org.id}`,
        authorUrn: `urn:li:organization:${org.id}`,
        accessToken: token,
        expiresAt,
        scopes,
        kind: 'organization',
      })
    }
  }

  if (targets.length === 0) {
    throw new OAuthError(
      'LinkedIn completed the sign-in but did not return anything we can post as. If you were connecting a company page, the Community Management API is probably not approved for this app yet.',
      { provider: 'linkedin' },
    )
  }
  return targets
}

/* --------------------------------------------------------------- Facebook */

/**
 * The Facebook exchange, in the order Meta requires it.
 *
 * The short-lived token from the callback is nearly useless: it expires within
 * hours and cannot post. Exchanging it for a long-lived token *first* matters
 * because Page tokens inherit their lifetime from the user token they came
 * from — derive them from the short-lived one and every Page token expires too.
 */
export async function facebookTargets(code: string): Promise<ConnectedTarget[]> {
  const e = env()

  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: e.META_APP_ID ?? '',
      client_secret: e.META_APP_SECRET ?? '',
      redirect_uri: redirectUri('facebook'),
      code,
    })}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  const shortLived = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string
    error?: { message?: string }
  }
  if (!tokenRes.ok || !shortLived.access_token) {
    throw new OAuthError(
      `Facebook would not complete the connection: ${shortLived.error?.message ?? tokenRes.statusText}`,
      { provider: 'facebook', status: tokenRes.status, raw: shortLived },
    )
  }

  const longRes = await fetch(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: e.META_APP_ID ?? '',
      client_secret: e.META_APP_SECRET ?? '',
      fb_exchange_token: shortLived.access_token,
    })}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  const longLived = (await longRes.json().catch(() => ({}))) as {
    access_token?: string
    error?: { message?: string }
  }
  const userToken = longLived.access_token ?? shortLived.access_token

  const pagesRes = await fetch(
    `${GRAPH}/me/accounts?${new URLSearchParams({
      fields: 'id,name,access_token,picture{url}',
      limit: '100',
      access_token: userToken,
    })}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  const pages = (await pagesRes.json().catch(() => ({}))) as {
    data?: { id?: string; name?: string; access_token?: string; picture?: { data?: { url?: string } } }[]
    error?: { message?: string }
  }
  if (!pagesRes.ok) {
    throw new OAuthError(`Facebook would not list your Pages: ${pages.error?.message ?? pagesRes.statusText}`, {
      provider: 'facebook',
      status: pagesRes.status,
      raw: pages,
    })
  }

  const targets = (pages.data ?? [])
    .filter((p) => p.id && p.access_token)
    .map<ConnectedTarget>((p) => ({
      externalId: p.id!,
      displayName: p.name ?? `Page ${p.id}`,
      avatarUrl: p.picture?.data?.url ?? null,
      // Page tokens derived from a long-lived user token do not expire.
      accessToken: p.access_token!,
      expiresAt: null,
      scopes: META_SCOPES,
      kind: 'page',
    }))

  if (targets.length === 0) {
    throw new OAuthError(
      'That Facebook account does not administer any Pages, or it did not grant permission to see them. You can only post to a Page, not to a personal profile — Facebook does not allow apps to post to profiles at all.',
      { provider: 'facebook' },
    )
  }
  return targets
}
