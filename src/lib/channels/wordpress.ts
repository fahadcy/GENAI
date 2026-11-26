import 'server-only'
import { env } from '@/lib/env'
import type { Asset } from '@/lib/db/schema'

/**
 * Publishing to a WordPress site.
 *
 * WordPress has had a REST API built in since 4.7 and Application Passwords
 * since 5.6, so this needs no plugin: a user account with the Author or Editor
 * role, one generated password, and posts can be created over HTTPS. That
 * matters because a marketing platform that requires installing something on a
 * client's live site usually never gets installed.
 *
 * The default is to create a DRAFT rather than publish. The platform's own
 * approval gate has already been passed by the time anything reaches here, but
 * approval was given to text in a preview pane, and what a theme actually does
 * with that text is a separate question. One look at the first real render is
 * worth more than the convenience of skipping it — and switching to immediate
 * publishing afterwards is one word in the configuration.
 */

const TIMEOUT_MS = 30_000

export type BlogOutcome = {
  ok: boolean
  retryable: boolean
  /** The post's URL, or its edit URL when it was created as a draft. */
  url?: string
  postId?: number
  status?: string
  error?: string
}

/** Trailing slashes and a missing scheme are the two things people always type. */
export function normaliseSiteUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname.includes('.')) return null
    // The path is kept: WordPress is often installed at /blog rather than the root.
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

export function postsEndpoint(siteUrl: string): string {
  return `${normaliseSiteUrl(siteUrl)}/wp-json/wp/v2/posts`
}

/**
 * WordPress Application Passwords are generated with spaces in them, and people
 * paste them exactly as shown. WordPress itself strips the spaces before
 * comparing, so doing the same here turns a baffling 401 into a working login.
 */
export function basicAuth(username: string, appPassword: string): string {
  return Buffer.from(`${username.trim()}:${appPassword.replace(/\s+/g, '')}`).toString('base64')
}

/* ------------------------------------------------------------- the post */

/**
 * The asset as WordPress wants it.
 *
 * Paragraphs become block-editor paragraph blocks rather than bare `<p>` tags.
 * Bare tags land in the editor as a single "Classic" block that nobody can
 * edit comfortably; real blocks stay editable in WordPress afterwards, which
 * is what someone will want the first time a sentence needs changing.
 */
