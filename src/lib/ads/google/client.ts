import 'server-only'
import { env, hasGoogleAds } from '@/lib/env'
import { GoogleAdsError, type CallResult, type MutateOperation, type MutateResponse } from './errors'

/**
 * A small, direct client for the Google Ads REST API.
 *
 * The official Node library wraps gRPC and pulls in a large generated surface;
 * we need six endpoints, and the REST interface is stable and versioned. Doing
 * it directly also means the request and response bodies we store in the audit
 * log are literally what went over the wire, which is what you want when a
 * client asks why their campaign looks the way it does.
 *
 * Version pinning matters: Google sunsets API versions roughly every four
 * months, and an unpinned client breaks silently at a date nobody wrote down.
 * `API_VERSION` is the one contract to update, and the health check reports it.
 */

export const API_VERSION = 'v25'
const BASE = `https://googleads.googleapis.com/${API_VERSION}`
const TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token'

// The error type, the result shapes and the operation type live in `errors.ts`
// so the simulator and the UI can use them without importing this module, which
// holds credentials and must stay off the client.
export {
  GoogleAdsError,
  type CallResult,
  type MutateOperation,
  type MutateResponse,
} from './errors'

/* --------------------------------------------------------------- auth token */

type CachedToken = { accessToken: string; expiresAt: number }
let tokenCache: CachedToken | null = null

/**
 * Google access tokens last an hour. We refresh at fifty minutes so a long
 * mutate never expires mid-flight, and we cache in module scope because a
 * serverless instance handling several pushes should not re-authenticate for
 * each one.
 */
export async function accessToken(refreshTokenOverride?: string): Promise<string> {
  const e = env()
  const refreshToken = refreshTokenOverride ?? e.GOOGLE_ADS_REFRESH_TOKEN
  if (!refreshToken || !e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET) {
    throw new GoogleAdsError(
      'Google Ads is not connected. Add the client ID, client secret and refresh token in Settings.',
      { status: 401, errors: [], retryable: false },
    )
  }

  const now = Date.now()
  if (!refreshTokenOverride && tokenCache && tokenCache.expiresAt > now) return tokenCache.accessToken

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: e.GOOGLE_ADS_CLIENT_ID,
      client_secret: e.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  })

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !body.access_token) {
    const isRevoked = body.error === 'invalid_grant'
    throw new GoogleAdsError(
      isRevoked
        ? 'Google has rejected the saved permission for this account. Someone needs to reconnect it — this usually means the password changed, access was revoked, or the token went unused for six months.'
        : `Google would not issue an access token: ${body.error_description ?? body.error ?? res.statusText}`,
      {
        status: res.status,
        errors: body.error ? [{ code: body.error, message: body.error_description ?? '' }] : [],
        raw: body,
        retryable: !isRevoked && res.status >= 500,
      },
    )
  }

  const token = { accessToken: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 - 600_000 }
  if (!refreshTokenOverride) tokenCache = token
  return token.accessToken
}

/** Exported for tests and for the "reconnect" action, which must not reuse a stale token. */
export function clearTokenCache() {
  tokenCache = null
}

/* ------------------------------------------------------------------ request */

export type CallContext = {
  /** 10 digits, no dashes. The account the campaign is created in. */
  customerId: string
  /** Manager account, when acting on a client's behalf. Sent as login-customer-id. */
  loginCustomerId?: string | null
  refreshToken?: string
}

/** Google accepts customer ids as digits only; users paste them with dashes. */
export const normaliseCustomerId = (id: string): string => id.replace(/\D/g, '')

export function formatCustomerId(id: string): string {
  const d = normaliseCustomerId(id)
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  ctx: CallContext,
  attempt = 1,
): Promise<CallResult<T>> {
  const e = env()
  const token = await accessToken(ctx.refreshToken)

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'developer-token': e.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
    'content-type': 'application/json',
  }
  const login = ctx.loginCustomerId ? normaliseCustomerId(ctx.loginCustomerId) : ''
  if (login && login !== normaliseCustomerId(ctx.customerId)) headers['login-customer-id'] = login

  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // A large mutate is slow; a hung one is worse than a failed one.
    signal: AbortSignal.timeout(60_000),
  })

  const requestId = res.headers.get('request-id') ?? undefined
  const text = await res.text()
  const parsed: unknown = text ? safeJson(text) : {}

  if (res.ok) return { data: parsed as T, requestId, status: res.status }

  const errors = extractErrors(parsed)
  const retryable = RETRYABLE_STATUS.has(res.status) || errors.some((x) => x.code === 'RESOURCE_EXHAUSTED')

  // Google rate-limits per developer token; one backoff is worth trying before
  // handing a failure to someone who has no idea what a quota is.
  if (retryable && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 1500))
    return call<T>(path, init, ctx, attempt + 1)
  }

  throw new GoogleAdsError(explain(res.status, errors), {
    status: res.status,
    requestId,
    errors,
    raw: parsed,
    retryable,
  })
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Google nests errors several layers deep and in two different shapes depending
 * on whether the failure was in the request envelope or in one of the
 * operations. Both are flattened to the same thing.
 */
