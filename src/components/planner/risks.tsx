'use client'

import * as React from 'react'
import { AlertTriangle, CircleAlert, Info, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, EmptyState } from '@/components/ui/primitives'
import { formatMoney } from '@/components/domain'
import {
  formatDay,
  pluralDays,
  spanDays,
  type Schedule,
  type ScheduleInput,
} from './schedule'
import type { TaskView } from './types'

export type Exposure = {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  taskIds: string[]
}

/**
 * Live exposure, derived from the plan rather than replayed from the text the
 * agent wrote at generation time. The agent's own caveats are shown alongside
 * (see `planningNote`), but they are a record of what was known then; these are
 * conditions that are true now.
 */
export function computeExposure(
  tasks: TaskView[],
  inputs: ScheduleInput[],
  schedule: Schedule,
  opts: {
    today: number
    campaignEnd: number | null
    budget: number
    spend: number
    currency: string
    campaignStart: number | null
  },
): Exposure[] {
  const out: Exposure[] = []
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const title = (id: string) => byId.get(id)?.title ?? 'a removed task'

  for (const m of schedule.milestones) {
    if (m.slip > 0) {
      const chain = m.path.slice(0, -1).map(title)
      out.push({
        id: `slip:${m.id}`,
        severity: m.slip >= 3 ? 'high' : 'medium',
        title: `"${m.title}" slips ${pluralDays(m.slip)} to ${formatDay(m.finish)}`,
        detail:
          chain.length > 0
            ? `Driven along ${chain.join(' → ')}. Pull time out of one of those to recover the date.`
            : 'This milestone was moved directly. Nothing upstream is holding it.',
        taskIds: m.path,
      })
    } else if (m.pastCampaignEnd) {
      out.push({
        id: `overrun:${m.id}`,
        severity: 'medium',
        title: `"${m.title}" lands after the campaign window closes`,
        detail: `The milestone is planned for ${formatDay(m.finish)}, past the campaign end date. Either extend the window or move the milestone forward.`,
        taskIds: [m.id],
      })
    }
  }

  /* The plan can overrun the campaign window without any single milestone
     doing so — the tail of optimisation work is usually what spills. */
  if (opts.campaignEnd !== null) {
    const overrunning = tasks.filter((t) => {
      const p = schedule.placements.get(t.id)
      return p && p.finish > opts.campaignEnd! && t.status !== 'done'
    })
    if (overrunning.length > 0) {
      const latest = Math.max(...overrunning.map((t) => schedule.placements.get(t.id)!.finish))
      out.push({
        id: 'plan-overrun',
        severity: 'medium',
        title: `The plan runs ${pluralDays(latest - opts.campaignEnd)} past the campaign window`,
        detail: `${overrunning.length} task${
          overrunning.length === 1 ? '' : 's'
        } finish after ${formatDay(opts.campaignEnd)}, the last on ${formatDay(
          latest,
        )}. Extend the campaign end date or compress the tail — measurement running past the window is how results readouts get skipped.`,
        taskIds: overrunning.map((t) => t.id),
      })
    }
  }

  const blocked = tasks.filter((t) => t.status === 'blocked')
  if (blocked.length > 0) {
    const downstream = new Set<string>()
    for (const b of blocked) {
      for (const t of inputs) if (t.dependsOn.includes(b.id)) downstream.add(t.id)
    }
    out.push({
      id: 'blocked',
      severity: 'high',
      title: `${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked`,
      detail: `${blocked.map((b) => `"${b.title}"`).join(', ')}. ${
        downstream.size === 0
          ? 'Nothing depends on them directly, so the damage is contained for now.'
          : `${downstream.size} task${downstream.size === 1 ? '' : 's'} sit${
              downstream.size === 1 ? 's' : ''
            } immediately behind them.`
      }`,
      taskIds: blocked.map((b) => b.id),
    })
  }

  const overdue = tasks.filter((t) => {
    const p = schedule.placements.get(t.id)
    return t.status !== 'done' && t.status !== 'blocked' && p && p.finish < opts.today
  })
  if (overdue.length > 0) {
    out.push({
      id: 'overdue',
      severity: 'high',
      title: `${overdue.length} task${overdue.length === 1 ? '' : 's'} past due and still open`,
      detail: `${overdue
        .slice(0, 3)
        .map((t) => `"${t.title}" (due ${formatDay(schedule.placements.get(t.id)!.finish)})`)
        .join(', ')}${overdue.length > 3 ? `, and ${overdue.length - 3} more` : ''}. Close them or move the dates so the projection means something.`,
      taskIds: overdue.map((t) => t.id),
    })
  }

  /* Concurrency per owner: a plan that reads fine as a list can be impossible
     for the person actually holding it. Counted over projected windows. */
  const byOwner = new Map<string, TaskView[]>()
  for (const t of tasks) {
    if (!t.ownerId || t.status === 'done') continue
    byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) ?? []), t])
  }
  for (const [, owned] of byOwner) {
    let worst = 0
    let worstDay = opts.today
    const windows = owned.map((t) => schedule.placements.get(t.id)!).filter(Boolean)
    for (const w of windows) {
      for (const day of [w.start, w.finish]) {
        if (day < opts.today) continue
        const n = windows.filter((o) => o.start <= day && o.finish >= day).length
        if (n > worst) {
          worst = n
          worstDay = day
        }
      }
    }
    if (worst >= 3) {
      out.push({
        id: `load:${owned[0].ownerId}`,
        severity: worst >= 4 ? 'medium' : 'low',
        title: `${owned[0].ownerName ?? 'One owner'} holds ${worst} open tasks at once`,
        detail: `On ${formatDay(worstDay)} they are down for ${worst} concurrent pieces of this plan. Reassign one or stagger the dates before it becomes the reason something slips.`,
        taskIds: owned.map((t) => t.id),
      })
    }
  }

  /* Fan-out: one task that a lot of the plan waits on. */
  for (const t of tasks) {
    if (t.status === 'done') continue
    const dependents = inputs.filter((i) => i.dependsOn.includes(t.id))
    if (dependents.length >= 3) {
      out.push({
        id: `fanout:${t.id}`,
        severity: 'low',
        title: `${dependents.length} tasks wait on "${t.title}"`,
        detail: `Every day this runs late costs the same day across ${dependents.length} downstream tasks. It is the cheapest place in the plan to add slack.`,
        taskIds: [t.id, ...dependents.map((d) => d.id)],
      })
    }
  }

  const ungated = tasks.filter((t) => t.assets.length > 0 && !t.approvalChainId)
  if (ungated.length > 0) {
    out.push({
      id: 'ungated',
      severity: 'medium',
      title: `${ungated.length} task${ungated.length === 1 ? '' : 's'} produce assets with no approval gate`,
      detail: `${ungated
        .map((t) => `"${t.title}"`)
        .join(', ')} carry generated work but no chain. Attach one so nothing reaches a channel unreviewed.`,
      taskIds: ungated.map((t) => t.id),
    })
  }

  if (tasks.length > 0 && tasks.every((t) => !t.segmentId)) {
    out.push({
      id: 'no-segment',
      severity: 'medium',
      title: 'No task in this plan names an audience',
      detail:
        'Reachability is unknown until a segment is attached, so the goal target has nothing to be measured against. Link one to the audience task.',
      taskIds: [],
    })
  }

  if (schedule.cyclic.length > 0) {
    out.push({
      id: 'cycle',
      severity: 'high',
      title: `${schedule.cyclic.length} tasks form a dependency loop`,
      detail: `${schedule.cyclic
        .map(title)
        .join(', ')} depend on each other in a circle, so no order satisfies them. They are held at their committed dates and excluded from the projection until the loop is broken.`,
      taskIds: schedule.cyclic,
    })
  }

  /* Budget pace, but only once the campaign has actually started. */
  if (opts.budget > 0 && opts.campaignStart !== null && opts.campaignEnd !== null) {
    const total = Math.max(1, opts.campaignEnd - opts.campaignStart)
    const elapsed = Math.min(total, Math.max(0, opts.today - opts.campaignStart))
    if (elapsed > 2) {
      const expected = (elapsed / total) * opts.budget
      const ratio = opts.spend / Math.max(1, expected)
      if (ratio > 1.25) {
        out.push({
          id: 'burn',
          severity: 'medium',
          title: `Spend is running ${Math.round((ratio - 1) * 100)}% ahead of pace`,
          detail: `${formatMoney(opts.spend, opts.currency)} of ${formatMoney(
            opts.budget,
            opts.currency,
          )} is gone with ${Math.round((elapsed / total) * 100)}% of the window elapsed. At this rate the budget runs out before the plan does.`,
          taskIds: [],
        })
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/* ------------------------------------------------------------------- view */

const SEVERITY: Record<
  Exposure['severity'],
  { icon: React.ComponentType<{ className?: string }>; className: string; label: string }
> = {
  high: { icon: ShieldAlert, className: 'text-danger-fg', label: 'High' },
  medium: { icon: AlertTriangle, className: 'text-warn-fg', label: 'Medium' },
  low: { icon: Info, className: 'text-info-fg', label: 'Low' },
}

export function RiskList({
  exposures,
  flaggedAtPlanning,
  onFocusTasks,
}: {
  exposures: Exposure[]
  flaggedAtPlanning: string[]
  onFocusTasks: (ids: string[]) => void
}) {
  if (exposures.length === 0 && flaggedAtPlanning.length === 0) {
    return (
      <EmptyState
        icon={<CircleAlert className="h-5 w-5" />}
        title="Nothing is threatening this plan"
        description="No milestone is slipping, nothing is blocked or overdue, every owner is inside a workable load and each piece of publishable work has a gate."
      />
    )
  }

  return (
    <div className="divide-y divide-line">
      {exposures.map((e) => {
        const meta = SEVERITY[e.severity]
        const Icon = meta.icon
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => onFocusTasks(e.taskIds)}
            disabled={e.taskIds.length === 0}
            className={cn(
              'flex w-full items-start gap-3 px-5 py-3 text-left transition-colors',
              e.taskIds.length > 0 && 'hover:bg-surface-hover',
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.className)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug text-ink">{e.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{e.detail}</p>
            </div>
          </button>
        )
      })}

      {flaggedAtPlanning.length > 0 && (
        <div className="bg-bg-subtle px-5 py-3.5">
          <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
            <Sparkles className="h-3 w-3" />
            Flagged when the plan was generated
          </p>
          <ul className="mt-2 space-y-1.5">
            {flaggedAtPlanning.map((r, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Compact projection summary that sits beside the risk list. */
export function ProjectionSummary({
  schedule,
  campaignEnd,
}: {
  schedule: Schedule
  campaignEnd: number | null
}) {
  const finish = Math.max(...[...schedule.placements.values()].map((p) => p.finish))
  const overrun = campaignEnd !== null ? finish - campaignEnd : 0
  const slipping = schedule.milestones.filter((m) => m.slip > 0)

  return (
    <dl className="grid grid-cols-3 gap-4 px-5 py-4">
      <div>
        <dt className="label">Plan ends</dt>
        <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{formatDay(finish)}</dd>
      </div>
      <div>
        <dt className="label">Vs. window</dt>
        <dd
          className={cn(
            'tnum mt-1 text-[15px] font-semibold',
            overrun > 0 ? 'text-danger-fg' : 'text-ok-fg',
          )}
        >
          {campaignEnd === null
            ? '—'
            : overrun > 0
              ? `${pluralDays(overrun)} over`
              : overrun === 0
                ? 'Lands on it'
                : `${pluralDays(-overrun)} spare`}
        </dd>
      </div>
      <div>
        <dt className="label">Milestones</dt>
        <dd className="mt-1">
          {slipping.length === 0 ? (
            <Badge tone="ok">All on date</Badge>
          ) : (
            <Badge tone="danger" dot>
              {slipping.length} slipping
            </Badge>
          )}
        </dd>
      </div>
    </dl>
  )
}

export function MilestoneStrip({
  schedule,
  today,
  onOpen,
}: {
  schedule: Schedule
  today: number
  onOpen: (id: string) => void
}) {
  if (schedule.milestones.length === 0) return null
  return (
    <ul className="divide-y divide-line">
      {schedule.milestones.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            onClick={() => onOpen(m.id)}
            className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surface-hover"
          >
            <span
              className={cn(
                'h-2.5 w-2.5 shrink-0 rotate-45 rounded-[1px]',
                m.slip > 0 ? 'bg-danger-fg' : 'bg-gold-400',
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{m.title}</span>
            <span className="tnum shrink-0 text-xs text-ink-muted">{formatDay(m.finish)}</span>
            {m.slip > 0 ? (
              <Badge tone="danger">+{m.slip}d</Badge>
            ) : m.finish < today ? (
              <Badge tone="ok">Passed</Badge>
            ) : (
              <span className="tnum shrink-0 text-2xs text-ink-faint">
                in {spanDays(today, m.finish) - 1}d
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
