'use client'

import * as React from 'react'
import { AlertTriangle, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar } from '@/components/ui/primitives'
import { ChannelChip } from '@/components/domain'
import {
  formatDay,
  spanDays,
  taskRisk,
  type Schedule,
  type ScheduleInput,
  type PlanStatus,
} from './schedule'
import { MilestoneMark, TaskLinks, phaseTone } from './bits'
import { STATUS_LABEL, STATUS_ORDER, type TaskView } from './types'

/**
 * The board (PRD CP-2, second lens over the same plan).
 *
 * Dropping a card into a column is a status change, and a status change is a
 * scheduling event — moving a task into Blocked runs the same dependency walk
 * the timeline previews, so the two views can never disagree about what the
 * plan now says.
 */
export function Board({
  tasks,
  schedule,
  inputs,
  phases,
  today,
  canEdit,
  onOpen,
  onMove,
}: {
  tasks: TaskView[]
  schedule: Schedule
  inputs: ScheduleInput[]
  phases: string[]
  today: number
  canEdit: boolean
  onOpen: (id: string) => void
  onMove: (id: string, status: PlanStatus) => void
}) {
  const [dragging, setDragging] = React.useState<string | null>(null)
  const [over, setOver] = React.useState<PlanStatus | null>(null)
  const byId = React.useMemo(() => new Map(inputs.map((t) => [t.id, t])), [inputs])

  return (
    <div className="grid gap-3 overflow-x-auto p-4 md:grid-cols-2 xl:grid-cols-5">
      {STATUS_ORDER.map((status) => {
        const column = tasks.filter((t) => t.status === status)
        const active = over === status && dragging !== null
        return (
          <section
            key={status}
            onDragOver={(e) => {
              if (!dragging || !canEdit) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOver(status)
            }}
            onDragLeave={() => setOver((s) => (s === status ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const id = e.dataTransfer.getData('text/plain') || dragging
              setDragging(null)
              if (id && canEdit) {
                const current = tasks.find((t) => t.id === id)
                if (current && current.status !== status) onMove(id, status)
              }
            }}
            className={cn(
              'flex min-w-[240px] flex-col rounded-xl border bg-bg-subtle transition-colors',
              active ? 'border-brand-500 bg-brand-50/50' : 'border-line',
            )}
          >
            <header className="flex items-center justify-between gap-2 px-3 py-2.5">
              <h3 className="text-[13px] font-semibold text-ink">{STATUS_LABEL[status]}</h3>
              <span className="tnum rounded bg-bg-inset px-1.5 py-0.5 text-2xs font-semibold text-ink-muted">
                {column.length}
              </span>
            </header>

            {/* The tallest column decides the board's height, so it scrolls
                rather than stretching four empty columns to match "Done". */}
            <div className="flex max-h-[540px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {column.length === 0 ? (
                <p className="px-1.5 py-6 text-center text-2xs leading-relaxed text-ink-faint">
                  {EMPTY_COPY[status]}
                </p>
              ) : (
                column.map((task) => {
                  const placed = schedule.placements.get(task.id)!
                  const risk = taskRisk(byId.get(task.id)!, placed, today)
                  const tone = phaseTone(phases, task.phase)
                  return (
                    <article
                      key={task.id}
                      draggable={canEdit}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', task.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(task.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      onClick={() => onOpen(task.id)}
                      className={cn(
                        'card cursor-pointer space-y-2 p-2.5 transition-shadow hover:shadow-pop',
                        dragging === task.id && 'opacity-40',
                        risk === 'blocked' || risk === 'overdue'
                          ? 'border-danger-fg/40'
                          : risk === 'slipping'
                            ? 'border-warn-fg/40'
                            : undefined,
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
                        {task.isMilestone && <MilestoneMark className="mt-0.5" />}
                        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-ink">
                          {task.title}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            'tnum inline-flex items-center gap-1 text-2xs',
                            risk === 'overdue' || risk === 'blocked'
                              ? 'text-danger-fg'
                              : risk === 'slipping'
                                ? 'text-warn-fg'
                                : 'text-ink-faint',
                          )}
                        >
                          {risk === 'none' ? (
                            <CalendarClock className="h-3 w-3" />
                          ) : (
                            <AlertTriangle className="h-3 w-3" />
                          )}
                          {formatDay(placed.finish)}
                          {placed.shift > 0 && ` · +${placed.shift}d`}
                          {placed.shift === 0 && ` · ${spanDays(placed.start, placed.finish)}d`}
                        </span>
                        {task.ownerName && (
                          <Avatar name={task.ownerName} hue={task.ownerHue ?? 250} size={18} />
                        )}
                      </div>

                      {task.channel && <ChannelChip channel={task.channel} size="sm" />}
                      <TaskLinks task={task} size="sm" />
                    </article>
                  )
                })
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

const EMPTY_COPY: Record<PlanStatus, string> = {
  not_started: 'Everything scheduled has been picked up.',
  in_progress: 'Nobody is mid-flight on this campaign right now.',
  blocked: 'Nothing is stuck. Drag a card here when it is, and the plan behind it will resettle.',
  in_review: 'No work is sitting with a reviewer.',
  done: 'Nothing has been closed out yet.',
}