function extractErrors(payload: unknown): { code: string; message: string; field?: string }[] {
  const out: { code: string; message: string; field?: string }[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>

    if (typeof obj.message === 'string' && (obj.errorCode || obj.location)) {
      const codeObj = (obj.errorCode ?? {}) as Record<string, unknown>
      const code = Object.entries(codeObj)
        .map(([k, v]) => (typeof v === 'string' ? v : k))
        .join('.')
      const location = obj.location as { fieldPathElements?: { fieldName?: string }[] } | undefined
      out.push({
        code: code || 'UNKNOWN',
        message: obj.message,
        field: location?.fieldPathElements?.map((f) => f.fieldName).filter(Boolean).join('.'),
      })
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(payload)

  if (out.length === 0 && payload && typeof payload === 'object') {
    const err = (payload as { error?: { message?: string; status?: string } }).error
    if (err?.message) out.push({ code: err.status ?? 'ERROR', message: err.message })
  }
  return out
}

/**
 * Turns Google's error vocabulary into something a business owner can act on.
 * Anything we do not recognise falls through to Google's own message, which is
 * at least accurate — but the recognised set covers what actually goes wrong in
 * practice on a first connection.
 */
function explain(status: number, errors: { code: string; message: string; field?: string }[]): string {
  const codes = errors.map((e) => e.code).join(' ')

  if (status === 401) {
    return 'Google rejected the credentials. The access token or developer token is wrong, or the developer token has not been approved yet.'
  }
  if (/DEVELOPER_TOKEN_NOT_APPROVED/.test(codes)) {
    return 'Your Google developer token is still at test level, so it can only touch test accounts. Apply for Basic access in the API Center of your manager account — Google reviews it by hand and it usually takes a few working days.'
  }
  if (/DEVELOPER_TOKEN_PROHIBITED|OAUTH_TOKEN_HEADER_INVALID/.test(codes)) {
    return 'The developer token is not permitted to use this API. Check it was copied from the API Center of a manager account, not a normal one.'
  }
  if (/CUSTOMER_NOT_ENABLED|CUSTOMER_NOT_FOUND/.test(codes)) {
    return 'That Google Ads account is not active, or the connected login cannot see it. Check the account number and that billing is set up.'
  }
  if (/USER_PERMISSION_DENIED|NOT_ADS_USER/.test(codes)) {
    return 'The connected Google login does not have permission on that account. Ask whoever manages it to grant admin access, then reconnect.'
  }
  if (/RESOURCE_EXHAUSTED|QUOTA/.test(codes)) {
    return 'Google is rate-limiting this account. Nothing is wrong — wait a few minutes and push again.'
  }
  if (/BUDGET_ERROR|MONEY_AMOUNT/.test(codes)) {
    return `Google would not accept the budget: ${errors[0]?.message ?? 'check the amount and currency.'}`
  }
  if (/AD_ERROR|AD_CUSTOMIZER|STRING_LENGTH/.test(codes)) {
    return `Google rejected the ad text: ${errors[0]?.message ?? 'a headline or description breaks its rules.'}`
  }
  if (/CONCURRENT_MODIFICATION/.test(codes)) {
    return 'Someone changed this account in Google Ads at the same moment. Nothing was created — try again.'
  }
  if (status === 403) {
    return 'Google refused the request. Most often this means the developer token is not approved for live accounts yet.'
  }

  const first = errors[0]
  return first
    ? `Google rejected the request: ${first.message}${first.field ? ` (${first.field})` : ''}`
    : `Google returned an unexpected error (HTTP ${status}).`
}

/* ---------------------------------------------------------------- endpoints */

/** Accounts the connected login can act on. Returns resource names. */
export async function listAccessibleCustomers(): Promise<string[]> {
  const token = await accessToken()
  const e = env()
  const res = await fetch(`${BASE}/customers:listAccessibleCustomers`, {
    headers: {
      authorization: `Bearer ${token}`,
      'developer-token': e.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
    },
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => ({}))) as { resourceNames?: string[] }
  if (!res.ok) {
    throw new GoogleAdsError(explain(res.status, extractErrors(body)), {
      status: res.status,
      requestId: res.headers.get('request-id') ?? undefined,
      errors: extractErrors(body),
      raw: body,
      retryable: RETRYABLE_STATUS.has(res.status),
    })
  }
  return body.resourceNames ?? []
}

export type CustomerInfo = {
  customerId: string
  descriptiveName: string
  currencyCode: string
  timeZone: string
  isManager: boolean
  testAccount: boolean
}

/** GAQL over REST. Used for account details and for pulling live performance back. */
export async function search<T = Record<string, unknown>>(
  query: string,
  ctx: CallContext,
): Promise<T[]> {
  const rows: T[] = []
  let pageToken: string | undefined
  do {
    const { data } = await call<{ results?: T[]; nextPageToken?: string }>(
      `/customers/${normaliseCustomerId(ctx.customerId)}/googleAds:search`,
      { method: 'POST', body: { query, pageSize: 1000, pageToken } },
      ctx,
    )
    rows.push(...(data.results ?? []))
    pageToken = data.nextPageToken
  } while (pageToken && rows.length < 10_000)
  return rows
}

export async function describeCustomer(ctx: CallContext): Promise<CustomerInfo> {
  const rows = await search<{
    customer?: {
      id?: string
      descriptiveName?: string
      currencyCode?: string
      timeZone?: string
      manager?: boolean
      testAccount?: boolean
    }
  }>(
    `SELECT customer.id, customer.descriptive_name, customer.currency_code,
            customer.time_zone, customer.manager, customer.test_account
     FROM customer LIMIT 1`,
    ctx,
  )
  const c = rows[0]?.customer
  if (!c?.id) {
    throw new GoogleAdsError('Google returned no details for that account number.', {
      status: 404,
      errors: [],
      retryable: false,
    })
  }
  return {
    customerId: c.id,
    descriptiveName: c.descriptiveName ?? formatCustomerId(c.id),
    currencyCode: c.currencyCode ?? 'GBP',
    timeZone: c.timeZone ?? 'Europe/London',
    isManager: Boolean(c.manager),
    testAccount: Boolean(c.testAccount),
  }
}

/** Conversion actions available in the account, so the user picks rather than types. */
export async function listConversionActions(
  ctx: CallContext,
): Promise<{ resourceName: string; name: string; category: string; status: string }[]> {
  const rows = await search<{
    conversionAction?: { resourceName?: string; name?: string; category?: string; status?: string }
  }>(
    `SELECT conversion_action.resource_name, conversion_action.name,
            conversion_action.category, conversion_action.status
     FROM conversion_action WHERE conversion_action.status = 'ENABLED'`,
    ctx,
  )
  return rows
    .map((r) => r.conversionAction)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.resourceName))
    .map((c) => ({
      resourceName: c.resourceName!,
      name: c.name ?? 'Untitled',
      category: c.category ?? 'DEFAULT',
      status: c.status ?? 'ENABLED',
    }))
}

