import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { jsonRequest } from './http'

/**
 * TrueLayer Data API — read-only access to a company card through UK Open
 * Banking.
 *
 * Regulatory note (research §1.4): reading a payment account on a customer's
 * behalf is an account information service. The fast route is to operate as
 * an agent of TrueLayer's AISP permission (weeks) rather than to register
 * with the FCA (up to a year). The code is the same either way; the contract
 * is not, and must be in place before TRUELAYER_ENV is set to live.
 *
 * What the research found that shapes this file:
 *  - Scopes are read-only: info, accounts, balance, cards, transactions,
 *    offline_access. No payment scope is ever requested.
 *  - Card transactions and pending card transactions are separate endpoints,
 *    and pending ones cannot be filtered by date.
 *  - Transaction ids may change between requests, so GenAI deduplicates on
 *    its own key (merchants.txKey), not on TrueLayer's id.
 *  - In the UK, GenAI must ask the customer to reconfirm access every 90 days
 *    (FCA PS21/19). consentExpiresAt drives that prompt.
 *  - Not every bank supports the cards scope; the error says so plainly.
 */

const SCOPES = 'info accounts balance cards transactions offline_access'
export const RECONFIRM_DAYS = 90

function hosts() {
  const live = env().TRUELAYER_ENV === 'live'
  return {
    auth: live ? 'https://auth.truelayer.com' : 'https://auth.truelayer-sandbox.com',
    api: live ? 'https://api.truelayer.com' : 'https://api.truelayer-sandbox.com',
  }
}

export function trueLayerConfigured(): boolean {
  return Boolean(env().TRUELAYER_CLIENT_ID && env().TRUELAYER_CLIENT_SECRET)
}

export function trueLayerRedirectUri(): string {
  return new URL('/api/budget/truelayer/callback', env().APP_URL).toString()
}

/* ------------------------------------------------------------- state */

const STATE_TTL_MS = 15 * 60 * 1000

/** Name of the httpOnly cookie that binds a bank connection to the browser that started it. */
export const NONCE_COOKIE = 'genai_tl_nonce'

export function newNonce(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * The state carries a nonce that must match a cookie set in the browser that
 * started the flow. Without it, someone could start a connection in their
 * workspace and send the bank link to a person at another company; that
 * person's card would land in the wrong workspace.
 */
export function signCardState(workspaceId: string, userId: string, nonce: string): string {
  const body = [workspaceId, userId, 'truelayer', Date.now().toString(36), nonce].join('~')
  const mac = createHmac('sha256', env().AUTH_SECRET).update(`card:${body}`).digest('base64url').slice(0, 32)
  return `${Buffer.from(body).toString('base64url')}.${mac}`
}

export function verifyCardState(state: string): { workspaceId: string; userId: string; nonce: string } | null {
  const [encoded, mac] = (state ?? '').split('.')
  if (!encoded || !mac) return null
  let body: string
  try {
    body = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = createHmac('sha256', env().AUTH_SECRET).update(`card:${body}`).digest('base64url').slice(0, 32)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [workspaceId, userId, kind, issued, nonce] = body.split('~')
  if (!workspaceId || !userId || kind !== 'truelayer' || !nonce) return null
  const at = parseInt(issued ?? '', 36)
  if (!Number.isFinite(at) || Date.now() - at > STATE_TTL_MS) return null
  return { workspaceId, userId, nonce }
}

export function nonceMatches(a: string | undefined, b: string): boolean {
  if (!a) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function trueLayerAuthUrl(workspaceId: string, userId: string, nonce: string): string {
  const u = new URL(hosts().auth)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', env().TRUELAYER_CLIENT_ID ?? '')
  u.searchParams.set('scope', SCOPES)
  u.searchParams.set('redirect_uri', trueLayerRedirectUri())
  u.searchParams.set('providers', env().TRUELAYER_ENV === 'live' ? 'uk-ob-all uk-oauth-all' : 'uk-cs-mock uk-ob-all uk-oauth-all')
  u.searchParams.set('state', signCardState(workspaceId, userId, nonce))
  return u.toString()
}

/* ------------------------------------------------------------- tokens */

export type TrueLayerTokens = { access_token: string; refresh_token?: string; expires_in: number }

export async function exchangeCode(code: string): Promise<TrueLayerTokens> {
  return jsonRequest<TrueLayerTokens>('TrueLayer', `${hosts().auth}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env().TRUELAYER_CLIENT_ID ?? '',
      client_secret: env().TRUELAYER_CLIENT_SECRET ?? '',
      redirect_uri: trueLayerRedirectUri(),
      code,
    }).toString(),
  })
}

export async function refreshTokens(refreshToken: string): Promise<TrueLayerTokens> {
  return jsonRequest<TrueLayerTokens>('TrueLayer', `${hosts().auth}/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env().TRUELAYER_CLIENT_ID ?? '',
      client_secret: env().TRUELAYER_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
    }).toString(),
  })
}

/* --------------------------------------------------------------- data */

export type TrueLayerCard = {
  account_id: string
  card_network?: string
  card_type?: string
  currency?: string
  display_name?: string
  partial_card_number?: string
}

export type TrueLayerTx = {
  transaction_id?: string
  timestamp: string
  description: string
  amount: number
  currency: string
  transaction_type?: 'DEBIT' | 'CREDIT' | string
  merchant_name?: string
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

export async function listCards(token: string): Promise<TrueLayerCard[]> {
  const r = await jsonRequest<{ results: TrueLayerCard[] }>('TrueLayer', `${hosts().api}/data/v1/cards`, { headers: auth(token) })
  return r.results ?? []
}

export async function cardTransactions(token: string, accountId: string, from: string, to: string): Promise<TrueLayerTx[]> {
  const u = `${hosts().api}/data/v1/cards/${encodeURIComponent(accountId)}/transactions?from=${from}&to=${to}`
  const r = await jsonRequest<{ results: TrueLayerTx[] }>('TrueLayer', u, { headers: auth(token) })
  return r.results ?? []
}

export async function pendingCardTransactions(token: string, accountId: string): Promise<TrueLayerTx[]> {
  const u = `${hosts().api}/data/v1/cards/${encodeURIComponent(accountId)}/transactions/pending`
  try {
    const r = await jsonRequest<{ results: TrueLayerTx[] }>('TrueLayer', u, { headers: auth(token) })
    return r.results ?? []
  } catch {
    // Not every provider supports pending; that is not a failure of the sync.
    return []
  }
}

/** TrueLayer card amounts: DEBIT is money out. Normalised to GenAI's sign (positive = out). */
export function normaliseTrueLayerTx(t: TrueLayerTx, status: 'pending' | 'settled') {
  const pence = Math.round(Math.abs(t.amount) * 100)
  const out = t.transaction_type ? t.transaction_type.toUpperCase() !== 'CREDIT' : t.amount >= 0
  return {
    day: t.timestamp.slice(0, 10),
    postedAt: t.timestamp,
    amountPence: out ? pence : -pence,
    currency: (t.currency || 'GBP').toUpperCase(),
    descriptor: t.merchant_name ? `${t.merchant_name} ${t.description}`.trim() : t.description,
    status,
    providerTxId: t.transaction_id ?? null,
  }
}
