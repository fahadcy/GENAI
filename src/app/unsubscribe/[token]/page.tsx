import type { Metadata } from 'next'
import { applyOptOut } from '@/lib/channels/optout'

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'

/**
 * The page a recipient lands on from an email footer.
 *
 * Deliberately outside the app's route groups: whoever clicks this has no
 * account, no session, and no reason to see product branding or a sign-in
 * prompt. It is also self-contained rather than using the design system, so it
 * cannot break when the app's shell changes.
 *
 * The opt-out is applied on load rather than behind a confirm button. Asking
 * someone to confirm they meant to unsubscribe is a dark pattern, and a mail
 * client that prefetches the link would leave them in limbo — better that the
 * click is the action, and the page reports what happened.
 */
export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const result = await applyOptOut(token, 'link')

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1.25rem',
        background: '#fbfafd',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        color: '#16141f',
      }}
    >
      <div
        style={{
          maxWidth: '30rem',
          width: '100%',
          background: '#ffffff',
          border: '1px solid #e4e1ec',
          borderRadius: '12px',
          padding: '2rem 1.75rem',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '2.75rem',
            height: '2.75rem',
            margin: '0 auto 1.25rem',
            borderRadius: '999px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.25rem',
            background: result.ok ? '#e8f5ee' : '#fceef0',
            color: result.ok ? '#1f6b4a' : '#a32c3e',
          }}
        >
          {result.ok ? '✓' : '!'}
        </div>

        <h1 style={{ fontSize: '1.15rem', fontWeight: 600, margin: '0 0 0.65rem' }}>
          {result.ok
            ? result.alreadyDone
              ? 'Already unsubscribed'
              : 'Unsubscribed'
            : 'This link is not valid'}
        </h1>

        <p style={{ margin: 0, fontSize: '0.95rem', lineHeight: 1.6, color: '#4a4557' }}>
          {result.message}
        </p>

        {result.senderName && result.ok && (
          <p style={{ margin: '1.25rem 0 0', fontSize: '0.85rem', color: '#736d82' }}>
            Sender: {result.senderName}
          </p>
        )}

        <p style={{ margin: '1.5rem 0 0', fontSize: '0.8rem', color: '#736d82', lineHeight: 1.6 }}>
          This takes effect immediately. If anything arrives after today, reply to it and say
          so — that would be a fault worth knowing about.
        </p>
      </div>
    </main>
  )
}