export function blogPayload(args: {
  asset: Pick<Asset, 'title' | 'body'>
  status: 'draft' | 'publish'
  categoryIds?: number[]
}) {
  const b = args.asset.body
  const paragraphs = (b.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  const blocks = [
    ...paragraphs.map((p) => `<!-- wp:paragraph -->\n<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>\n<!-- /wp:paragraph -->`),
    b.cta
      ? `<!-- wp:paragraph -->\n<p><strong>${escapeHtml(b.cta)}</strong></p>\n<!-- /wp:paragraph -->`
      : '',
  ].filter(Boolean)

  return {
    title: args.asset.title,
    content: blocks.join('\n\n'),
    // The meta description if the model wrote one, otherwise the opening line.
    excerpt: (b.subject ?? paragraphs[0] ?? '').slice(0, 300),
    status: args.status,
    ...(args.categoryIds?.length ? { categories: args.categoryIds } : {}),
  }
}

/* ---------------------------------------------------------------- send */

export async function publishToBlog(args: {
  asset: Pick<Asset, 'title' | 'body'>
}): Promise<BlogOutcome> {
  const e = env()
  const site = normaliseSiteUrl(e.WORDPRESS_URL ?? '')
  if (!site || !e.WORDPRESS_USERNAME || !e.WORDPRESS_APP_PASSWORD) {
    return { ok: false, retryable: false, error: 'WordPress is not connected.' }
  }
  if (!args.asset.title?.trim()) {
    return { ok: false, retryable: false, error: 'A blog post needs a title.' }
  }

  const status = e.WORDPRESS_POST_STATUS === 'publish' ? 'publish' : 'draft'

  let res: Response
  try {
    res = await fetch(postsEndpoint(site), {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicAuth(e.WORDPRESS_USERNAME, e.WORDPRESS_APP_PASSWORD)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(blogPayload({ asset: args.asset, status })),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // A site that is briefly down should be retried, not dead-lettered.
    return {
      ok: false,
      retryable: true,
      error: `Could not reach ${site}. ${err instanceof Error && err.name === 'TimeoutError' ? 'It did not respond in time.' : 'Check the address is right and the site is up.'}`,
    }
  }

  const payload = (await res.json().catch(() => ({}))) as {
    id?: number
    link?: string
    status?: string
    code?: string
    message?: string
  }

  if (res.status === 201 && payload.id) {
    return {
      ok: true,
      retryable: false,
      postId: payload.id,
      status: payload.status ?? status,
      /* A draft's `link` is a preview URL that expires; the edit screen is
         where someone actually needs to go. */
      url:
        payload.status === 'publish'
          ? (payload.link ?? `${site}/?p=${payload.id}`)
          : `${site}/wp-admin/post.php?post=${payload.id}&action=edit`,
    }
  }

  return {
    ok: false,
    retryable: res.status === 429 || res.status >= 500,
    error: explainWordPress(res.status, payload.code, payload.message),
  }
}

/** Confirms the credentials work, without creating anything. */
export async function checkBlogConnection(): Promise<
  { ok: true; siteName: string; user: string; canPublish: boolean } | { ok: false; error: string }
> {
  const e = env()
  const site = normaliseSiteUrl(e.WORDPRESS_URL ?? '')
  if (!site || !e.WORDPRESS_USERNAME || !e.WORDPRESS_APP_PASSWORD) {
    return { ok: false, error: 'WordPress is not connected yet.' }
  }

  const auth = `Basic ${basicAuth(e.WORDPRESS_USERNAME, e.WORDPRESS_APP_PASSWORD)}`
  try {
    /* `users/me` is the right probe: it proves the password is valid AND
       returns the capabilities, so "connected but cannot post" is caught here
       rather than on the first real publish. */
    const [meRes, siteRes] = await Promise.all([
      fetch(`${site}/wp-json/wp/v2/users/me?context=edit`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      fetch(`${site}/wp-json`, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
    ])

    if (!meRes.ok) {
      const body = (await meRes.json().catch(() => ({}))) as { code?: string; message?: string }
      return { ok: false, error: explainWordPress(meRes.status, body.code, body.message) }
    }

    const me = (await meRes.json()) as { name?: string; slug?: string; capabilities?: Record<string, boolean> }
    const site_ = (await siteRes.json().catch(() => ({}))) as { name?: string }

    return {
      ok: true,
      siteName: site_.name ?? site,
      user: me.name ?? me.slug ?? e.WORDPRESS_USERNAME,
      canPublish: Boolean(me.capabilities?.publish_posts),
    }
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach ${site}. ${err instanceof Error && err.name === 'TimeoutError' ? 'It did not respond in time.' : 'Check the address, including whether the site is at /blog rather than the root.'}`,
    }
  }
}

export function explainWordPress(status: number, code?: string, message?: string): string {
  if (status === 401 || code === 'incorrect_password') {
    return 'WordPress rejected the login. Application Passwords are separate from the normal password — generate one under Users → Profile → Application Passwords, and paste it including the spaces. Also check the username is the WordPress username, not the email address.'
  }
  if (code === 'rest_cannot_create' || status === 403) {
    return 'That WordPress user is signed in but not allowed to create posts. The account needs the Author or Editor role; Subscriber and Contributor are not enough.'
  }
  if (status === 404 || code === 'rest_no_route') {
    return 'The WordPress REST API was not found at that address. Either the site lives at a different path (often /blog), or a security plugin has disabled the REST API for logged-out requests.'
  }
  if (status === 429) {
    return 'The site is rate-limiting requests. Nothing is wrong; it will be retried automatically.'
  }
  if (status >= 500) {
    return `The WordPress site returned an error (HTTP ${status}). This is usually temporary and will be retried.`
  }
  return message ? `WordPress refused the post: ${message}` : `WordPress returned an unexpected error (HTTP ${status}).`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}
