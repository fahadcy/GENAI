import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts, segmentMembers, type Asset } from '@/lib/db/schema'
import { env } from '@/lib/env'
import {
  oneClickUrl,
  unsubscribeHeaders,
  unsubscribeUrl,
  withUnsubscribeFooter,
  withUnsubscribeText,
} from './unsubscribe'

/**
 * Sending email through SendGrid.
 *
 * The shape of this is dictated by one requirement: every recipient needs their
 * own unsubscribe link. SendGrid's `personalizations` array exists for exactly
 * this — one entry per recipient, each carrying its own substitutions and
 * headers — so a thousand-person send is one API call rather than a thousand,
 * and each person still gets a link that only unsubscribes them.
 *
 * Recipients are resolved here rather than being handed down as a count,
 * because suppression and consent have to be evaluated against their current
 * state at the moment of sending. A cached number cannot tell you *who*.
 */

/** SendGrid accepts up to 1000 personalizations per request. */
const BATCH = 900

export type EmailOutcome = {
  ok: boolean
  accepted: number
  suppressed: number
  retryable: boolean
  error?: string
  /** SendGrid's own id for the batch, for support tickets. */
  messageId?: string
}

export type EmailRecipient = { id: string; email: string; name: string | null }

/**
 * Who this send actually goes to, decided now.
 *
 * Three filters, all applied in SQL so there is no window between deciding and
 * sending: not suppressed, has consented to email, and has an address at all.
 */
export async function emailAudience(workspaceId: string, segmentId: string): Promise<EmailRecipient[]> {
  return db
    .select({ id: contacts.id, email: contacts.email, name: contacts.name })
    .from(segmentMembers)
    .innerJoin(
      contacts,
      and(eq(contacts.id, segmentMembers.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(segmentMembers.segmentId, segmentId),
        eq(contacts.suppressed, false),
        sql`(${contacts.consent} ->> 'email')::boolean is true`,
        sql`${contacts.email} is not null and ${contacts.email} <> ''`,
      ),
    )
    .then((rows) => rows.filter((r): r is EmailRecipient => Boolean(r.email)))
}

/* ------------------------------------------------------------- composing */

/** Very small HTML from the asset's parts. Nothing here trusts model output as markup. */
export function emailHtml(asset: Pick<Asset, 'body'>): string {
  const b = asset.body
  const paras = (b.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')

  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#16141f;max-width:600px">`,
    b.headline ? `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(b.headline)}</h1>` : '',
    paras,
    b.cta ? `<p style="margin:24px 0 0"><strong>${escapeHtml(b.cta)}</strong></p>` : '',
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function emailText(asset: Pick<Asset, 'body'>): string {
  const b = asset.body
  return [b.headline, b.body, b.cta].map((p) => p?.trim()).filter(Boolean).join('\n\n')
}

/**
 * The request body.
 *
 * Exported so it can be asserted on without a network call — the personalisation
 * structure is the part most likely to break silently, and getting it wrong
 * either sends everyone the wrong unsubscribe link or exposes the whole
 * recipient list in the To: header.
 */
export function sendGridPayload(args: {
  workspaceId: string
  recipients: EmailRecipient[]
  subject: string
  html: string
  text: string
  fromEmail: string
  fromName: string
  senderName: string
}) {
  return {
    // One personalization per recipient. Never one with many `to` entries —
    // that would show every address to every reader.
    personalizations: args.recipients.map((r) => {
      const claim = { workspaceId: args.workspaceId, contactId: r.id, channel: 'email' as const }
      return {
        to: [{ email: r.email, name: r.name ?? undefined }],
        substitutions: {
          '-firstName-': firstNameOf(r.name),
          '-unsubscribeUrl-': unsubscribeUrl(claim),
        },
        headers: unsubscribeHeaders(oneClickUrl(claim)),
      }
    }),
    from: { email: args.fromEmail, name: args.fromName },
    subject: args.subject,
    content: [
      { type: 'text/plain', value: withUnsubscribeText(args.text, { url: '-unsubscribeUrl-', senderName: args.senderName }) },
      { type: 'text/html', value: withUnsubscribeFooter(args.html, { url: '-unsubscribeUrl-', senderName: args.senderName }) },
    ],
    // The platform's own suppression is authoritative, but SendGrid keeps its
    // own list of bounces and complaints and must be allowed to enforce it.
    mail_settings: { bypass_list_management: { enable: false } },
    tracking_settings: { open_tracking: { enable: true }, click_tracking: { enable: true } },
  }
}

/* ---------------------------------------------------------------- send */

export async function sendEmail(args: {
  workspaceId: string
  segmentId: string
  asset: Pick<Asset, 'body'>
  senderName: string
}): Promise<EmailOutcome> {
  const e = env()
  const recipients = await emailAudience(args.workspaceId, args.segmentId)

  if (recipients.length === 0) {
    return {
      ok: false,
      accepted: 0,
      suppressed: 0,
      retryable: false,
      error:
        'Nobody in this segment can be emailed. Everyone is either suppressed, has not consented to email, or has no address on file.',
    }
  }

  const subject = args.asset.body.subject?.trim()
  if (!subject) {
    return { ok: false, accepted: 0, suppressed: 0, retryable: false, error: 'This email has no subject line.' }
  }

  const html = emailHtml(args.asset)
  const text = emailText(args.asset)
  let accepted = 0
  let messageId: string | undefined

  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH)
    const payload = sendGridPayload({
      workspaceId: args.workspaceId,
      recipients: batch,
      subject,
      html,
      text,
      fromEmail: e.SENDGRID_FROM_EMAIL ?? '',
      fromName: e.SENDGRID_FROM_NAME ?? args.senderName,
      senderName: args.senderName,
    })

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${e.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    })

    if (res.status === 202) {
      accepted += batch.length
      messageId ??= res.headers.get('x-message-id') ?? undefined
      continue
    }

    const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string; field?: string }[] }
    return {
      ok: false,
      accepted,
      suppressed: 0,
      retryable: res.status === 429 || res.status >= 500,
      error: explainSendGrid(res.status, body.errors),
      messageId,
    }
  }

  return { ok: true, accepted, suppressed: 0, retryable: false, messageId }
}

function explainSendGrid(status: number, errors?: { message?: string; field?: string }[]): string {
  const first = errors?.[0]?.message ?? ''

  if (status === 401) {
    return 'SendGrid rejected the API key. Check SENDGRID_API_KEY, and that the key has Mail Send permission — a read-only key fails exactly like a wrong one.'
  }
  if (status === 403 && /verified Sender Identity|from address/i.test(first)) {
    return 'SendGrid will not send from that address because it has not been verified. Verify the single sender, or authenticate the whole domain, in SendGrid under Settings → Sender Authentication.'
  }
  if (status === 403) {
    return `SendGrid refused the send: ${first || 'the account may not be permitted to send yet.'}`
  }
  if (status === 413) {
    return 'The message is too large for SendGrid to accept. Shorten it or remove attachments.'
  }
  if (status === 429) {
    return 'SendGrid is rate-limiting this account. Nothing is wrong; it will be retried automatically.'
  }
  return first
    ? `SendGrid rejected the send: ${first}`
    : `SendGrid returned an unexpected error (HTTP ${status}).`
}

/** "Priya Raman" → "Priya". Falls back to a neutral greeting rather than blank. */
export function firstNameOf(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first || 'there'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}
