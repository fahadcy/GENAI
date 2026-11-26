'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { buildLandscapeAction, scanCompetitorAction } from '@/app/actions/competitors'
import { Button } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

/** Scan one competitor now, then rebuild the landscape so the plays include it. */
export function ScanButton({ id, label = 'Scan now' }: { id: string; label?: string }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      size="sm"
      variant="primary"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await scanCompetitorAction(id)
          if (r.ok) await buildLandscapeAction()
          toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Scanned' : 'Scan failed', body: r.message })
          if (r.ok) router.refresh()
        } finally {
          setBusy(false)
        }
      }}
    >
      {!busy && <RefreshCw className="h-3.5 w-3.5" />}
      {busy ? 'Reading their site, ads and reviews…' : label}
    </Button>
  )
}
