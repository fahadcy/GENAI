'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/primitives'
import {
  dayOfMonth,
  fromDay,
  monthLabel,
  taskRisk,
  toDay,
  weekdayOf,
  type Schedule,
  type ScheduleInput,
} from './schedule'
import { phaseTone } from './bits'
import type { TaskView } from './types'

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const LANE_H = 19
const MAX_LANES = 4

/**
 * The month calendar (PRD CP-2, third lens).
 *
 * A task is drawn as a continuous bar across the days it actually occupies
 * rather than as a chip repeated on every day — repeating it would make a
 * five-day task look like five pieces of work. Bars are packed into lanes per
 * week row so overlapping work never covers itself.
 */
export function PlanCalendar({
  tasks,
  schedule,
  inputs,
  phases,
  today,
  initialMonth,
  onOpen,
}: {
  tasks: TaskView[]
  schedule: Schedule
  inputs: ScheduleInput[]
  phases: string[]
  today: number
  /** First day of the month to open on, as `YYYY-MM-DD`. */
  initialMonth: string
  onOpen: (id: string) => void
}) {
  const [monthStart, setMonthStart] = React.useState(() => toDay(initialMonth))
  const byId = React.useMemo(() => new Map(inputs.map((t) => [t.id, t])), [inputs])

  // Weeks run Monday-first, matching the workspace default and the scheduler.
  const gridStart = monthStart - ((weekdayOf(monthStart) + 6) % 7)
  const monthEnd = toDay(addMonths(fromDay(monthStart), 1)) - 1
  const weekCount = Math.ceil((monthEnd - gridStart + 1) / 7)

  const weeks = React.useMemo(() => {
    const out: { start: number; lanes: LaneItem[][]; overflow: Map<number, number> }[] = []
    for (let w = 0; w < weekCount; w++) {
      const weekStart = gridStart + w * 7
      const weekEnd = weekStart + 6
      const segments: LaneItem[] = []
      for (const task of tasks) {
        const placed = schedule.placements.get(task.id)
        if (!placed) continue
        if (placed.finish < weekStart || placed.start > weekEnd) continue
        segments.push({
          task,
          from: Math.max(placed.start, weekStart) - weekStart,
          to: Math.min(placed.finish, weekEnd) - weekStart,
          continuesLeft: placed.start < weekStart,
          continuesRight: placed.finish > weekEnd,
          risk: taskRisk(byId.get(task.id)!, placed, today),
        })
      }
      segments.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from))

      const lanes: LaneItem[][] = []
      const overflow = new Map<number, number>()
      for (const seg of segments) {
        const lane = lanes.findIndex((l) => l.every((s) => s.to < seg.from || s.from > seg.to))
        const index = lane === -1 ? lanes.length : lane
        if (index >= MAX_LANES) {
          for (let d = seg.from; d <= seg.to; d++) overflow.set(d, (overflow.get(d) ?? 0) + 1)
          continue
        }
        if (lane === -1) lanes.push([seg])
        else lanes[lane].push(seg)
      }
      out.push({ start: weekStart, lanes, overflow })
    }
    return out
  }, [tasks, schedule, byId, gridStart, weekCount, today])

  const inMonth = (day: number) => day >= monthStart && day <= monthEnd
  const active = tasks.filter((t) => {
    const p = schedule.placements.get(t.id)
    return p && p.finish >= monthStart && p.start <= monthEnd
  }).length

  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setMonthStart(toDay(addMonths(fromDay(monthStart), -1)))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[110px] text-center text-[13px] font-semibold text-ink">
            {monthLabel(monthStart)}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setMonthStart(toDay(addMonths(fromDay(monthStart), 1)))}
            aria-label="Next month"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMonthStart(toDay(initialMonth))}>
            Reset
          </Button>
        </div>
        <p className="text-xs text-ink-faint">
          {active} task{active === 1 ? '' : 's'} touch this month
        </p>
      </div>

      <div className="grid grid-cols-7 border-b border-line bg-bg-subtle">
        {WEEKDAY_HEADS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
            {d}
          </div>
        ))}
      </div>

      <div>
        {weeks.map((week) => (
          <div key={week.start} className="relative border-b border-line last:border-b-0">
            <div className="grid grid-cols-7">
              {Array.from({ length: 7 }, (_, i) => week.start + i).map((day) => {
                const overflowCount = week.overflow.get(day - week.start) ?? 0
                return (
                  <div
                    key={day}
                    className={cn(
                      'min-h-[118px] border-r border-line px-1.5 pt-1 last:border-r-0',
                      !inMonth(day) && 'bg-bg-subtle/70',
                    )}
                  >
                    <span
                      className={cn(
                        'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-2xs font-semibold',
                        day === today
                          ? 'bg-brand-solid text-brand-on'
                          : inMonth(day)
                            ? 'text-ink-muted'
                            : 'text-ink-faint',
                      )}
                    >
                      {dayOfMonth(day)}
                    </span>
                    {overflowCount > 0 && (
                      <span className="ml-1 text-2xs text-ink-faint">+{overflowCount}</span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Bars are absolutely placed over the day cells so a task that runs
                Tue–Fri is drawn once, as one object. They stack directly under
                the date numbers rather than floating at the foot of the row. */}
            <div className="pointer-events-none absolute inset-x-0 top-[30px] px-1">
              {week.lanes.map((lane, li) => (
                <div key={li} className="relative" style={{ height: LANE_H }}>
                  {lane.map((seg) => {
                    const tone = phaseTone(phases, seg.task.phase)
                    return (
                      <button
                        key={seg.task.id}
                        type="button"
                        onClick={() => onOpen(seg.task.id)}
                        title={seg.task.title}
                        className={cn(
                          'pointer-events-auto absolute top-0 flex h-[16px] items-center gap-1 overflow-hidden px-1.5 text-2xs font-medium text-ink transition-all hover:brightness-105',
                          seg.continuesLeft ? 'rounded-l-none' : 'rounded-l',
                          seg.continuesRight ? 'rounded-r-none' : 'rounded-r',
                          seg.risk === 'blocked' || seg.risk === 'overdue'
                            ? 'bg-danger-bg ring-1 ring-inset ring-danger-fg/50'
                            : seg.risk === 'slipping'
                              ? 'bg-warn-bg ring-1 ring-inset ring-warn-fg/50'
                              : cn(tone.soft, 'ring-1 ring-inset', tone.ring),
                        )}
                        style={{
                          left: `${(seg.from / 7) * 100}%`,
                          width: `${((seg.to - seg.from + 1) / 7) * 100}%`,
                        }}
                      >
                        {seg.task.isMilestone && (
                          <span className="h-1.5 w-1.5 shrink-0 rotate-45 bg-gold-600" />
                        )}
                        <span className="truncate">
                          {seg.continuesLeft ? `↳ ${seg.task.title}` : seg.task.title}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type LaneItem = {
  task: TaskView
  from: number
  to: number
  continuesLeft: boolean
  continuesRight: boolean
  risk: ReturnType<typeof taskRisk>
}

/** Month arithmetic on the ISO string, so no `Date` timezone can intrude. */
function addMonths(iso: string, delta: number): string {
  const [y, m] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
}
