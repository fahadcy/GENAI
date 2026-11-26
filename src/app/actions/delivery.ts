'use server'

import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { env, hasClickSend, hasSendGrid, hasWordPress } from '@/lib/env'
import { toE164, withStopInstruction } from '@/lib/channels/clicksend'
import { checkBlogConnection } from '@/lib/channels/wordpress'
import { recordAudit } from '@/lib/workflow/audit'
import type { ActionResult } from './content'

/**
 * "Does this actually work?" — answered before a campaign depends on it.
 *
 * A test send goes to one address or number the person types here, bypassing
 * segments, suppression and consent entirely. That bypass is only safe because
 * the destination is typed by a signed-in administrator at the moment of
 * sending: it can never be pointed at a list.
 *
 * This exists because the alternative is finding out that the API key is
 * read-only, or the sender address unverified, at 9am on the morning a
 * campaign goes out.
 */

const MAX_TEST_SMS = 160

export async function sendTestEmailAction(input: { to: string }): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can send a test.' }
  }

  if (!hasSendGrid()) {
    return { ok: false, message: 'SendGrid is not set up yet. Add SENDGRID_API_KEY and SENDGRID_FROM_EMAIL to .env.local and restart.' }
  }

  const to = input.to.trim()
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to)) {
    return { ok: false, message: 'That does not look like an email address.' }
  }

  const e = env()
  const from = e.SENDGRID_FROM_EMAIL ?? ''
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${e.SENDGRID_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: e.SENDGRID_FROM_NAME ?? auth.workspace.name },
      subject: `Test email from ${auth.workspace.name}`,
      content: [
        {
          type: 'text/plain',
          value: `This is a test from GenAI.\n\nIf you are reading it, SendGrid is working: the API key is valid, it has Mail Send permission, and ${from} is a verified sender.\n\nNo campaign was sent and nobody else received this.`,
        },
      ],
      // A test must never be silently swallowed by a stale suppression entry —
      // that would look like a broken key.
      mail_settings: { bypass_list_management: { enable: true } },
      tracking_settings: { open_tracking: { enable: false }, click_tracking: { enable: false } },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (res.status !== 202) {
    const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[] }
    const detail = body.errors?.[0]?.message ?? `HTTP ${res.status}`
    return { ok: false, message: explainTestFailure('SendGrid', res.status, detail, from) }
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'connector.tested',
    subjectType: 'connector',
    subjectId: 'sendgrid',
    // The destination is recorded: a test send is still a send.
    summary: `Test email sent to ${to} via SendGrid.`,
    payload: { provider: 'sendgrid', to },
  })

  return {
    ok: true,
    message: `SendGrid accepted it. Check ${to} — including the spam folder, which is where a brand-new sending domain usually lands first.`,
  }
}

export async function sendTestSmsAction(input: { to: string }): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can send a test.' }
  }

  if (!hasClickSend()) {
    return { ok: false, message: 'ClickSend is not set up yet. Add CLICKSEND_USERNAME and CLICKSEND_API_KEY to .env.local and restart.' }
  }

  const to = toE164(input.to)
  if (!to) {
    return {
      ok: false,
      message: 'That number cannot be dialled. A UK mobile looks like 07700 900123 or +44 7700 900123.',
    }
  }

  const e = env()
  const from = e.CLICKSEND_SENDER_ID
  const canReply = !from || /^\+?\d+$/.test(from)
  const body = withStopInstruction(
    `Test message from ${auth.workspace.name} via GenAI. No campaign was sent.`,
    canReply,
  ).slice(0, MAX_TEST_SMS)

  const auth64 = Buffer.from(`${e.CLICKSEND_USERNAME}:${e.CLICKSEND_API_KEY}`).toString('base64')
  const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
    method: 'POST',
    headers: { authorization: `Basic ${auth64}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ source: 'genai', body, to, ...(from ? { from } : {}) }],
    }),
    signal: AbortSignal.timeout(30_000),
  })

  const payload = (await res.json().catch(() => ({}))) as {
    response_msg?: string
    data?: { total_price?: number; messages?: { status?: string }[] }
  }

  if (!res.ok) {
    return { ok: false, message: explainTestFailure('ClickSend', res.status, payload.response_msg ?? `HTTP ${res.status}`) }
  }

  // ClickSend answers 200 even when it refused the individual message.
  const status = (payload.data?.messages?.[0]?.status ?? '').toUpperCase()
  if (status !== 'SUCCESS') {
    return {
      ok: false,
      message: `ClickSend accepted the request but refused the message: ${status || 'no status returned'}. The credentials are fine; the number or the sender ID is not.`,
    }
  }

  const cost = Number(payload.data?.total_price ?? 0)

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'connector.tested',
    subjectType: 'connector',
    subjectId: 'clicksend',
    summary: `Test SMS sent to ${to} via ClickSend${cost > 0 ? ` (${cost.toFixed(4)})` : ''}.`,
    payload: { provider: 'clicksend', to, cost },
  })

  return {
    ok: true,
    message: `Sent to ${to}${cost > 0 ? `, billed ${cost.toFixed(4)} on your ClickSend account` : ''}. It usually arrives within a few seconds.`,
  }
}

/** The four things that actually go wrong, said plainly rather than as a status code. */
function explainTestFailure(vendor: string, status: number, detail: string, from?: string): string {
  if (status === 401) {
    return vendor === 'SendGrid'
      ? 'SendGrid rejected the API key. Either it is wrong, or it was created without Mail Send permission — a read-only key fails exactly like a wrong one.'
      : 'ClickSend rejected the credentials. CLICKSEND_USERNAME is the account username shown under Developers → API Credentials, which is usually not the email you log in with.'
  }
  if (status === 403 && vendor === 'SendGrid') {
    return `SendGrid will not send from ${from || 'that address'} because it has not been verified. In SendGrid: Settings → Sender Authentication → verify a single sender, or authenticate the domain.`
  }
  if (/balance|credit|funds/i.test(detail)) {
    return 'There is no credit on the ClickSend account. Top it up and try again.'
  }
  return `${vendor} refused it: ${detail}`
}

/**
 * Proving the website connection without publishing anything.
 *
 * This checks the one thing a credential check usually misses: not just that
 * the password works, but that the account is *allowed to publish*. A
 * Contributor can log in perfectly and then be refused at the first post.
 */
export async function checkWebsiteAction(): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'connector:manage')
  } catch {
    return { ok: false, message: 'Only an owner or marketing ops can test the website connection.' }
  }

  if (!hasWordPress()) {
    return {
      ok: false,
      message:
        'The website is not connected yet. Add WORDPRESS_URL, WORDPRESS_USERNAME and WORDPRESS_APP_PASSWORD to .env.local and restart.',
    }
  }

  const res = await checkBlogConnection()
  if (!res.ok) return { ok: false, message: res.error }

  const status = env().WORDPRESS_POST_STATUS === 'publish' ? 'go live immediately' : 'be saved as drafts'

  return {
    ok: res.canPublish,
    message: res.canPublish
      ? `Connected to ${res.siteName} as ${res.user}. Approved posts will ${status}.`
      : `Connected to ${res.siteName} as ${res.user}, but that account cannot publish posts. Give it the Author or Editor role in WordPress under Users.`,
  }
}
