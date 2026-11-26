'use client'

import * as React from 'react'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CardHeader, EmptyState } from '@/components/ui/primitives'
import { channelLabel, formatPercent } from '@/components/domain'

export type SendTimeGroup = {
  source: 'ai' | 'manual'
  items: number
  impressions: number
  opens: number
  clicks: number
  conversions: number
  signups: number
  spend: number
}

type Metric = {
  key: string
  label: string
  hint: string
  ai: number | null
  manual: number | null
  format: (v: number) => string
}

/**
 * PF-2, the decision half: attribution for a choice rather than a channel.
 *
 * A dumbbell is the right form for before/after on the same measure — the gap
 * between the two dots *is* the finding, and it stays readable at three rows
 * where a grouped bar chart would need six bars and a legend to say less. Both
 * ends carry their value as a direct label, so the comparison never depends on
 * reading a colour.
 */
export function SendTimePanel({
  ai,
  manual,
  predictedLift,
  channels,
  rangeDays,
}: {
  ai: SendTimeGroup
  manual: SendTimeGroup
  predictedLift: number | null
  channels: string[]
  rangeDays: number
}) {
  const rate = (num: number, den: number) => (den > 0 ? num / den : null)

  const metrics: Metric[] = [
    {
      key: 'ctr',
      label: 'Click-through rate',
      hint: 'clicks ÷ impressions',
      ai: rate(ai.clicks, ai.impressions),
      manual: rate(manual.clicks, manual.impressions),
      format: (v) => formatPercent(v, 2),
    },
    {
      key: 'cvr',
      label: 'Click-to-conversion',
      hint: 'conversions ÷ clicks',
      ai: rate(ai.conversions, ai.clicks),
      manual: rate(manual.conversions, manual.clicks),
      format: (v) => formatPercent(v, 1),
    },
    {
      key: 'sur',
      label: 'Signups per 1k impressions',
      hint: 'signups ÷ impressions × 1,000',
      ai: rate(ai.signups * 1000, ai.impressions),
      manual: rate(manual.signups * 1000, manual.impressions),
      format: (v) => v.toFixed(2),
    },
  ]

  const ctr = metrics[0]
  const realisedLift =
    ctr.ai !== null && ctr.manual !== null && ctr.manual > 0 ? ctr.ai / ctr.manual - 1 : null

  const hasBoth = ai.items > 0 && manual.items > 0

  return (
    <div className="card flex flex-col">
      <CardHeader
        title="AI send time vs. hand-picked"
        description="Results for sends the scheduler placed, against sends a person placed."
        icon={<Clock className="h-4 w-4" />}
      />

      {!hasBoth ? (
        <EmptyState
          icon={<Clock className="h-5 w-5" />}
          title="Not enough of both kinds yet"
          description={
            ai.items === 0 && manual.items === 0
              ? 'Nothing has published inside this window, so there is no send to attribute either way.'
              : ai.items === 0
                ? 'Every send in this window had its slot chosen by hand. Accept an AI slot on the scheduler and the comparison starts building.'
                : 'Every send in this window used an AI-chosen slot, so there is no hand-picked control to compare against.'
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-line px-5 py-2.5">
            <LegendKey
              filled
              color="rgb(var(--series-1))"
              label="AI-chosen slot"
              detail={`${ai.items} send${ai.items === 1 ? '' : 's'}`}
            />
            <LegendKey
              color="rgb(var(--ink-faint))"
              label="Hand-picked"
              detail={`${manual.items} send${manual.items === 1 ? '' : 's'}`}
            />
          </div>

          <div className="space-y-4 px-5 py-4">
            {metrics.map((m) => (
              <DumbbellRow key={m.key} metric={m} />
            ))}
          </div>

          <div className="mt-auto space-y-1.5 border-t border-line bg-bg-subtle px-5 py-3">
            {predictedLift !== null && realisedLift !== null && (
              <p className="text-xs leading-relaxed text-ink-muted">
                The scheduler predicted{' '}
                <span className="tnum font-semibold text-ink">
                  +{formatPercent(predictedLift, 0)}
                </span>{' '}
                on average for these AI slots and delivered{' '}
                <span
                  className={cn(
                    'tnum font-semibold',
                    realisedLift >= 0 ? 'text-ok-fg' : 'text-danger-fg',
                  )}
                >
                  {realisedLift >= 0 ? '+' : '−'}
                  {formatPercent(Math.abs(realisedLift), 0)}
                </span>{' '}
                on click-through. Holding the model to its own forecast is the point of showing
                both numbers.
              </p>
            )}
            <p className="text-2xs leading-relaxed text-ink-faint">
              Covers {channels.map(channelLabel).join(', ')} over the last {rangeDays} days. Only
              metric days on or after a send&apos;s own publish date count towards it, so no send is
              credited with activity that predates it. Slot choice is one input among many — treat
              the gap as a signal, not a controlled experiment.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function DumbbellRow({ metric }: { metric: Metric }) {
  const { ai, manual, format, label, hint } = metric
  if (ai === null || manual === null) return null

  // Headroom on the right so the further dot never touches the track's end.
  const scale = Math.max(ai, manual) * 1.12 || 1
  const aiPct = (ai / scale) * 100
  const manualPct = (manual / scale) * 100
  const delta = manual > 0 ? ai / manual - 1 : null
  const better = delta !== null && delta > 0

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{label}</p>
          <p className="text-2xs text-ink-faint">{hint}</p>
        </div>
        <div className="flex items-center gap-3">
          <Value color="rgb(var(--ink-faint))" text={format(manual)} />
          <Value color="rgb(var(--series-1))" filled text={format(ai)} />
          {delta !== null && Math.abs(delta) >= 0.005 && (
            <span
              className={cn(
                'tnum w-14 text-right text-xs font-semibold',
                better ? 'text-ok-fg' : 'text-danger-fg',
              )}
            >
              {better ? '↑' : '↓'} {formatPercent(Math.abs(delta), 1)}
            </span>
          )}
          {(delta === null || Math.abs(delta) < 0.005) && (
            <span className="w-14 text-right text-xs font-medium text-ink-faint">level</span>
          )}
        </div>
      </div>

      <div className="relative mt-2 h-4">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        {/* The connector is the measurement: its length is the gap being read. */}
        <div
          className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-line-strong"
          style={{
            left: `${Math.min(aiPct, manualPct)}%`,
            width: `${Math.abs(aiPct - manualPct)}%`,
          }}
        />
        <Dot pct={manualPct} color="rgb(var(--ink-faint))" />
        <Dot pct={aiPct} color="rgb(var(--series-1))" filled />
      </div>
    </div>
  )
}

function Dot({ pct, color, filled }: { pct: number; color: string; filled?: boolean }) {
  return (
    <span
      className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{
        left: `${pct}%`,
        background: filled ? color : 'rgb(var(--surface))',
        // A 2px surface ring keeps the two dots legible where they overlap.
        boxShadow: `0 0 0 2px rgb(var(--surface)), inset 0 0 0 ${filled ? 0 : 2}px ${color}`,
      }}
    />
  )
}

function Value({ color, text, filled }: { color: string; text: string; filled?: boolean }) {
  return (
    <span className="tnum inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: filled ? color : 'transparent', boxShadow: `inset 0 0 0 2px ${color}` }}
      />
      {text}
    </span>
  )
}

function LegendKey({
  color,
  label,
  detail,
  filled,
}: {
  color: string
  label: string
  detail: string
  filled?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: filled ? color : 'transparent', boxShadow: `inset 0 0 0 2px ${color}` }}
      />
      <span className="font-medium text-ink">{label}</span>
      <span className="text-ink-faint">· {detail}</span>
    </span>
  )
}
