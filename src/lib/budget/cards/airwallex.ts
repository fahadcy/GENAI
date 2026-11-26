import 'server-only'
import { jsonRequest } from './http'

/**
 * Airwallex Issuing — the connector that can *enforce* a budget, not just
 * watch it.
 *
 * Open Banking can only detect overspend after the fact. A virtual card per
 * ad platform, with a monthly limit equal to that line's budget, stops the
 * payment at the card (research §2, "route B"). Airwallex was chosen over
 * Stripe Issuing because the customer uses their own Airwallex account and
 * API key — issuing cards *to* customers through Stripe Connect would make
 * GenAI a card-programme platform with the compliance that brings — and over
 * Revolut because its API key login is a plain key, not a signed JWT.
 * Airwallex also holds USD balances, which removes the FX fee on
 * dollar-billed ad accounts.
 *
 * The honest caveat, repeated in the UI: a declined charge does not undo spend
 * the platform has already delivered. The platform marks the payment failed
 * and pauses delivery, and the balance is still owed. The card cap is the
 * backstop; platform-side caps (Google account budgets, Meta spend caps) are
 * the first line.
 *
 * Endpoints (Airwallex API reference, checked 18 Oct 2026):
 *   POST /api/v1/authentication/login       x-client-id, x-api-key → token (30 min)
 *   GET  /api/v1/issuing/cards
 *   POST /api/v1/issuing/cards/{id}/update  authorization_controls
 *   GET  /api/v1/issuing/transactions       deprecated in favour of transaction events, still served
 */

const BASE = {
  live: 'https://api.airwallex.com',
  demo: 'https://api.sandbox.airwallex.com',
}

export type AirwallexCreds = { clientId: string; apiKey: string; demo: boolean }

export async function airwallexLogin(c: AirwallexCreds): Promise<string> {
  const r = await jsonRequest<{ token: string }>('Airwallex', `${c.demo ? BASE.demo : BASE.live}/api/v1/authentication/login`, {
    method: 'POST',
    headers: { 'x-client-id': c.clientId, 'x-api-key': c.apiKey, 'content-type': 'application/json' },
    body: '{}',
  })
  return r.token
}

export type AirwallexCard = {
  card_id: string
  nick_name?: string
  card_number?: string // masked by Airwallex, e.g. ************4242
  card_status?: string
  form_factor?: string
  authorization_controls?: {
    transaction_limits?: { currency?: string; limits?: { amount: number; interval: string }[] }
  }
}

export async function airwallexCards(c: AirwallexCreds, token: string): Promise<AirwallexCard[]> {
  const r = await jsonRequest<{ items: AirwallexCard[] }>('Airwallex', `${c.demo ? BASE.demo : BASE.live}/api/v1/issuing/cards?page_size=100`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return r.items ?? []
}

export type AirwallexTx = {
  transaction_id: string
  card_id: string
  transaction_amount: number
  transaction_currency: string
  billing_amount: number
  billing_currency: string
  merchant?: { name?: string; category_code?: string }
  status?: string
  transaction_type?: string
  transaction_date?: string
  posted_date?: string
}

export async function airwallexTransactions(c: AirwallexCreds, token: string, cardId: string, from: string, to: string): Promise<AirwallexTx[]> {
  const out: AirwallexTx[] = []
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({
      card_id: cardId,
      from_created_at: `${from}T00:00:00Z`,
      to_created_at: `${to}T23:59:59Z`,
      page_num: String(page),
      page_size: '200',
    })
    const r = await jsonRequest<{ items: AirwallexTx[]; has_more?: boolean }>(
      'Airwallex',
      `${c.demo ? BASE.demo : BASE.live}/api/v1/issuing/transactions?${q}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    out.push(...(r.items ?? []))
    if (!r.has_more) break
  }
  return out
}

/**
 * Set a card's monthly limit to a budget line's amount. Amounts are in major
 * units in Airwallex's API. Returns the body sent, for the audit trail.
 */
export async function airwallexSetMonthlyLimit(
  c: AirwallexCreds,
  token: string,
  cardId: string,
  amountPence: number,
  currency: string,
): Promise<Record<string, unknown>> {
  const body = {
    authorization_controls: {
      transaction_limits: { currency, limits: [{ amount: Math.round(amountPence) / 100, interval: 'MONTHLY' }] },
    },
  }
  await jsonRequest('Airwallex', `${c.demo ? BASE.demo : BASE.live}/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return body
}

/**
 * Map Airwallex transactions to GenAI's shape. Clearings are settled charges,
 * refunds are money back, authorisations still open are pending, reversals
 * and declines are not money moving at all.
 */
export function normaliseAirwallexTx(t: AirwallexTx) {
  const type = (t.transaction_type ?? '').toUpperCase()
  const status = (t.status ?? '').toUpperCase()
  if (type === 'REVERSAL' || status === 'FAILED' || status === 'DECLINED') return null
  const pending = type === 'AUTHORIZATION' && status === 'PENDING'
  if (type === 'AUTHORIZATION' && !pending) return null // superseded by its clearing
  const billed = Math.round(Math.abs(t.billing_amount) * 100)
  const sign = type === 'REFUND' || type === 'ORIGINAL_CREDIT' ? -1 : 1
  const when = t.posted_date ?? t.transaction_date ?? new Date().toISOString()
  const foreign = t.transaction_currency && t.transaction_currency !== t.billing_currency
  return {
    day: when.slice(0, 10),
    postedAt: when,
    amountPence: sign * billed,
    currency: (t.billing_currency || 'GBP').toUpperCase(),
    descriptor: t.merchant?.name ?? 'Unknown merchant',
    status: (pending ? 'pending' : 'settled') as 'pending' | 'settled',
    providerTxId: t.transaction_id,
    originalAmountMinor: foreign ? Math.round(Math.abs(t.transaction_amount) * 100) : null,
    originalCurrency: foreign ? t.transaction_currency.toUpperCase() : null,
  }
}

export function last4(masked: string | undefined): string | null {
  const m = (masked ?? '').match(/(\d{4})\s*$/)
  return m ? m[1] : null
}
