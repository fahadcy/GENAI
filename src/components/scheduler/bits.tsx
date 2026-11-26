'use client'

import * as React from 'react'
import { CalendarX2, Gauge, Layers, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/primitives'
import type { ConflictView } from './types'
import { fmtHourLabel } from './time'

const KIND_META: Record<
  ConflictView['kind'],
  { label: string; icon: React.ComponentType<{ className?: string }>; hard: boolean }
> = {
  approval: { label: 'Approval gate', icon: ShieldAlert, hard: true },
  blackout: { label: 'Blackout window', icon: CalendarX2, hard: false },
  frequency: { label: 'Frequency cap', icon: Gauge, hard: false },
  collision: { label: 'Collision', icon: Layers, hard: false },
}

export function ConflictList({
  conflicts,
  tz,
  onUseSuggestion,
}: {
  conflicts: ConflictView[]
  tz: string
  onUseSuggestion?: (iso: string) => void
}) {
  return (
    <ul className="space-y-2">
      {conflicts.map((c, i) => {
        const meta = KIND_META[c.kind]
        const Icon = meta.icon
        const suggestion = c.suggestion ? new Date(c.suggestion) : null
        return (
          <li
            key={i}
            className={cn(
              'flex items-start gap-2.5 rounded-lg p-2.5',
              meta.hard ? 'bg-danger-bg' : 'bg-warn-bg',
            )}
          >
            <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', meta.hard ? 'text-danger-fg' : 'text-warn-fg')} />
            <div className="min-w-0 flex-1">
              <p className={cn('text-[13px] font-semibold', meta.hard ? 'text-danger-fg' : 'text-warn-fg')}>
                {c.message}
              </p>
              {c.detail && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{c.detail}</p>}
              {suggestion && onUseSuggestion && (
                <button
                  onClick={() => onUseSuggestion(suggestion.toISOString())}
                  className="mt-1.5 text-xs font-semibold text-brand-600 underline-offset-2 hover:underline"
                >
                  Move to{' '}
                  {suggestion.toLocaleString('en-GB', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: tz,
                  })}{' '}
                  instead
                </button>
              )}
            </div>
            <Badge tone={meta.hard ? 'danger' : 'warn'}>{meta.label}</Badge>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The hour-by-hour weighting behind a send-time suggestion. A single
 * recommended hour is a claim; the shape of the distribution is the evidence.
 */
export function SendTimeHistogram({
  distribution,
  bestHour,
}: {
  distribution: { hour: number; weight: number }[]
  bestHour: number
}) {
  const max = Math.max(...distribution.map((d) => d.weight), 0.0001)
  return (
    <div>
      <div className="flex h-12 items-end gap-px">
        {distribution.map((d) => (
          <div
            key={d.hour}
            className="group relative flex-1"
            title={`${fmtHourLabel(d.hour)} — ${(d.weight * 100).toFixed(1)}% of the modelled weight`}
          >
            <div
              className={cn(
                'w-full rounded-sm transition-colors',
                d.hour === bestHour ? 'bg-brand-600' : 'bg-brand-200',
              )}
              style={{ height: `${Math.max(2, (d.weight / max) * 46)}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-ink-faint">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
    </div>
  )
}

/** SC-2: whether a slot was model-chosen or set by hand, always visible. */
export function SourceBadge({ source, lift }: { source: string; lift: number | null }) {
  if (source === 'ai') {
    return (
      <Badge tone="brand">
        AI slot{lift ? ` · +${Math.round(lift * 100)}%` : ''}
      </Badge>
    )
  }
  return <Badge tone="neutral">Manual slot</Badge>
}
