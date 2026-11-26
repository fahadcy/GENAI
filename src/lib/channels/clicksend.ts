import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts, segmentMembers, type Asset } from '@/lib/db/schema'
import { env } from '@/lib/env'

/**
 * Sending SMS through ClickSend.
 *
 * SMS differs from email in three ways that shape everything here.
 *
 * There is no footer to put a link in. An opt-out has to be words inside the
 * 160 characters you are paying for, which is why `withStopInstruction` exists
 * and why the text is measured after it is added, not before.
 *
 * It costs money per message, visibly. ClickSend returns a price per recipient,
 * so the outcome carries the real total rather than an estimate — someone who
 * sends to the wrong segment should be able to see what it cost immediately.
 *
 * And numbers have to be in E.164 or the carrier silently drops them. A UK
 * mobile stored as `07700 900123` will not arrive; it has to leave as
 * `+447700900123`.
 */

const BATCH = 1000
const GSM_LIMIT = 160

export type SmsOutcome = {
  ok: boolean
  accepted: number
  failed: number
  /** Real spend, from ClickSend, in the account's currency. */
  cost: number
  retryable: boolean
  error?: string
  /** Per-recipient failures, so a bad number does not hide behind a total. */
  rejections?: { to: string; reason: string }[]
}

export type SmsRecipient = { id: string; phone: string; name: string | null }

export async function smsAudience(workspaceId: string, segmentId: string): Promise<SmsRecipient[]> {
  const rows = await db
    .select({ id: contacts.id, phone: contacts.phone, name: contacts.name })
    .from(segmentMembers)
    .innerJoin(
      contacts,
      and(eq(contacts.id, segmentMembers.contactId), eq(contacts.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(segmentMembers.segmentId, segmentId),
        eq(contacts.suppressed, false),
        sql`(${contacts.consent} ->> 'sms')::boolean is true`,
        sql`${contacts.phone} is not null and ${contacts.phone} <> ''`,
      ),
    )

  return rows
    .map((r) => ({ ...r, phone: toE164(r.phone ?? '') }))
    .filter((r): r is SmsRecipient => Boolean(r.phone))
}

/**
 * Normalise to E.164, assuming UK when no country code is present.
 *
 * Returns null rather than guessing when the number cannot be made sense of.
 * Sending a malformed number costs money and delivers nothing, so refusing is
 * cheaper than trying.
 */
export function toE164(raw: string, defaultCountry: '44' = '44'): string | null {
  const trimmed = raw.trim()
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null

  // 00 prefix is the international dialling form of +.
  if (digits.startsWith('00')) {
    const rest = digits.slice(2)
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null
  }

  // National format: a UK number starts 0 and is 11 digits.
  if (digits.startsWith('0')) {
    const national = digits.slice(1)
    return national.length >= 9 && national.length <= 10 ? `+${defaultCountry}${national}` : null
  }

  // Already has a country code but no plus.
  if (digits.startsWith(defaultCountry) && digits.length >= 11) return `+${digits}`

  return null
}

/* ------------------------------------------------------------- composing */

/**
 * The opt-out, in the body, because SMS has nowhere else to put one.
 *
 * "Reply STOP" only works on a number that can receive replies. An alphanumeric
 * sender ID cannot, so the caller says which it is and the wording changes to
 * match — telling someone to reply to a sender that cannot hear them is worse
 * than saying nothing.
 */
export function withStopInstruction(text: string, canReceiveReplies: boolean): string {
  const suffix = canReceiveReplies ? ' Reply STOP to opt out.' : ''
  if (!suffix || text.includes('STOP')) return text
  return `${text}${suffix}`
}

export function smsText(asset: Pick<Asset, 'body'>): string {
  const b = asset.body
  return [b.headline, b.body, b.cta]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How many segments a message will be billed as. Over 160 characters it splits. */
export function segmentsFor(text: string): number {
  return text.length <= GSM_LIMIT ? 1 : Math.ceil(text.length / 153)
}

export function clickSendPayload(args: {
  recipients: SmsRecipient[]
  body: string
  from?: string
}) {
  return {
    messages: args.recipients.map((r) => ({
      source: 'genai',
      body: args.body,
      to: r.phone,
      ...(args.from ? { from: args.from } : {}),
      // Comes back on the response, so a per-recipient failure can be traced
      // to the contact rather than only to a phone number.
      custom_string: r.id,
    })),
  }
}

/* ---------------------------------------------------------------- send */

export async function sendSms(args: {
  workspaceId: string
  segmentId: string
  asset: Pick<Asset, 'body'>
}): Promise<SmsOutcome> {
  const e = env()
  const recipients = await smsAudience(args.workspaceId, args.segmentId)

  if (recipients.length === 0) {
    return {
      ok: false,
      accepted: 0,
      failed: 0,
      cost: 0,
      retryable: false,
      error:
        'Nobody in this segment can be texted. Everyone is either suppressed, has not consented to SMS, or has no usable mobile number.',
    }
  }

  // An alphanumeric sender ID cannot receive replies; a numeric one can.
  const from = e.CLICKSEND_SENDER_ID
  const canReply = !from || /^\+?\d+$/.test(from)
  const body = withStopInstruction(smsText(args.asset), canReply)

  if (!body) {
    return { ok: false, accepted: 0, failed: 0, cost: 0, retryable: false, error: 'This message has no text.' }
  }

  const auth = Buffer.from(`${e.CLICKSEND_USERNAME}:${e.CLICKSEND_API_KEY}`).toString('base64')
  let accepted = 0
  let failed = 0
  let cost = 0
  const rejections: { to: string; reason: string }[] = []

  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH)
    const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(clickSendPayload({ recipients: batch, body, from })),
      signal: AbortSignal.timeout(45_000),
    })

    const payload = (await res.json().catch(() => ({}))) as {
      response_code?: string
      response_msg?: string
      data?: {
        total_price?: number
        messages?: { status?: string; to?: string; message_price?: string; custom_string?: string }[]
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        accepted,
        failed,
        cost,
        retryable: res.status === 429 || res.status >= 500,
        error: explainClickSend(res.status, payload.response_msg),
        rejections,
      }
    }

    cost += Number(payload.data?.total_price ?? 0)

    // ClickSend answers 200 with per-message statuses, so a partial failure
    // looks like success unless each one is inspected.
    for (const m of payload.data?.messages ?? []) {
      if ((m.status ?? '').toUpperCase() === 'SUCCESS') accepted++
      else {
        failed++
        rejections.push({ to: m.to ?? 'unknown', reason: m.status ?? 'rejected' })
      }
    }
  }

  return {
    ok: accepted > 0,
    accepted,
    failed,
    cost: Math.round(cost * 10_000) / 10_000,
    retryable: false,
    error:
      failed > 0
        ? `${failed} of ${accepted + failed} messages were rejected by the carrier. The rest were sent.`
        : undefined,
    rejections: rejections.length > 0 ? rejections : undefined,
  }
}

function explainClickSend(status: number, message?: string): string {
  if (status === 401 || status === 403) {
    return 'ClickSend rejected the credentials. Check CLICKSEND_USERNAME is the account username (not the email you log in with) and that the API key is correct.'
  }
  if (status === 400 && /balance|credit|funds/i.test(message ?? '')) {
    return 'ClickSend has no credit left on the account. Top it up and the queued messages will retry.'
  }
  if (status === 429) {
    return 'ClickSend is rate-limiting this account. Nothing is wrong; it will be retried automatically.'
  }
  return message
    ? `ClickSend rejected the send: ${message}`
    : `ClickSend returned an unexpected error (HTTP ${status}).`
}
