import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { socialAccounts, socialPublishLog, type Asset, type SocialAccount } from '@/lib/db/schema'
import { decryptToken, TokenDecryptError } from '@/lib/crypto-secrets'
import { GRAPH_VERSION, LINKEDIN_VERSION } from './oauth'

/**
 * Actually posting to LinkedIn and Facebook.
 *
 * Both are one HTTP call, and the interesting parts are either side of it:
 * turning an asset written for humans into each platform's payload, and turning
 * each platform's refusal into a sentence someone can act on. A post that fails
 * with "(#200) Requires pages_manage_posts permission" tells a marketer nothing;
 * "this Page connection is missing permission to post — reconnect it" tells them
 * exactly what to do.
 *
 * Nothing here decides *whether* to publish. The approval gate has already run
 * by the time any of this executes.
 */

export type SocialPost = {
  text: string
  /** Included as a link preview where the platform supports one. */
  link?: string | null
  imageUrl?: string | null
}

export type SocialResult =
  | { ok: true; externalRef: string; permalink: string | null; httpStatus: number; response: unknown }
  | { ok: false; retryable: boolean; error: string; httpStatus?: number; response?: unknown }

/* ------------------------------------------------------------- composing */

/**
 * Flatten a generated asset into post text.
 *
 * Assets carry structured parts — headline, body, call to action, hashtags —
 * because email and ads need them separately. A social post is one block of
 * text, so they are joined in the order a person would write them, and the
 * hashtags go last where every social platform expects them.
 */
export function composePost(asset: Pick<Asset, 'body' | 'channel' | 'imageUrl'>, limit?: number): SocialPost {
  const b = asset.body
  const parts = [b.headline, b.body, b.cta].map((p) => p?.trim()).filter(Boolean) as string[]
  const tags = (b.hashtags ?? []).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')

  let text = parts.join('\n\n')
  if (tags) text = `${text}\n\n${tags}`

  // Truncate on a word boundary rather than letting the platform reject the
  // whole post. The guardrail already warns about length before approval, so
  // this only catches the edge case.
  if (limit && text.length > limit) {
    const cut = text.slice(0, limit - 1)
    const space = cut.lastIndexOf(' ')
    text = `${(space > limit * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`
  }

  return { text, imageUrl: asset.imageUrl ?? null }
}

/* -------------------------------------------------------------- LinkedIn */

/** LinkedIn's own limit on post commentary. */
export const LINKEDIN_LIMIT = 3000
/** Facebook's limit is far higher, but posts this long are never read. */
export const FACEBOOK_LIMIT = 63_206

export function linkedinPayload(account: Pick<SocialAccount, 'authorUrn'>, post: SocialPost) {
  return {
    author: account.authorUrn,
    commentary: post.text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }
}

async function postToLinkedIn(account: SocialAccount, post: SocialPost): Promise<SocialResult> {
  const token = decryptToken(account.accessTokenEnc)
  const payload = linkedinPayload(account, post)

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })

  // LinkedIn returns the new post's urn in a header and an empty body on success.
  const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id')
  const raw = await res.text()
  const body: unknown = raw ? safeJson(raw) : {}

  if (res.ok && urn) {
    return {
      ok: true,
      externalRef: urn,
      permalink: `https://www.linkedin.com/feed/update/${urn}`,
      httpStatus: res.status,
      response: body,
    }
  }

  return {
    ok: false,
    retryable: res.status === 429 || res.status >= 500,
    error: explainLinkedIn(res.status, body),
    httpStatus: res.status,
    response: body,
  }
}

function explainLinkedIn(status: number, body: unknown): string {
  const message = String((body as { message?: string })?.message ?? '')

  if (status === 401) {
    return 'LinkedIn no longer accepts the saved permission for this account. LinkedIn tokens last about sixty days — reconnect the account in Settings.'
  }
  if (status === 403) {
    if (/ACCESS_DENIED|not authorized|permission/i.test(message)) {
      return 'This LinkedIn connection is not allowed to post as that page. Either the sign-in is no longer an admin of it, or the company-page permission has not been approved for this app yet.'
    }
    return 'LinkedIn refused the post. Most often the app has not been approved for company-page publishing.'
  }
  if (status === 422 || /DUPLICATE/i.test(message)) {
    return 'LinkedIn rejected this as a duplicate — the same text was posted recently. Change the wording and try again.'
  }
  if (status === 429) {
    return 'LinkedIn is rate-limiting this account. Nothing is wrong; it will be retried automatically.'
  }
  return message
    ? `LinkedIn rejected the post: ${message}`
    : `LinkedIn returned an unexpected error (HTTP ${status}).`
}

/* -------------------------------------------------------------- Facebook */

export function facebookParams(post: SocialPost, token: string): URLSearchParams {
  const params = new URLSearchParams({ message: post.text, access_token: token })
  if (post.link) params.set('link', post.link)
  return params
}

