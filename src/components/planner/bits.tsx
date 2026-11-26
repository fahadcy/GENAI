import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle, Flag, Layers, ShieldCheck, Target } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, type BadgeTone } from '@/components/ui/primitives'
import { formatCompact } from '@/components/domain'
import { STATUS_LABEL, type TaskView } from './types'
import type { PlanStatus, TaskRisk } from './schedule'

/* ---------------------------------------------------------------- phases */

/**
 * Phase colour comes from the categorical chart slots, in slot order — that
 * order is the colour-vision safety mechanism, so phases are never assigned a
 * hue by hand. Bar labels always sit outside the bar in `text-ink`, which is
 * what lets slots 3-5 be used at all on the light surface.
 */
const PHASE_TONES = [
  { bar: 'bg-series-1', soft: 'bg-series-1/20', ring: 'ring-series-1/60', dot: 'bg-series-1' },
  { bar: 'bg-series-2', soft: 'bg-series-2/20', ring: 'ring-series-2/60', dot: 'bg-series-2' },
  { bar: 'bg-series-3', soft: 'bg-series-3/20', ring: 'ring-series-3/60', dot: 'bg-series-3' },
  { bar: 'bg-series-4', soft: 'bg-series-4/20', ring: 'ring-series-4/60', dot: 'bg-series-4' },
  { bar: 'bg-series-5', soft: 'bg-series-5/20', ring: 'ring-series-5/60', dot: 'bg-series-5' },
  { bar: 'bg-series-6', soft: 'bg-series-6/20', ring: 'ring-series-6/60', dot: 'bg-series-6' },
] as const

export type PhaseTone = (typeof PHASE_TONES)[number]

export function phaseTone(phases: string[], phase: string): PhaseTone {
  const i = phases.indexOf(phase)
  return PHASE_TONES[(i < 0 ? 0 : i) % PHASE_TONES.length]
}

export function orderedPhases(tasks: { phase: string; sortIndex: number }[]): string[] {
  const seen: string[] = []
  for (const t of [...tasks].sort((a, b) => a.sortIndex - b.sortIndex)) {
    if (!seen.includes(t.phase)) seen.push(t.phase)
  }
  return seen
}

export function PhaseDot({ tone, className }: { tone: PhaseTone; className?: string }) {
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', tone.dot, className)} />
}

/* --------------------------------------------------------------- statuses */

const STATUS_TONE: Record<PlanStatus, BadgeTone> = {
  not_started: 'neutral',
  in_progress: 'info',
  blocked: 'danger',
  in_review: 'warn',
  done: 'ok',
}

export function StatusBadge({ status }: { status: PlanStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot={status !== 'not_started'}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

const RISK_COPY: Record<Exclude<TaskRisk, 'none'>, { label: string; tone: BadgeTone }> = {
  blocked: { label: 'Blocked', tone: 'danger' },
  overdue: { label: 'Overdue', tone: 'danger' },
  slipping: { label: 'Slipping', tone: 'warn' },
}

export function RiskBadge({ risk, days }: { risk: TaskRisk; days?: number }) {
  if (risk === 'none') return null
  const meta = RISK_COPY[risk]
  return (
    <Badge tone={meta.tone}>
      <AlertTriangle className="h-3 w-3" />
      {risk === 'slipping' && days ? `+${days}d` : meta.label}
    </Badge>
  )
}

export function MilestoneMark({ className }: { className?: string }) {
  return <Flag className={cn('h-3.5 w-3.5 shrink-0 text-gold-600', className)} aria-label="Milestone" />
}

/* ------------------------------------------------------------ CP-3 links */

/**
 * The three links a plan item carries. Rendered as navigable chips rather than
 * counts — the point of CP-3 is that a task tells you where its work lives.
 */
export function TaskLinks({
  task,
  size = 'md',
  className,
}: {
  task: TaskView
  size?: 'sm' | 'md'
  className?: string
}) {
  const chip = cn(
    'inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-bg-subtle font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink',
    size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-1 text-xs',
  )
  const icon = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
  const any = task.assets.length > 0 || task.segmentId || task.approvalChainId
  if (!any) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {task.assets.length > 0 && (
        <Link href={`/studio/${task.assets[0].id}`} className={chip} title={task.assets[0].title}>
          <Layers className={cn(icon, 'shrink-0')} />
          <span className="truncate">
            {task.assets.length === 1 ? task.assets[0].title : `${task.assets.length} assets`}
          </span>
        </Link>
      )}
      {task.segmentId && (
        <Link
          href={`/targeting/${task.segmentId}`}
          className={chip}
          title={
            task.segmentReach
              ? `${task.segmentName} — ${formatCompact(task.segmentReach)} reachable`
              : (task.segmentName ?? 'Target segment')
          }
        >
          <Target className={cn(icon, 'shrink-0')} />
          <span className="max-w-[130px] truncate">{task.segmentName ?? 'Segment'}</span>
        </Link>
      )}
      {task.approvalChainId && (
        <Link
          href="/approvals"
          className={cn(chip, task.approvalsPending > 0 && 'border-warn-fg/40 text-warn-fg')}
          title={task.approvalChainName ?? 'Approval gate'}
        >
          <ShieldCheck className={cn(icon, 'shrink-0')} />
          <span className="truncate">
            {task.approvalsPending > 0 ? `${task.approvalsPending} waiting` : 'Gated'}
          </span>
        </Link>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ misc */

export function ViewSwitcher<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; icon: React.ComponentType<{ className?: string }> }[]
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-bg-subtle p-0.5">
      {options.map((o) => {
        const Icon = o.icon
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[13px] font-medium transition-colors',
              active
                ? 'bg-surface text-ink shadow-card'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Meter({
  value,
  max,
  tone = 'brand',
  className,
}: {
  value: number
  max: number
  tone?: 'brand' | 'ok' | 'warn' | 'danger' | 'gold'
  className?: string
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  const fills = {
    brand: 'bg-brand-600',
    ok: 'bg-ok-fg',
    warn: 'bg-warn-fg',
    danger: 'bg-danger-fg',
    gold: 'bg-gold-400',
  }
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-bg-inset', className)}>
      <div className={cn('h-full rounded-full transition-all', fills[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}
