import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { applyOptOut } from '@/lib/channels/optout'

/**
 * One-click unsubscribe (RFC 8058).
 *
 * This is the URL that goes in the `List-Unsubscribe` header, which is why it
 * has to answer POST: Gmail and Outlook show a native unsubscribe button beside
 * the sender, and pressing it sends a POST here with no interaction of any kind.
 * Since 2024 bulk senders are required to support this, and in practice it is
 * also the best deliverability protection there is — people press the button
 * instead of the spam report, and it is the spam report that wrecks a sending
 * reputation.
 *
 * A human who clicks the link in the footer goes to /unsubscribe/[token]
 * instead, which renders a page. This route redirects GET there so both paths
 * work from the same URL.
 */

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params
  const result = await applyOptOut(token, 'one-click')

  // Always 200. A mail provider treats anything else as a broken unsubscribe
  // and counts it against the sender — including for a token that was already
  // used, which is a success from the recipient's point of view.
  return NextResponse.json({ ok: result.ok }, { status: 200 })
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params
  return NextResponse.redirect(new URL(`/unsubscribe/${token}`, env().APP_URL))
}
