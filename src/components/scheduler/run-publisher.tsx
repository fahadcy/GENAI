'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { PlayCircle } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { runPublisherAction } from '@/app/actions/scheduler'

/**
 * SC-4: run the publish worker on demand rather than waiting for the cron tick.
 * Useful when a channel has just come back and a batch of retries is waiting.
 */
export function RunPublisherButton({ dueNow, retrying }: { dueNow: number; retrying: number }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)

  const pending = dueNow + retrying

  return (
    <Button
      size="sm"
      variant={pending > 0 ? 'primary' : 'secondary'}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await runPublisherAction()
          toast.push({
            tone: r.ok ? 'ok' : 'danger',
            title: r.ok ? 'Publisher run' : 'Could not run the publisher',
            body: r.message,
          })
          router.refresh()
        } finally {
          setBusy(false)
        }
      }}
    >
      <PlayCircle className="h-4 w-4" />
      Run publisher
      {pending > 0 && <span className="tnum ml-0.5 opacity-80">{pending}</span>}
    </Button>
  )
}
