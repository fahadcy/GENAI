'use client'

import * as React from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar } from '@/components/ui/primitives'
import { CHANNEL_META } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'
import {
  dayOfMonth,
  formatDay,
  monthLabel,
  pluralDays,
  spanDays,
  taskRisk,
  weekdayLabel,
  weekdayOf,
  type Placement,
  type Schedule,
  type ScheduleInput,
} from './schedule'
import { MilestoneMark, phaseTone } from './bits'
import type { TaskView } from './types'

const LEFT_W = 288
const ROW_H = 34
const PHASE_H = 28

export type Density = 'day' | 'week' | 'month'
const DAY_WIDTH: Record<Density, number> = { day: 28, week: 15, month: 8 }

type Row =
  | { kind: 'phase'; key: string; phase: string; count: number }
  | { kind: 'task'; key: string; task: TaskView }

/**
 * The Gantt (PRD CP-2, primary lens).
 *
 * Two things it does that a bar chart of dates would not: it draws the
 * dependency edges into and out of whichever task you are looking at, and when
 * a projection differs from the committed plan it keeps the committed window on
 * screen as a dashed ghost, so a slip is something you see rather than read.
 */
export function Timeline({
  tasks,
  schedule,
  inputs,
  phases,
  today,
  windowStart,
  windowEnd,
  density,
  focusId,
  onFocus,
  onOpen,
}: {
  tasks: TaskView[]
  schedule: Schedule
  inputs: ScheduleInput[]
  phases: string[]
  today: number
  windowStart: number
  windowEnd: number
  density: Density
  focusId: string | null
  onFocus: (id: string | null) => void
  onOpen: (id: string) => void
}) {
  const start = windowStart - 1
  const totalDays = Math.max(7, windowEnd - start + 2)

  /* The density presets are floors, not fixed widths: a short plan stretches to
     fill the card instead of stranding a third of it as empty background, and a
     long one keeps its preset and scrolls. Measured rather than guessed, so it
     holds on any viewport. */
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [available, setAvailable] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setAvailable(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const dayW =
    available > LEFT_W ? Math.max(DAY_WIDTH[density], (available - LEFT_W) / totalDays) : DAY_WIDTH[density]
  const trackW = totalDays * dayW
  const byId = React.useMemo(() => new Map(inputs.map((t) => [t.id, t])), [inputs])

  const rows: Row[] = React.useMemo(() => {
    const out: Row[] = []
    for (const phase of phases) {
      const inPhase = tasks.filter((t) => t.phase === phase)
      if (inPhase.length === 0) continue
      out.push({ kind: 'phase', key: `p:${phase}`, phase, count: inPhase.length })
      for (const t of inPhase) out.push({ kind: 'task', key: t.id, task: t })
    }
    return out
  }, [tasks, phases])

  const rowTop = React.useMemo(() => {
    const map = new Map<string, number>()
    let y = 0
    for (const r of rows) {
      map.set(r.key, y)
      y += r.kind === 'phase' ? PHASE_H : ROW_H
    }
    return map
  }, [rows])
  const bodyH = rows.reduce((a, r) => a + (r.kind === 'phase' ? PHASE_H : ROW_H), 0)

  const x = (day: number) => (day - start) * dayW
  const centreY = (id: string) => (rowTop.get(id) ?? 0) + ROW_H / 2

  /* Edges: the focused task's immediate graph, plus every driving chain into a
     milestone that is currently slipping — those are the ones worth the ink. */
  const edges = React.useMemo(() => {
    const wanted = new Set<string>()
    const critical = new Set<string>()
    for (const m of schedule.milestones) {
      if (m.slip <= 0) continue
      for (let i = 1; i < m.path.length; i++) critical.add(`${m.path[i - 1]}>${m.path[i]}`)
    }
    if (focusId) {
      for (const dep of byId.get(focusId)?.dependsOn ?? []) wanted.add(`${dep}>${focusId}`)
      for (const t of inputs) if (t.dependsOn.includes(focusId)) wanted.add(`${focusId}>${t.id}`)
    }
    return [...new Set([...wanted, ...critical])]
      .map((key) => {
        const [from, to] = key.split('>')
        const a = schedule.placements.get(from)
        const b = schedule.placements.get(to)
        if (!a || !b || !rowTop.has(from) || !rowTop.has(to)) return null
        return { from, to, a, b, critical: critical.has(key) }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
  }, [focusId, byId, inputs, schedule, rowTop])

  /* Month starts are already marked by the label row above, so the tick row
     carries weeks only — at 15px a day, a 1st-of-the-month tick sitting a day
     from a Monday tick printed the two labels on top of each other. */
  const ticks = React.useMemo(() => {
    const out: number[] = []
    let week = 0
    for (let d = start; d <= start + totalDays; d++) {
      if (density === 'day') out.push(d)
      else if (weekdayOf(d) === 1 && (density === 'week' || week++ % 2 === 0)) out.push(d)
    }
    return out
  }, [start, totalDays, density])

  return (
    <div className="overflow-x-auto" ref={scrollRef}>
      <div className="relative" style={{ width: LEFT_W + trackW }}>
        {/* ------------------------------------------------------- header */}
        <div className="sticky top-0 z-20 flex border-b border-line bg-surface">
          <div className="sticky left-0 z-10 flex w-[288px] shrink-0 items-end border-r border-line bg-surface px-4 pb-1.5 pt-2">
            <span className="label">Task</span>
          </div>
          <div className="relative h-[42px]" style={{ width: trackW }}>
            {monthSpans(start, totalDays).map((m) => (
              <div
                key={m.day}
                className="absolute top-1 truncate border-l border-line pl-1.5 text-2xs font-semibold text-ink-muted"
                style={{ left: x(m.day), width: m.days * dayW }}
              >
                {monthLabel(m.day)}
              </div>
            ))}
            {ticks.map((t) => (
              <div
                key={t}
                className="tnum absolute bottom-1 text-2xs text-ink-faint"
                style={{ left: x(t) + 2 }}
              >
                {density === 'day' ? `${weekdayLabel(t)[0]}${dayOfMonth(t)}` : dayOfMonth(t)}
              </div>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------------- body */}
        <div className="relative" style={{ height: bodyH }}>
          {/* Grid, weekends and the today line, drawn once behind every row. */}
          <div
            className="pointer-events-none absolute inset-y-0 overflow-hidden"
            style={{ left: LEFT_W, width: trackW }}
            aria-hidden
          >
            {Array.from({ length: totalDays }, (_, i) => start + i).map((d) => {
              const weekend = weekdayOf(d) === 0 || weekdayOf(d) === 6
              const weekStart = weekdayOf(d) === 1
              if (!weekend && !weekStart) return null
              return (
                <div
                  key={d}
                  className={cn(
                    'absolute inset-y-0',
                    weekend && 'bg-bg-subtle',
                    weekStart && 'border-l border-line',
                  )}
                  style={{ left: x(d), width: dayW }}
                />
              )
            })}
            <div className="absolute inset-y-0 w-px bg-brand-500" style={{ left: x(today) }} />
          </div>

          {/* Dependency edges sit above the grid but below the bars' hit area. */}
          <svg
            className="pointer-events-none absolute inset-y-0 z-10"
            style={{ left: LEFT_W, width: trackW, height: bodyH }}
            aria-hidden
          >
            <defs>
              <marker id="plan-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((e) => (
              <path
                key={`${e.from}>${e.to}`}
                d={elbow(x(e.a.finish) + dayW, centreY(e.from), x(e.b.start), centreY(e.to))}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={e.critical ? undefined : '3 3'}
                markerEnd="url(#plan-arrow)"
                className={e.critical ? 'text-danger-fg' : 'text-ink-faint'}
                stroke="currentColor"
              />
            ))}
          </svg>

          {rows.map((row) => {
            if (row.kind === 'phase') {
              const tone = phaseTone(phases, row.phase)
              return (
                <div key={row.key} className="flex" style={{ height: PHASE_H }}>
                  <div className="sticky left-0 z-10 flex w-[288px] shrink-0 items-center gap-2 border-r border-line bg-bg-subtle px-4">
                    <span className={cn('h-2 w-2 rounded-full', tone.dot)} />
                    <span className="truncate text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                      {row.phase}
                    </span>
                    <span className="tnum text-2xs text-ink-faint">{row.count}</span>
                  </div>
                  <div className="bg-bg-subtle/60" style={{ width: trackW }} />
                </div>
              )
            }

            const task = row.task
            const placed = schedule.placements.get(task.id)!
            const input = byId.get(task.id)!
            const risk = taskRisk(input, placed, today)
            const tone = phaseTone(phases, task.phase)

            return (
              <div
                key={row.key}
                className="group flex"
                style={{ height: ROW_H }}
                onMouseEnter={() => onFocus(task.id)}
                onMouseLeave={() => onFocus(null)}
              >
                <button
                  type="button"
                  onClick={() => onOpen(task.id)}
                  className={cn(
                    'sticky left-0 z-10 flex w-[288px] shrink-0 items-center gap-2 border-r border-line px-4 text-left transition-colors',
                    focusId === task.id ? 'bg-surface-hover' : 'bg-surface group-hover:bg-surface-hover',
                  )}
                >
                  {task.isMilestone && <MilestoneMark />}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{task.title}</span>
                  {task.channel && (
                    <ChannelGlyph channel={task.channel} />
                  )}
                  {task.ownerName && (
                    <Avatar name={task.ownerName} hue={task.ownerHue ?? 250} size={18} />
                  )}
                </button>

                <div className="relative" style={{ width: trackW }}>
                  {/* Ghost of the committed window, shown only when the
                      projection has moved away from it. */}
                  {(placed.start !== placed.baseStart || placed.finish !== placed.baseFinish) && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 rounded border border-dashed border-ink-faint/70"
                      style={{
                        left: x(placed.baseStart),
                        width: Math.max(dayW, (placed.baseFinish - placed.baseStart + 1) * dayW),
                        height: 14,
                      }}
                      title={`Committed: ${formatDay(placed.baseStart)} – ${formatDay(placed.baseFinish)}`}
                    />
                  )}
                  <Bar
                    task={task}
                    placed={placed}
                    tone={tone}
                    dayW={dayW}
                    left={x(placed.start)}
                    risk={risk}
                    onOpen={() => onOpen(task.id)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Bar({
  task,
  placed,
  tone,
  dayW,
  left,
  risk,
  onOpen,
}: {
  task: TaskView
  placed: Placement
  tone: ReturnType<typeof phaseTone>
  dayW: number
  left: number
  risk: ReturnType<typeof taskRisk>
  onOpen: () => void
}) {
  const width = Math.max(dayW, spanDays(placed.start, placed.finish) * dayW)
  const label = `${task.title} · ${formatDay(placed.start)} – ${formatDay(placed.finish)} · ${pluralDays(
    spanDays(placed.start, placed.finish),
  )}${placed.shift !== 0 ? ` · ${placed.shift > 0 ? '+' : ''}${placed.shift}d vs plan` : ''}`

  if (task.isMilestone) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={label}
        className="absolute top-1/2 -translate-y-1/2"
        style={{ left: left + width - dayW / 2 - 7 }}
      >
        <span
          className={cn(
            'block h-3.5 w-3.5 rotate-45 rounded-[2px] ring-2',
            risk === 'none' ? 'bg-gold-400 ring-gold-600/40' : 'bg-danger-fg ring-danger-fg/30',
          )}
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      className={cn(
        'absolute top-1/2 flex h-[15px] -translate-y-1/2 items-center gap-1 rounded-[4px] px-1 ring-inset transition-all hover:brightness-110',
        task.status === 'done' && cn(tone.soft, 'ring-1', tone.ring),
        task.status === 'in_progress' && tone.bar,
        task.status === 'in_review' && cn(tone.bar, 'ring-2 ring-warn-fg/70'),
        task.status === 'not_started' && cn(tone.soft, 'ring-1', tone.ring),
        task.status === 'blocked' && 'bg-danger-bg ring-1 ring-danger-fg/60',
        // Risk overrides the phase ring: a bar that is in trouble must not be
        // distinguishable only by a hue that also means "Creative".
        risk === 'slipping' && 'ring-2 ring-warn-fg',
        (risk === 'overdue' || risk === 'blocked') && 'ring-2 ring-danger-fg',
      )}
      style={{ left, width }}
    >
      {task.status === 'done' && width > 20 && <Check className="h-2.5 w-2.5 text-ink-muted" />}
      {risk !== 'none' && risk !== 'slipping' && width > 20 && (
        <AlertTriangle className="h-2.5 w-2.5 text-danger-fg" />
      )}
    </button>
  )
}

function ChannelGlyph({ channel }: { channel: string }) {
  const meta = CHANNEL_META[channel as Channel]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span
      className="tint inline-flex h-4 w-4 shrink-0 items-center justify-center rounded"
      style={{ '--h': meta.hue } as React.CSSProperties}
      title={meta.label}
    >
      <Icon className="h-2.5 w-2.5" />
    </span>
  )
}

/* -------------------------------------------------------------- geometry */

/** Orthogonal connector; routes around when the successor starts behind. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const gap = 7
  if (x2 - x1 > gap * 2) {
    const mid = x1 + Math.max(gap, (x2 - x1) / 2)
    return `M${x1},${y1} H${mid} V${y2} H${x2 - 2}`
  }
  const back = x2 - gap
  const lane = y2 > y1 ? y1 + 12 : y1 - 12
  return `M${x1},${y1} H${x1 + gap} V${lane} H${back} V${y2} H${x2 - 2}`
}

function monthSpans(start: number, totalDays: number): { day: number; days: number }[] {
  const out: { day: number; days: number }[] = []
  for (let i = 0; i < totalDays; i++) {
    const d = start + i
    if (i === 0 || dayOfMonth(d) === 1) out.push({ day: d, days: 0 })
    out[out.length - 1].days++
  }
  return out
}

