'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Badge, Button, Card, Spinner } from '@/components/ui/primitives'
import { replayVideoAction, videoStatusAction } from '@/app/actions/video'

/**
 * The clip gallery.
 *
 * Generation takes minutes rather than milliseconds, so this polls while
 * anything is in flight and stops the moment nothing is. What it shows while
 * waiting matters: a spinner with no state leaves people refreshing the page,
 * so each card names the step it is on and the clip appears the moment it can
 * be played.
 */

export type GalleryItem = {
  id: string
  title: string
  status: string
  version: number
  simulated: boolean
  playbackUrl: string | null
  mediaCheckPassed: boolean | null
  blockingFindings: string[]
  lastError: string | null
  actualCostCents: number | null
  estimatedCostCents: number
  durationSeconds: number | null
  width: number | null
  height: number | null
  hasAudio: boolean | null
  watermark: string | null
}

const IN_FLIGHT = new Set(['queued', 'submitted', 'generating', 'storing'])

const STEP_LABEL: Record<string, string> = {
  queued: 'Queued',
  submitted: 'Sent to the provider',
  generating: 'Rendering',
  storing: 'Saving the file',
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export function VideoGallery({ initial }: { initial: GalleryItem[] }) {
  const [items, setItems] = useState(initial)
  const [pending, start] = useTransition()

  useEffect(() => setItems(initial), [initial])

  const anyInFlight = items.some((i) => IN_FLIGHT.has(i.status))

  const refresh = useCallback(async () => {
    if (items.length === 0) return
    const res = await videoStatusAction(items.map((i) => i.id))
    if (res.ok && res.data) {
      const byId = new Map(res.data.map((r) => [r.id, r]))
      setItems((prev) => prev.map((p) => (byId.get(p.id) as GalleryItem | undefined) ?? p))
    }
  }, [items])

  useEffect(() => {
    if (!anyInFlight) return
    const t = setInterval(refresh, 4_000)
    return () => clearInterval(t)
  }, [anyInFlight, refresh])

  if (items.length === 0) return null

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <Card key={item.id} className="flex flex-col overflow-hidden">
          <div className="relative flex min-h-[12rem] items-center justify-center bg-bg-inset">
            {item.playbackUrl ? (
              <video
                src={item.playbackUrl}
                controls
                playsInline
                preload="metadata"
                className="max-h-72 w-full bg-black object-contain"
              />
            ) : IN_FLIGHT.has(item.status) ? (
              <div className="flex flex-col items-center gap-2 py-10 text-ink-faint">
                <Spinner className="h-5 w-5" />
                <span className="text-xs">{STEP_LABEL[item.status] ?? 'Working'}…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <TriangleAlert className="h-5 w-5 text-danger-fg" />
                <span className="text-xs text-danger-fg">{item.lastError ?? 'This generation failed.'}</span>
              </div>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <Link href={`/studio/video/${item.id}`} className="text-sm font-semibold text-ink hover:underline">
                {item.title}
              </Link>
              {item.simulated && <Badge tone="info">Simulated</Badge>}
            </div>

            <dl className="space-y-1 text-2xs text-ink-faint">
              {item.width && item.height && (
                <div className="flex justify-between gap-2">
                  <dt>Delivered</dt>
                  <dd className="tabular-nums text-ink-muted">
                    {item.width}×{item.height}
                    {item.durationSeconds ? ` · ${item.durationSeconds.toFixed(1)}s` : ''}
                    {item.hasAudio === false ? ' · silent' : ''}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt>Cost</dt>
                <dd className="tabular-nums text-ink-muted">
                  {money(item.actualCostCents ?? item.estimatedCostCents)}
                  {item.simulated && ' (not billed)'}
                </dd>
              </div>
              {item.watermark && (
                <div className="flex justify-between gap-2">
                  <dt>Provenance</dt>
                  <dd className="text-ink-muted">{item.watermark}</dd>
                </div>
              )}
            </dl>

            {item.mediaCheckPassed === false && (
              <div className="rounded-md bg-danger-bg p-2 text-2xs text-danger-fg">
                <p className="font-semibold">Would be rejected at upload</p>
                <ul className="mt-1 space-y-0.5">
                  {item.blockingFindings.slice(0, 2).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            {item.mediaCheckPassed === true && (
              <p className="flex items-center gap-1.5 text-2xs text-ok-fg">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Delivery checks passed
              </p>
            )}

            <div className="mt-auto flex gap-2 pt-1">
              {item.status === 'dead_letter' ? (
                <Button
                  size="sm"
                  loading={pending}
                  onClick={() => start(async () => { await replayVideoAction(item.id); await refresh() })}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </Button>
              ) : (
                <Link
                  href={`/studio/video/${item.id}`}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  Open →
                </Link>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
