'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, GanttChartSquare, KanbanSquare, ShieldAlert, Waypoints } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import {
  linkTaskAction,
  rescheduleTaskAction,
  setAssetTaskAction,
} from '@/app/(app)/planner/actions'
import {
  computeSchedule,
  toDay,
  type Override,
  type PlanStatus,
  type ScheduleInput,
} from './schedule'
import { ViewSwitcher, orderedPhases } from './bits'
import { Timeline, type Density } from './timeline'
import { Board } from './board'
import { PlanCalendar } from './calendar'
import { TaskModal } from './task-modal'
import { MilestoneStrip, ProjectionSummary, RiskList, computeExposure } from './risks'
import { STATUS_LABEL, type LinkedAsset, type PickerOption, type TaskView } from './types'

type View = 'timeline' | 'board' | 'calendar'

const VIEWS = [
  { value: 'timeline' as const, label: 'Timeline', icon: GanttChartSquare },
  { value: 'board' as const, label: 'Board', icon: KanbanSquare },
  { value: 'calendar' as const, label: 'Calendar', icon: CalendarDays },
]

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

/**
 * The plan, its three lenses and the recalculation loop (PRD CP-2 + CP-4).
 *
 * All three views read from one `computeSchedule` result, so a slip previewed
 * on the timeline is the same slip the board card and the calendar bar show.
 * Writes go through the server action, which re-runs the identical maths
 * against freshly-read rows before it commits anything.
 */