/* -------------------------------------------------------------------- mutate */

/**
 * One atomic call that creates the budget, campaign, ad groups, ads and
 * keywords together, using temporary resource ids to link them.
 *
 * Atomicity is the point. The alternative — five sequential calls — leaves an
 * orphaned budget and a half-built campaign in the client's account whenever
 * step three fails, and someone has to go in and clean it up by hand.
 *
 * `validateOnly` asks Google to check the whole thing and create nothing. We
 * run that first on every push, so the failure a user sees is a dry run.
 */
export async function mutate(
  operations: MutateOperation[],
  ctx: CallContext,
  options: { validateOnly?: boolean } = {},
): Promise<CallResult<MutateResponse>> {
  return call<MutateResponse>(
    `/customers/${normaliseCustomerId(ctx.customerId)}/googleAds:mutate`,
    {
      method: 'POST',
      body: {
        mutateOperations: operations,
        validateOnly: options.validateOnly ?? false,
        // Partial failure would leave a partly-built campaign; we want all or nothing.
        partialFailure: false,
        responseContentType: 'RESOURCE_NAME_ONLY',
      },
    },
    ctx,
  )
}

/** Enable or pause a campaign that already exists. The only write after launch. */
export async function setCampaignStatus(
  campaignResourceName: string,
  status: 'ENABLED' | 'PAUSED',
  ctx: CallContext,
): Promise<CallResult<MutateResponse>> {
  return call<MutateResponse>(
    `/customers/${normaliseCustomerId(ctx.customerId)}/campaigns:mutate`,
    {
      method: 'POST',
      body: {
        operations: [
          { update: { resourceName: campaignResourceName, status }, updateMask: 'status' },
        ],
        responseContentType: 'RESOURCE_NAME_ONLY',
      },
    },
    ctx,
  )
}

export const googleAdsConfigured = hasGoogleAds
