'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { runSearchAnalysisAction } from '@/app/actions/search'
import { Button } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

export function RunAnalysisButton({
  label = 'Run analysis',
  variant = 'primary',
}: {
  label?: string
  variant?: 'primary' | 'secondary'
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      size="sm"
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const res = await runSearchAnalysisAction()
          toast.push({
            tone: res.ok ? 'ok' : 'danger',
            title: res.ok ? 'Analysis finished' : 'Could not run',
            body: res.message,
          })
          if (res.ok) router.refresh()
        } finally {
          setBusy(false)
        }
      }}
    >
      {!busy && <RefreshCw className="h-3.5 w-3.5" />}
      {label}
    </Button>
  )
}
