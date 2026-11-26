import { NextResponse, type NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { nonceMatches, NONCE_COOKIE, verifyCardState } from '@/lib/budget/cards/truelayer'
import { getAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { connectTrueLayer, BudgetError } from '@/lib/budget/service'
import { CardApiError } from '@/lib/budget/cards/http'

/**
 * Where TrueLayer sends the person back after they approve read-only access
 * to their card at the bank.
 *
 * Reachable by anyone, so nothing in the query string is trusted except what
 * the signed `state` proves: which workspace and person started the flow, in
 * the last fifteen minutes. The code is exchanged server-side; the browser
 * never sees a token. Success or failure, the person lands back on the
 * budget's card tab with a sentence.
 */
export const dynamic = 'force-dynamic'

function back(message: string, tone: 'ok' | 'error'): NextResponse {
  const url = new URL('/budget', env().APP_URL)
  url.searchParams.set('tab', 'cards')
  url.searchParams.set('connect', tone)
  url.searchParams.set('message', message)
  const res = NextResponse.redirect(url)
  // Single use: the nonce is spent whatever happens next.
  res.cookies.set(NONCE_COOKIE, '', { path: '/api/budget/truelayer', maxAge: 0 })
  return res
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = request.nextUrl.searchParams
  const state = verifyCardState(q.get('state') ?? '')
  if (!state) return back('That bank connection link has expired. Start again.', 'error')
  // Bound to the browser and the person who started it.
  if (!nonceMatches(request.cookies.get(NONCE_COOKIE)?.value, state.nonce)) {
    return back('This bank connection was started in a different browser. Start it again from the Cards tab.', 'error')
  }
  const auth = await getAuth()
  if (!auth || auth.user.id !== state.userId || auth.workspace.id !== state.workspaceId || !can(auth.role, 'budget:cards')) {
    return back('Sign in as the person who started the bank connection, in the same workspace, and start again.', 'error')
  }
  if (q.get('error')) return back('The bank connection was cancelled.', 'error')
  const code = q.get('code')
  if (!code || code.length > 2048) return back('The bank did not return an authorisation code.', 'error')
  try {
    const cards = await connectTrueLayer({ workspaceId: state.workspaceId, actorId: state.userId, code })
    return back(`${cards.length} card${cards.length === 1 ? '' : 's'} connected (read-only).`, 'ok')
  } catch (e) {
    const msg = e instanceof BudgetError || e instanceof CardApiError ? e.message : 'The bank connection failed.'
    if (!(e instanceof BudgetError)) console.error('truelayer callback failed', e)
    return back(msg, 'error')
  }
}
