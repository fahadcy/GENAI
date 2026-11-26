import * as React from 'react'
import {
  AtSign,
  FileText,
  Globe,
  Instagram,
  Linkedin,
  MessageSquare,
  Bell,
  Facebook,
  Search,
  Megaphone,
} from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'
import type { AssetStatus, Channel } from '@/lib/db/schema'

/* --------------------------------------------------------------- channels */

export const CHANNEL_META: Record<
  Channel,
  { label: string; short: string; icon: React.ComponentType<{ className?: string }>; hue: number }
> = {
  email: { label: 'Email', short: 'Email', icon: AtSign, hue: 250 },
  linkedin: { label: 'LinkedIn', short: 'LI', icon: Linkedin, hue: 205 },
  x: { label: 'X', short: 'X', icon: MessageSquare, hue: 220 },
  instagram: { label: 'Instagram', short: 'IG', icon: Instagram, hue: 330 },
  facebook: { label: 'Facebook', short: 'FB', icon: Facebook, hue: 215 },
  blog: { label: 'Blog', short: 'Blog', icon: FileText, hue: 30 },
  google_ads: { label: 'Google Ads', short: 'GAds', icon: Search, hue: 145 },
  meta_ads: { label: 'Meta Ads', short: 'MAds', icon: Megaphone, hue: 265 },
  sms: { label: 'SMS', short: 'SMS', icon: MessageSquare, hue: 165 },
  push: { label: 'Push', short: 'Push', icon: Bell, hue: 15 },
  web: { label: 'Web', short: 'Web', icon: Globe, hue: 190 },
}

export function channelLabel(channel: string): string {
  return CHANNEL_META[channel as Channel]?.label ?? channel
}

export function ChannelChip({
  channel,
  size = 'md',
  showLabel = true,
  className,
}: {
  channel: string
  size?: 'sm' | 'md'
  showLabel?: boolean
  className?: string
}) {
  const meta = CHANNEL_META[channel as Channel]
  if (!meta) return <span className="text-xs text-ink-faint">{channel}</span>
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'tint inline-flex items-center gap-1.5 rounded-md font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-1 text-xs',
        className,
      )}
      style={{ '--h': meta.hue } as React.CSSProperties}
      title={meta.label}
    >
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {showLabel && meta.label}
    </span>
  )
}

/* --------------------------------------------------------------- statuses */

const ASSET_STATUS_META: Record<AssetStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_review: { label: 'In review', tone: 'warn' },
  changes_requested: { label: 'Changes requested', tone: 'danger' },
  approved: { label: 'Approved', tone: 'ok' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  published: { label: 'Published', tone: 'brand' },
  archived: { label: 'Archived', tone: 'neutral' },
}

export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  const meta = ASSET_STATUS_META[status]
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  )
}

const SCHEDULE_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  scheduled: { label: 'Scheduled', tone: 'info' },
  publishing: { label: 'Publishing', tone: 'warn' },
  published: { label: 'Published', tone: 'ok' },
  failed: { label: 'Retrying', tone: 'warn' },
  dead_letter: { label: 'Dead letter', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export function ScheduleStatusBadge({ status }: { status: string }) {
  const meta = SCHEDULE_STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone }
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  )
}

/* ----------------------------------------------------------- pipeline bar */

export const STAGES = ['generate', 'review', 'approve', 'publish', 'monitor'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABEL: Record<Stage, string> = {
  generate: 'Generate',
  review: 'Review',
  approve: 'Approve',
  publish: 'Publish',
  monitor: 'Monitor',
}

/**
 * The five-stage pipeline from PRD figure 1, rendered as a compact progress
 * strip. Used on the Command Center and on every asset row.
 */
export function PipelineStrip({
  stage,
  counts,
  className,
  compact,
}: {
  /** Single-item mode: highlights the stage this asset currently sits in. */
  stage?: Stage
  /** Portfolio mode: how many items sit in each stage. */
  counts?: Record<Stage, number>
  className?: string
  compact?: boolean
}) {
  const activeIndex = stage ? STAGES.indexOf(stage) : -1
  const total = counts ? STAGES.reduce((a, s) => a + counts[s], 0) : 0

  return (
    <div className={cn('flex items-stretch gap-1.5', className)}>
      {STAGES.map((s, i) => {
        const done = activeIndex > i
        const active = activeIndex === i
        const n = counts?.[s] ?? 0
        // In portfolio mode the bar fills in proportion to that stage's share,
        // so a glance shows where work is piling up.
        const share = total > 0 ? n / total : 0

        return (
          <div key={s} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-inset">
              {counts ? (
                n > 0 && (
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${Math.max(14, share * 100)}%` }}
                  />
                )
              ) : (
                <div
                  className={cn(
                    'h-full w-full rounded-full',
                    done ? 'bg-brand-400' : active ? 'bg-brand-600' : 'bg-transparent',
                  )}
                />
              )}
            </div>

            {!compact && (
              /* Count sits directly above its own label, never between two of
                 them — the earlier split-row layout read as an off-by-one. */
              <div className="min-w-0">
                {counts && (
                  <span
                    className={cn(
                      'tnum block text-[13px] font-semibold leading-none',
                      n > 0 ? 'text-ink' : 'text-ink-faint',
                    )}
                  >
                    {n}
                  </span>
                )}
                <span
                  className={cn(
                    'mt-1 block truncate text-2xs',
                    active ? 'font-semibold text-ink' : 'text-ink-faint',
                  )}
                >
                  {STAGE_LABEL[s]}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ misc */

export function RelativeTime({ date, className }: { date: Date | string | null; className?: string }) {
  if (!date) return <span className={cn('text-ink-faint', className)}>—</span>
  const d = typeof date === 'string' ? new Date(date) : date
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString('en-GB')} className={className}>
      {formatRelative(d)}
    </time>
  )
}

export function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  const mins = Math.round(abs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function formatMoney(value: number | string, currency = 'GBP'): string {
  const n = typeof value === 'string' ? Number(value) : value
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n || 0)
}

/**
 * Deliberately not `Intl.NumberFormat({ notation: 'compact' })`.
 *
 * Node's ICU renders 163000 as "163K" while Chromium renders "163k". In a server
 * component that difference is invisible, but the moment a *client* component
 * prints one during SSR React reports a hydration mismatch. Formatting by hand
 * keeps server and browser output byte-identical.
 */
export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  const units: [number, string][] = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const value = n / size
      const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10
      return `${rounded}${suffix}`
    }
  }
  return String(n)
}

export function formatPercent(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.round(ms / 60000)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
