'use client'

import * as React from 'react'
import { AlertOctagon, CheckCircle2, RefreshCw, Send, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CHANNEL_META } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'
import type { BlackoutView, DragPayload, ItemView } from './types'
import {
  addDays,
  dayKeyIn,
  dayNumber,
  fmtHourLabel,
  fmtTimeIn,
  fromZoned,
  hourIn,
  monthGrid,
  monthOf,
  weekGrid,
  weekdayLabel,
  weekdayOf,
} from './time'

/**
 * The cross-channel calendar (SC-1).
 *
 * Month view drops at day granularity and keeps each item's time of day — moving
 * a send to Thursday should not silently move it to midnight. Week view drops at
 * hour granularity, which is the resolution send-time optimisation actually works
 * at, so an AI slot can be overridden by an hour without opening a dialog.
 */

export type CalendarView = 'month' | 'week'

type DropTarget = { dayKey: string; hour: number | null }

export function Calendar({
  view,
  monthKey,
  weekAnchor,
  weekStartsOn,
  tz,
  todayKey,
  items,
  blackouts,
  visibleChannels,
  canEdit,
  dragging,
  onDragStateChange,
  onOpenItem,
  onDrop,
  onExpandDay,
}: {
  view: CalendarView
  monthKey: string
  weekAnchor: string
  weekStartsOn: number
  tz: string
  todayKey: string
  items: ItemView[]
  blackouts: BlackoutView[]
  visibleChannels: Set<string>
  canEdit: boolean
  dragging: DragPayload | null
  onDragStateChange: (d: DragPayload | null) => void
  onOpenItem: (item: ItemView) => void
  onDrop: (target: DropTarget) => void
  onExpandDay: (dayKey: string) => void
}) {
  const [hover, setHover] = React.useState<string | null>(null)

  const byDay = React.useMemo(() => {
    const map = new Map<string, ItemView[]>()
    for (const item of items) {
      const key = dayKeyIn(new Date(item.scheduledAt), tz)
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    }
    return map
  }, [items, tz])

  const dayKeys = view === 'month' ? monthGrid(monthKey, weekStartsOn).flat() : weekGrid(weekAnchor, weekStartsOn)
  const headerDays = dayKeys.slice(0, 7)

  const blackoutsFor = React.useCallback(
    (dayKey: string, hour: number | null) => {
      const start = fromZoned(dayKey, hour ?? 0, 0, tz).getTime()
      const end = hour === null ? fromZoned(addDays(dayKey, 1), 0, 0, tz).getTime() : start + 3_600_000
      return blackouts.filter((b) => {
        const bs = new Date(b.startsAt).getTime()
        const be = new Date(b.endsAt).getTime()
        if (bs >= end || be <= start) return false
        // A channel-scoped window is only a constraint on the channels shown.
        if (b.channels.length === 0) return true
        return b.channels.some((c) => visibleChannels.has(c))
      })
    },
    [blackouts, tz, visibleChannels],
  )

  const dropProps = (target: DropTarget) => {
    const key = `${target.dayKey}#${target.hour ?? 'd'}`
    // A slot in the past would be due the instant it landed, which is never what
    // a drag onto last Tuesday means. Refuse the drop rather than explain it after.
    const closed = target.dayKey < todayKey
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragging || !canEdit || closed) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (hover !== key) setHover(key)
      },
      onDragLeave: () => setHover((h) => (h === key ? null : h)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setHover(null)
        if (!dragging || !canEdit || closed) return
        onDrop(target)
      },
    }
  }

  /* ------------------------------------------------------------- month */

  if (view === 'month') {
    return (
      <div className="overflow-x-auto">
        <div className="min-w-[840px]">
          <div className="grid grid-cols-7 border-b border-line">
            {headerDays.map((k) => (
              <div key={k} className="px-2.5 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                {weekdayLabel(weekdayOf(k))}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {dayKeys.map((key, i) => {
              const dayItems = (byDay.get(key) ?? []).filter((it) => visibleChannels.has(it.channel))
              const outside = monthOf(key) !== monthKey
              const dayBlackouts = blackoutsFor(key, null)
              const shown = dayItems.slice(0, 3)
              const overflow = dayItems.length - shown.length

              return (
                <div
                  key={key}
                  data-day={key}
                  {...dropProps({ dayKey: key, hour: null })}
                  className={cn(
                    'relative flex min-h-[132px] flex-col gap-1 border-b border-r border-line p-1.5 transition-colors',
                    i % 7 === 6 && 'border-r-0',
                    outside && 'bg-bg-subtle',
                    // Dim what cannot receive the drop, so the legal area is obvious.
                    dragging && key < todayKey && 'opacity-40',
                    hover === `${key}#d` && 'bg-brand-50 ring-1 ring-inset ring-brand-500',
                  )}
                >
                  {dayBlackouts.length > 0 && <BlackoutWash />}
                  <div className="relative flex items-center justify-between gap-1">
                    <span
                      className={cn(
                        'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-semibold',
                        key === todayKey
                          ? 'bg-brand-solid text-brand-on'
                          : outside
                            ? 'text-ink-faint'
                            : 'text-ink-muted',
                      )}
                    >
                      {dayNumber(key)}
                    </span>
                    {dayBlackouts.length > 0 && (
                      <span
                        className="truncate rounded bg-warn-bg px-1 py-px text-2xs font-semibold text-warn-fg"
                        title={dayBlackouts.map((b) => `${b.name}${b.reason ? ` — ${b.reason}` : ''}`).join('\n')}
                      >
                        {dayBlackouts[0].name}
                      </span>
                    )}
                  </div>

                  <div className="relative flex flex-col gap-1">
                    {shown.map((item) => (
                      <ItemChip
                        key={item.id}
                        item={item}
                        tz={tz}
                        canEdit={canEdit}
                        onOpen={onOpenItem}
                        onDragStateChange={onDragStateChange}
                      />
                    ))}
                    {overflow > 0 && (
                      <button
                        onClick={() => onExpandDay(key)}
                        className="rounded px-1 py-0.5 text-left text-2xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink"
                      >
                        +{overflow} more
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  /* -------------------------------------------------------------- week */

  const weekItems = items.filter(
    (it) => visibleChannels.has(it.channel) && dayKeys.includes(dayKeyIn(new Date(it.scheduledAt), tz)),
  )
  // Never hide an item because it sits outside office hours — widen instead.
  const hours = hourRange(weekItems.map((it) => hourIn(new Date(it.scheduledAt), tz)))

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[880px]">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-line">
          <div />
          {dayKeys.map((k) => (
            <div key={k} className="flex items-baseline gap-1.5 px-2.5 py-2">
              <span className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                {weekdayLabel(weekdayOf(k))}
              </span>
              <span
                className={cn(
                  'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-semibold',
                  k === todayKey ? 'bg-brand-solid text-brand-on' : 'text-ink-muted',
                )}
              >
                {dayNumber(k)}
              </span>
            </div>
          ))}
        </div>

        <div
          className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]"
          style={{ gridAutoRows: 'minmax(52px, auto)' }}
        >
          {hours.map((hour) => (
            <React.Fragment key={hour}>
              <div className="tnum border-b border-r border-line px-2 py-1 text-right text-2xs text-ink-faint">
                {fmtHourLabel(hour)}
              </div>
              {dayKeys.map((key, di) => {
                const cellItems = weekItems.filter((it) => {
                  const d = new Date(it.scheduledAt)
                  return dayKeyIn(d, tz) === key && hourIn(d, tz) === hour
                })
                const cellBlackouts = blackoutsFor(key, hour)
                return (
                  <div
                    key={`${key}#${hour}`}
                    data-day={key}
                    data-hour={hour}
                    {...dropProps({ dayKey: key, hour })}
                    className={cn(
                      'relative flex flex-col gap-1 border-b border-r border-line p-1 transition-colors',
                      di === 6 && 'border-r-0',
                      key === todayKey && 'bg-bg-subtle/60',
                      dragging && key < todayKey && 'opacity-40',
                      hover === `${key}#${hour}` && 'bg-brand-50 ring-1 ring-inset ring-brand-500',
                    )}
                  >
                    {cellBlackouts.length > 0 && <BlackoutWash />}
                    {cellItems.map((item) => (
                      <ItemChip
                        key={item.id}
                        item={item}
                        tz={tz}
                        canEdit={canEdit}
                        onOpen={onOpenItem}
                        onDragStateChange={onDragStateChange}
                      />
                    ))}
                  </div>
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ chip */

function ItemChip({
  item,
  tz,
  canEdit,
  onOpen,
  onDragStateChange,
}: {
  item: ItemView
  tz: string
  canEdit: boolean
  onOpen: (item: ItemView) => void
  onDragStateChange: (d: DragPayload | null) => void
}) {
  const meta = CHANNEL_META[item.channel as Channel]
  const Icon = meta?.icon ?? Send
  // A published item is history: it can be inspected but never dragged.
  const movable = canEdit && item.status !== 'published'

  return (
    <button
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', item.id)
        onDragStateChange({ kind: 'item', id: item.id })
      }}
      onDragEnd={() => onDragStateChange(null)}
      onClick={() => onOpen(item)}
      title={`${item.assetTitle} — ${fmtTimeIn(new Date(item.scheduledAt), tz)} · ${meta?.label ?? item.channel}`}
      className={cn(
        'tint group relative flex w-full flex-col gap-px rounded px-1 py-[3px] text-left text-2xs leading-tight transition-opacity',
        movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        item.status === 'published' && 'opacity-55 hover:opacity-100',
      )}
      style={{ '--h': meta?.hue ?? 250 } as React.CSSProperties}
    >
      {/* Time and provenance on top, title on its own line — a truncated title
          two characters wide is worse than one extra row of height. */}
      <span className="flex w-full items-center gap-1">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="tnum shrink-0 font-semibold">{fmtTimeIn(new Date(item.scheduledAt), tz)}</span>
        <span className="flex-1" />
        <StatusMark status={item.status} source={item.sendTimeSource} />
      </span>
      <span className="w-full truncate font-medium">{item.assetTitle}</span>
    </button>
  )
}

function StatusMark({ status, source }: { status: string; source: string }) {
  if (status === 'dead_letter') return <AlertOctagon className="h-3 w-3 shrink-0 text-danger-fg" />
  if (status === 'failed') return <RefreshCw className="h-3 w-3 shrink-0 text-warn-fg" />
  if (status === 'published') return <CheckCircle2 className="h-3 w-3 shrink-0" />
  if (source === 'ai') return <Sparkles className="h-3 w-3 shrink-0" />
  return null
}

/**
 * Blackout shading. Hatched rather than flat-filled so it reads as "off limits"
 * without competing with the item chips sitting on top of it.
 */
function BlackoutWash() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          'repeating-linear-gradient(135deg, rgb(var(--warn-fg) / 0.13) 0 5px, transparent 5px 11px)',
      }}
    />
  )
}

/** Office hours by default, widened to cover anything actually placed. */
function hourRange(hours: number[]): number[] {
  let lo = 7
  let hi = 20
  for (const h of hours) {
    if (h < lo) lo = h
    if (h > hi) hi = h
  }
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
}
