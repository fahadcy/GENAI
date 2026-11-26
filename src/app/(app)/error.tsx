'use client'

import * as React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button, LinkButton } from '@/components/ui/primitives'

/**
 * What someone sees when a page throws.
 *
 * Without this file Next renders its own fallback: a blank white page with
 * "Application error: a server-side exception has occurred" and a hash, outside
 * the app shell, with no navigation and no way back. This keeps them inside the
 * product, tells them what to do, and — importantly — offers a retry, because
 * most failures here are a dropped database connection that succeeds a second
 * later.
 *
 * The digest is shown deliberately. It is the only handle support has on which
 * server error this was; the message itself is withheld by Next in production
 * precisely so it cannot leak internals.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-danger-fg/30 bg-danger-bg">
          <AlertTriangle className="h-5 w-5 text-danger-fg" aria-hidden />
        </div>

        <h1 className="text-lg font-semibold text-ink">This screen did not load</h1>

        <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-ink-muted">
          Something failed on the server rather than in your browser. Nothing you were
          working on has been lost — it is still saved.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" size="md" onClick={reset}>
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
          <LinkButton href="/command-center" size="md" variant="secondary">
            Back to the dashboard
          </LinkButton>
        </div>

        {error.digest && (
          <p className="mt-6 font-mono text-[11px] text-ink-faint">
            Reference {error.digest}
          </p>
        )}
      </div>
    </div>
  )
}
