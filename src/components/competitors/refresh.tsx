'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, CircleAlert, RefreshCw, Search } from 'lucide-react'
import {
  buildLandscapeAction,
  discoverAction,
  scanCompetitorAction,
  scanSelfAction,
} from '@/app/actions/competitors'
import { Button, Card, ProgressBar, Spinner } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { cn } from '@/lib/cn'

/**
 * Runs a refresh as a sequence of short server calls — find competitors,
 * read your own presence, scan each tracked competitor, then build the
 * analysis — and shows each step as it happens. Short calls keep any one slow
 * website from timing out the whole refresh; the progress makes a minute of
 * work feel like a minute rather than a hang.
 */

type Step = { key: string; label: string; state: 'waiting' | 'running' | 'done' | 'failed'; note?: string }

export function useRefresh() {
  const router = useRouter()
  const toast = useToast()
  const [steps, setSteps] = React.useState<Step[]>([])
  const [busy, setBusy] = React.useState(false)

  const set = (key: string, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))

  const run = React.useCallback(
    async (opts: { discover: boolean; trackedIds: { id: string; name: string }[] }) => {
      if (busy) return
      setBusy(true)
      const initial: Step[] = [
        ...(opts.discover ? [{ key: 'discover', label: 'Finding competitors', state: 'waiting' as const }] : []),
        { key: 'self', label: 'Reading your own website and search presence', state: 'waiting' },
        ...opts.trackedIds.map((t) => ({ key: `scan:${t.id}`, label: `Scanning ${t.name}`, state: 'waiting' as const })),
        { key: 'landscape', label: 'Comparing everyone and writing the plays', state: 'waiting' },
      ]
      setSteps(initial)
      let tracked = opts.trackedIds
      try {
        if (opts.discover) {
          set('discover', { state: 'running' })
          const d = await discoverAction()
          if (!d.ok) {
            set('discover', { state: 'failed', note: d.message })
            toast.push({ tone: 'danger', title: 'Discovery failed', body: d.message })
            return
          }
          set('discover', { state: 'done', note: d.message })
          router.refresh()
          // Discovery may have started tracking competitors; scan those.
          tracked = d.data?.tracked ?? []
          setSteps((prev) => {
            const head = prev.filter((s) => !s.key.startsWith('scan:') && s.key !== 'landscape')
            return [
              ...head,
              ...tracked.map((t) => ({ key: `scan:${t.id}`, label: `Scanning ${t.name}`, state: 'waiting' as const })),
              { key: 'landscape', label: 'Comparing everyone and writing the plays', state: 'waiting' as const },
            ]
          })
        }

        set('self', { state: 'running' })
        const self = await scanSelfAction()
        set('self', { state: self.ok ? 'done' : 'failed', note: self.message })

        // Two at a time: fast enough, gentle on the sites being read.
        const queue = [...tracked]
        let failed = 0
        const worker = async () => {
          while (queue.length) {
            const t = queue.shift()!
            set(`scan:${t.id}`, { state: 'running' })
            const r = await scanCompetitorAction(t.id)
            if (!r.ok) failed++
            set(`scan:${t.id}`, { state: r.ok ? 'done' : 'failed', note: r.message, label: r.ok ? `Scanned ${t.name}` : `Could not scan ${t.name}` })
          }
        }
        await Promise.all([worker(), worker()])

        if (tracked.length === 0) {
          set('landscape', { state: 'failed', note: 'Track at least one competitor first.' })
          return
        }
        set('landscape', { state: 'running' })
        const l = await buildLandscapeAction()
        set('landscape', { state: l.ok ? 'done' : 'failed', note: l.message })
        toast.push({
          tone: l.ok && failed === 0 ? 'ok' : l.ok ? 'info' : 'danger',
          title: l.ok ? 'Competitor analysis updated' : 'Could not finish',
          body: failed ? `${l.message} ${failed} scan${failed === 1 ? '' : 's'} failed; see the steps.` : l.message,
        })
        router.refresh()
      } catch (e) {
        // A dropped connection or a redeploy mid-refresh: say so rather than spin.
        setSteps((prev) => prev.map((s) => (s.state === 'running' || s.state === 'waiting' ? { ...s, state: 'failed', note: 'Interrupted.' } : s)))
        toast.push({ tone: 'danger', title: 'Refresh interrupted', body: e instanceof Error ? e.message : 'The connection was lost. Run it again.' })
      } finally {
        setBusy(false)
      }
    },
    [busy, router, toast],
  )

  return { run, steps, busy, clear: () => setSteps([]) }
}

export function RefreshProgress({ steps, busy, onClose }: { steps: Step[]; busy: boolean; onClose?: () => void }) {
  if (steps.length === 0) return null
  const done = steps.filter((s) => s.state === 'done' || s.state === 'failed').length
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-ink">
          {busy ? 'Working…' : 'Finished'} <span className="tnum text-ink-faint">{done}/{steps.length}</span>
        </p>
        {!busy && onClose && (
          <Button size="xs" variant="ghost" onClick={onClose}>
            Hide
          </Button>
        )}
      </div>
      <ProgressBar value={done} max={steps.length} />
      <ol className="mt-3 space-y-1.5">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 text-[13px]">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              {s.state === 'running' ? (
                <Spinner className="h-3.5 w-3.5 text-brand-600" />
              ) : s.state === 'done' ? (
                <Check className="h-3.5 w-3.5 text-ok-fg" />
              ) : s.state === 'failed' ? (
                <CircleAlert className="h-3.5 w-3.5 text-danger-fg" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
              )}
            </span>
            <span className="min-w-0">
              <span className={cn(s.state === 'waiting' ? 'text-ink-faint' : 'text-ink')}>{s.label}</span>
              {s.note && s.state === 'failed' && <span className="block text-xs text-danger-fg">{s.note}</span>}
              {s.note && s.state === 'done' && s.key !== 'self' && !s.key.startsWith('scan:') && (
                <span className="block text-xs text-ink-faint">{s.note}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/** The page-level buttons: refresh everything, or look for new competitors too. */
export function RefreshControls({
  trackedIds,
  canAnalyse,
  compact,
}: {
  trackedIds: { id: string; name: string }[]
  canAnalyse: boolean
  compact?: boolean
}) {
  const { run, steps, busy, clear } = useRefresh()
  if (!canAnalyse) return null
  return (
    <div className="space-y-3">
      <div className={cn('flex flex-wrap items-center gap-2', compact && 'justify-end')}>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run({ discover: true, trackedIds })}>
          {!busy && <Search className="h-3.5 w-3.5" />}
          Find competitors
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={trackedIds.length === 0}
          onClick={() => run({ discover: false, trackedIds })}
        >
          {!busy && <RefreshCw className="h-3.5 w-3.5" />}
          Rescan and analyse
        </Button>
      </div>
      {!compact && <RefreshProgress steps={steps} busy={busy} onClose={clear} />}
    </div>
  )
}