async function postToFacebook(account: SocialAccount, post: SocialPost): Promise<SocialResult> {
  const token = decryptToken(account.accessTokenEnc)
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${account.externalId}/feed`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: facebookParams(post, token),
    signal: AbortSignal.timeout(30_000),
  })

  const body = (await res.json().catch(() => ({}))) as {
    id?: string
    error?: { message?: string; code?: number; error_subcode?: number; type?: string }
  }

  if (res.ok && body.id) {
    return {
      ok: true,
      externalRef: body.id,
      // Facebook returns "{pageId}_{postId}"; the permalink wants them apart.
      permalink: `https://www.facebook.com/${body.id.replace('_', '/posts/')}`,
      httpStatus: res.status,
      response: body,
    }
  }

  const code = body.error?.code
  return {
    ok: false,
    retryable: res.status >= 500 || code === 1 || code === 2 || code === 4 || code === 17 || code === 32,
    error: explainFacebook(res.status, body.error),
    httpStatus: res.status,
    response: body,
  }
}

function explainFacebook(
  status: number,
  error?: { message?: string; code?: number; error_subcode?: number },
): string {
  const message = error?.message ?? ''

  if (error?.code === 190) {
    return 'Facebook has invalidated the saved permission for this Page. This usually means the password changed, the app was removed, or an admin revoked access. Reconnect the Page in Settings.'
  }
  if (error?.code === 200 || /pages_manage_posts|permission/i.test(message)) {
    return 'This Page connection is missing permission to publish. If the Facebook app has not passed App Review yet, it can only post to Pages administered by people listed on the app itself.'
  }
  if (error?.code === 4 || error?.code === 17 || error?.code === 32) {
    return 'Facebook is rate-limiting this Page. Nothing is wrong; it will be retried automatically.'
  }
  if (error?.code === 368) {
    return 'Facebook has temporarily blocked this Page from posting for violating its community standards. That has to be resolved inside Facebook.'
  }
  if (error?.code === 100) {
    return `Facebook rejected the post as malformed: ${message}`
  }
  return message
    ? `Facebook rejected the post: ${message}`
    : `Facebook returned an unexpected error (HTTP ${status}).`
}

/* ----------------------------------------------------------------- entry */

/** The account a channel should publish through, or null to use the simulator. */
export async function accountFor(workspaceId: string, channel: string): Promise<SocialAccount | null> {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.workspaceId, workspaceId),
        eq(socialAccounts.channel, channel),
        eq(socialAccounts.status, 'connected'),
      ),
    )
    // The explicitly chosen one wins; otherwise the most recently connected,
    // so a workspace with a single account never has to choose at all.
    .orderBy(desc(socialAccounts.isDefault), desc(socialAccounts.createdAt))
    .limit(1)
  return row ?? null
}

export async function publishToSocial(args: {
  workspaceId: string
  account: SocialAccount
  asset: Pick<Asset, 'id' | 'body' | 'channel' | 'imageUrl'>
  attempt: number
}): Promise<SocialResult> {
  const { account, asset } = args
  const limit = account.provider === 'linkedin' ? LINKEDIN_LIMIT : FACEBOOK_LIMIT
  const post = composePost(asset, limit)

  let result: SocialResult
  try {
    result =
      account.provider === 'linkedin'
        ? await postToLinkedIn(account, post)
        : await postToFacebook(account, post)
  } catch (error) {
    // A token we cannot decrypt is a configuration problem, not a transient
    // one — retrying five times would just delay the honest answer.
    const isKey = error instanceof TokenDecryptError
    result = {
      ok: false,
      retryable: !isKey,
      error: isKey
        ? error.message
        : `Could not reach ${account.provider === 'linkedin' ? 'LinkedIn' : 'Facebook'}: ${
            error instanceof Error ? error.message : 'network error'
          }`,
    }
  }

  await db.insert(socialPublishLog).values({
    workspaceId: args.workspaceId,
    accountId: account.id,
    assetId: asset.id,
    provider: account.provider,
    ok: result.ok,
    simulated: false,
    externalRef: result.ok ? result.externalRef : null,
    permalink: result.ok ? result.permalink : null,
    httpStatus: result.httpStatus ?? null,
    request: { text: post.text, target: account.displayName },
    response: (result.response ?? null) as Record<string, unknown> | null,
    error: result.ok ? null : result.error,
    attempt: args.attempt,
  })

  const now = new Date()
  await db
    .update(socialAccounts)
    .set(
      result.ok
        ? { lastPublishAt: now, lastError: null, status: 'connected', updatedAt: now }
        : {
            lastError: result.error,
            // A refused credential is not a blip: mark the account so the UI
            // stops pretending it works and asks for a reconnection.
            status: result.retryable ? account.status : 'error',
            updatedAt: now,
          },
    )
    .where(eq(socialAccounts.id, account.id))

  return result
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