export function PlanWorkspace({
  campaignId,
  tasks,
  segments,
  chains,
  attachable,
  todayIso,
  campaignStartIso,
  campaignEndIso,
  budget,
  spend,
  currency,
  canEdit,
  planningRisks,
}: {
  campaignId: string
  tasks: TaskView[]
  segments: PickerOption[]
  chains: PickerOption[]
  attachable: LinkedAsset[]
  todayIso: string
  campaignStartIso: string | null
  campaignEndIso: string | null
  budget: number
  spend: number
  currency: string
  canEdit: boolean
  planningRisks: string[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [view, setView] = React.useState<View>('timeline')
  const [density, setDensity] = React.useState<Density>('week')
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  // `today` arrives from the server so the projection cannot disagree between
  // the render that was sent and the one that hydrates.
  const today = React.useMemo(() => toDay(todayIso), [todayIso])
  const campaignEnd = campaignEndIso ? toDay(campaignEndIso) : null
  const campaignStart = campaignStartIso ? toDay(campaignStartIso) : null

  const inputs: ScheduleInput[] = React.useMemo(
    () =>
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        startDate: t.startDate,
        dueDate: t.dueDate,
        dependsOn: t.dependsOn,
        status: t.status,
        isMilestone: t.isMilestone,
        sortIndex: t.sortIndex,
      })),
    [tasks],
  )

  const schedule = React.useMemo(
    () => computeSchedule(inputs, { today, campaignEnd }),
    [inputs, today, campaignEnd],
  )

  const phases = React.useMemo(() => orderedPhases(tasks), [tasks])
  const exposures = React.useMemo(
    () =>
      computeExposure(tasks, inputs, schedule, {
        today,
        campaignEnd,
        campaignStart,
        budget,
        spend,
        currency,
      }),
    [tasks, inputs, schedule, today, campaignEnd, campaignStart, budget, spend, currency],
  )

  const windowStart = Math.min(
    campaignStart ?? today,
    ...[...schedule.placements.values()].map((p) => Math.min(p.start, p.baseStart)),
  )
  const windowEnd = Math.max(
    campaignEnd ?? today,
    ...[...schedule.placements.values()].map((p) => Math.max(p.finish, p.baseFinish)),
  )

  const open = tasks.find((t) => t.id === openId) ?? null

  const run = async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    try {
      const res = await fn()
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? label : 'Not saved',
        body: res.message,
      })
      if (res.ok) router.refresh()
      return res.ok
    } catch {
      toast.push({
        tone: 'danger',
        title: 'The change did not go through',
        body: 'Nothing was written. The plan on screen is still the committed one.',
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  const reschedule = async (taskId: string, patch: Override) => {
    const ok = await run('Plan recalculated', () => rescheduleTaskAction(campaignId, taskId, patch))
    if (ok) setOpenId(null)
  }

  const moveStatus = (taskId: string, status: PlanStatus) =>
    run(`Moved to ${STATUS_LABEL[status]}`, () =>
      rescheduleTaskAction(campaignId, taskId, { status }),
    )

  const link = async (
    taskId: string,
    payload: { segmentId?: string | null; approvalChainId?: string | null },
  ) => {
    await run('Link saved', () => linkTaskAction(campaignId, taskId, payload))
  }

  const assetTask = async (assetId: string, taskId: string | null) => {
    await run(taskId ? 'Asset attached' : 'Asset detached', () =>
      setAssetTaskAction(campaignId, assetId, taskId),
    )
  }

  const done = tasks.filter((t) => t.status === 'done').length
  const openCount = tasks.length - done

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <ViewSwitcher value={view} onChange={setView} options={VIEWS} />
            {view === 'timeline' && (
              <div className="hidden items-center gap-0.5 sm:flex">
                {DENSITIES.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => setDensity(d.value)}
                    aria-pressed={density === d.value}
                    className={
                      density === d.value
                        ? 'rounded-md bg-bg-inset px-2 py-1 text-2xs font-semibold text-ink'
                        : 'rounded-md px-2 py-1 text-2xs font-medium text-ink-faint transition-colors hover:text-ink'
                    }
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            {tasks.length} tasks · {done} done · {openCount} open
            {schedule.milestones.length > 0 &&
              ` · ${schedule.milestones.length} milestone${schedule.milestones.length === 1 ? '' : 's'}`}
            {canEdit && view === 'board' && ' · drag a card to change status'}
            {canEdit && view === 'timeline' && ' · hover a bar to trace its dependencies'}
          </p>
        </div>

        {view === 'timeline' && (
          <Timeline
            tasks={tasks}
            schedule={schedule}
            inputs={inputs}
            phases={phases}
            today={today}
            windowStart={windowStart}
            windowEnd={windowEnd}
            density={density}
            focusId={focusId}
            onFocus={setFocusId}
            onOpen={setOpenId}
          />
        )}
        {view === 'board' && (
          <Board
            tasks={tasks}
            schedule={schedule}
            inputs={inputs}
            phases={phases}
            today={today}
            canEdit={canEdit && !busy}
            onOpen={setOpenId}
            onMove={moveStatus}
          />
        )}
        {view === 'calendar' && (
          <PlanCalendar
            tasks={tasks}
            schedule={schedule}
            inputs={inputs}
            phases={phases}
            today={today}
            initialMonth={openingMonth(todayIso, campaignStartIso, campaignEndIso)}
            onOpen={setOpenId}
          />
        )}

        <PhaseLegend phases={phases} />
      </Card>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden">
          <CardHeader
            title={
              exposures.length === 0
                ? 'No open exposure on this plan'
                : `${exposures.length} thing${exposures.length === 1 ? '' : 's'} worth acting on`
            }
            description="Computed from the plan as it stands now — dependencies, load, gates and pace."
            icon={<ShieldAlert className="h-4 w-4" />}
          />
          <RiskList
            exposures={exposures}
            flaggedAtPlanning={planningRisks}
            onFocusTasks={(ids) => {
              if (ids.length === 0) return
              setView('timeline')
              setFocusId(ids[0])
              setOpenId(ids[0])
            }}
          />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Milestones"
            description="Dates the plan is accountable to."
            icon={<Waypoints className="h-4 w-4" />}
          />
          <ProjectionSummary schedule={schedule} campaignEnd={campaignEnd} />
          <div className="border-t border-line">
            <MilestoneStrip schedule={schedule} today={today} onOpen={setOpenId} />
          </div>
        </Card>
      </div>

      {open && (
        <TaskModal
          task={open}
          tasks={tasks}
          inputs={inputs}
          today={today}
          campaignEnd={campaignEnd}
          segments={segments}
          chains={chains}
          attachable={attachable}
          canEdit={canEdit}
          busy={busy}
          onClose={() => setOpenId(null)}
          onReschedule={reschedule}
          onLink={link}
          onAssetTask={assetTask}
          onJumpToTask={setOpenId}
        />
      )}
    </>
  )
}

function PhaseLegend({ phases }: { phases: string[] }) {
  if (phases.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line bg-bg-subtle px-4 py-2.5">
      {phases.map((phase, i) => (
        <span key={phase} className="inline-flex items-center gap-1.5 text-2xs text-ink-muted">
          <span className={`h-2 w-2 rounded-full ${LEGEND_DOTS[i % LEGEND_DOTS.length]}`} />
          {phase}
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-ink-faint">
        <span className="h-2 w-2 rotate-45 bg-gold-400" />
        milestone
        <span className="ml-2 h-2.5 w-4 rounded border border-dashed border-ink-faint" />
        committed date
      </span>
    </div>
  )
}

const LEGEND_DOTS = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
]

/**
 * Open the calendar on this month when the campaign is running, otherwise on
 * the month it starts. Landing on an empty July because that is when the
 * campaign began is a worse first frame than the week the team is actually in.
 */
function openingMonth(todayIso: string, startIso: string | null, endIso: string | null): string {
  if (startIso && todayIso < startIso) return `${startIso.slice(0, 7)}-01`
  if (endIso && todayIso > endIso) return `${endIso.slice(0, 7)}-01`
  return `${todayIso.slice(0, 7)}-01`
}
