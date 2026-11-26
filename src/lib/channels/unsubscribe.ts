import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * Opt-out links.
 *
 * Every marketing email has to carry a working one — that is not a nicety, it
 * is what UK GDPR and PECR require, and the liability lands on whoever sent the
 * mail. The link therefore has to work for a recipient who is not signed in,
 * has no account, and may click it a year later.
 *
 * The token is signed rather than stored, for three reasons: there is no row to
 * create at send time when a campaign goes to thousands of people, the link
 * keeps working after the schedule item is cleaned up, and a leaked database
 * does not hand anyone the ability to unsubscribe other people.
 *
 * What it deliberately does NOT do is expire. An opt-out link that has timed
 * out is worse than none at all: the recipient clicks, is refused, and the only
 * remaining option is a complaint.
 *
 * Kept free of `server-only` so the token logic is unit-testable, and free of
 * database imports so it can run inside the mail composer.
 */

export type UnsubscribeClaim = {
  workspaceId: string
  contactId: string
  /** Which channel is being opted out of; `all` covers everything. */
  channel: 'email' | 'sms' | 'all'
}

/** Deterministic so the same contact always gets the same link for a channel. */
function sign(payload: string): string {
  return createHmac('sha256', `${env().AUTH_SECRET}:unsubscribe`)
    .update(payload)
    .digest('base64url')
    .slice(0, 32)
}

export function unsubscribeToken(claim: UnsubscribeClaim): string {
  const payload = `${claim.workspaceId}.${claim.contactId}.${claim.channel}`
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const [encoded, mac] = token.split('.')
  if (!encoded || !mac) return null

  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = sign(payload)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const [workspaceId, contactId, channel] = payload.split('.')
  if (!workspaceId || !contactId) return null
  if (channel !== 'email' && channel !== 'sms' && channel !== 'all') return null

  return { workspaceId, contactId, channel }
}

/** Where a person clicking the footer link lands. */
export function unsubscribeUrl(claim: UnsubscribeClaim): string {
  return `${env().APP_URL.replace(/\/$/, '')}/unsubscribe/${unsubscribeToken(claim)}`
}

/**
 * The URL that goes in the List-Unsubscribe header. Separate from the one
 * above because RFC 8058 requires the header's URL to accept a POST, and a
 * Next route handler cannot share a path with a page.
 */
export function oneClickUrl(claim: UnsubscribeClaim): string {
  return `${env().APP_URL.replace(/\/$/, '')}/api/unsubscribe/${unsubscribeToken(claim)}`
}

/* ------------------------------------------------------------- injection */

const FOOTER_MARKER = '<!--aurea-unsubscribe-->'

/**
 * Adds the footer to an HTML email.
 *
 * Idempotent via the marker comment, because a retried send must not stack a
 * second footer onto the same body. The wording names the sender, which is
 * itself a legal requirement — a recipient has to be able to tell who is
 * mailing them without opening a link.
 */
export function withUnsubscribeFooter(html: string, args: { url: string; senderName: string }): string {
  if (html.includes(FOOTER_MARKER)) return html

  const footer = `${FOOTER_MARKER}
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e4e1ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:1.6;color:#736d82">
  <p style="margin:0 0 6px">You are receiving this because you gave ${escapeHtml(args.senderName)} permission to contact you.</p>
  <p style="margin:0"><a href="${args.url}" style="color:#5b4be0">Unsubscribe from these emails</a></p>
</div>`

  // Inside <body> when there is one, so the footer is not stranded after </html>.
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}\n</body>`) : `${html}\n${footer}`
}

/** Plain-text alternative. A URL on its own line is what mail clients linkify. */
export function withUnsubscribeText(text: string, args: { url: string; senderName: string }): string {
  if (text.includes('Unsubscribe:')) return text
  return `${text}\n\n—\nYou are receiving this because you gave ${args.senderName} permission to contact you.\nUnsubscribe: ${args.url}`
}

/**
 * The `List-Unsubscribe` headers.
 *
 * Gmail and Outlook surface a native unsubscribe button when these are present,
 * and — since 2024 — bulk senders are required to support one-click. Getting
 * this right is also the cheapest deliverability win there is: recipients use
 * the button instead of the spam report, which is what protects the sending
 * reputation.
 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}
