'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  ExternalLink,
  Layers,
  Link2,
  ShieldCheck,
  Target,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Avatar,
  Badge,
  Button,
  Field,
  Input,
  Select,
} from '@/components/ui/primitives'
import { Modal } from '@/components/ui/client'
import { AssetStatusBadge, ChannelChip, formatCompact } from '@/components/domain'
import type { AssetStatus } from '@/lib/db/schema'
import {
  computeSchedule,
  formatDay,
  pluralDays,
  spanDays,
  summariseImpact,
  toDay,
  type Override,
  type PlanStatus,
  type Schedule,
  type ScheduleInput,
} from './schedule'
import { MilestoneMark, StatusBadge } from './bits'
import { ROLE_TITLE, STATUS_LABEL, STATUS_ORDER, type LinkedAsset, type PickerOption, type TaskView } from './types'

/**
 * One task, and everything hanging off it: the CP-3 links, and the CP-4 edit
 * that shows its own consequences before it is saved. The impact line is
 * produced by the same scheduler the server runs on commit, so what the button
 * promises is what the write does.
 */
export function TaskModal({
  task,
  tasks,
  inputs,
  today,
  campaignEnd,
  segments,
  chains,
  attachable,
  canEdit,
  busy,
  onClose,
  onReschedule,
  onLink,
  onAssetTask,
  onJumpToTask,
}: {
  task: TaskView
  tasks: TaskView[]
  inputs: ScheduleInput[]
  today: number
  campaignEnd: number | null
  segments: PickerOption[]
  chains: PickerOption[]
  attachable: LinkedAsset[]
  canEdit: boolean
  busy: boolean
  onClose: () => void
  onReschedule: (taskId: string, patch: Override) => Promise<void>
  onLink: (taskId: string, link: { segmentId?: string | null; approvalChainId?: string | null }) => Promise<void>
  onAssetTask: (assetId: string, taskId: string | null) => Promise<void>
  onJumpToTask: (id: string) => void
}) {
  const [start, setStart] = React.useState(task.startDate ?? '')
  const [due, setDue] = React.useState(task.dueDate ?? '')
  const [status, setStatus] = React.useState<PlanStatus>(task.status)
  const [attachId, setAttachId] = React.useState('')

  React.useEffect(() => {
    setStart(task.startDate ?? '')
    setDue(task.dueDate ?? '')
    setStatus(task.status)
    setAttachId('')
  }, [task])

  const dirty =
    start !== (task.startDate ?? '') || due !== (task.dueDate ?? '') || status !== task.status
  const invalid = Boolean(start && due && toDay(due) < toDay(start))

  const preview: Schedule | null = React.useMemo(() => {
    if (!dirty || invalid) return null
    const patch: Override = { status }
    if (start && start !== task.startDate) patch.startDate = start
    if (due && due !== task.dueDate) patch.dueDate = due
    return computeSchedule(inputs, {
      today,
      campaignEnd,
      overrides: new Map([[task.id, patch]]),
    })
  }, [dirty, invalid, start, due, status, inputs, today, campaignEnd, task])

  const byId = React.useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const predecessors = task.dependsOn.map((id) => byId.get(id)).filter((t): t is TaskView => !!t)
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.id))
  const movedOthers = preview ? preview.moved.filter((p) => p.id !== task.id) : []
  const slipping = preview ? preview.milestones.filter((m) => m.slip > 0) : []

  const apply = async () => {
    const patch: Override = {}
    if (start && start !== task.startDate) patch.startDate = start
    if (due && due !== task.dueDate) patch.dueDate = due
    if (status !== task.status) patch.status = status
    await onReschedule(task.id, patch)
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          {task.isMilestone && <MilestoneMark />}
          {task.title}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{task.phase}</span>
          <span className="text-ink-faint">·</span>
          <StatusBadge status={task.status} />
          {task.channel && <ChannelChip channel={task.channel} size="sm" />}
          {task.ownerName && (
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <Avatar name={task.ownerName} hue={task.ownerHue ?? 250} size={16} />
              {task.ownerName}
              {task.ownerRole && (
                <span className="text-ink-faint">· {ROLE_TITLE[task.ownerRole] ?? task.ownerRole}</span>
              )}
            </span>
          )}
        </span>
      }
      footer={
        <>
          {!canEdit && (
            <p className="mr-auto text-xs text-ink-faint">
              Your role can read this plan but not change it.
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={apply}
            loading={busy}
            disabled={!canEdit || !dirty || invalid}
          >
            {slipping.length > 0 ? 'Apply and accept the slip' : 'Apply and reschedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {task.description && (
          <p className="text-[13px] leading-relaxed text-ink-muted">{task.description}</p>
        )}

        {/* ------------------------------------------------- dates + status */}
        <section>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Starts">
              <Input
                type="date"
                value={start}
                disabled={!canEdit}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Due" error={invalid ? 'Due cannot fall before the start.' : null}>
              <Input
                type="date"
                value={due}
                disabled={!canEdit}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>
            <Field label="Status">
              <Select
                value={status}
                disabled={!canEdit}
                onChange={(e) => setStatus(e.target.value as PlanStatus)}
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {preview && (
            <div
              className={cn(
                'mt-3 animate-fade-in rounded-lg border px-3.5 py-3',
                slipping.length > 0 ? 'border-danger-fg/30 bg-danger-bg' : 'border-line bg-bg-subtle',
              )}
            >
              <p className="flex items-start gap-2 text-[13px] font-medium leading-snug text-ink">
                <TriangleAlert
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    slipping.length > 0 ? 'text-danger-fg' : 'text-ink-faint',
                  )}
                />
                {summariseImpact(preview)}
              </p>
              {movedOthers.length > 0 && (
                <ul className="mt-2 space-y-1 pl-[22px]">
                  {movedOthers.slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-xs text-ink-muted">
                      <span className="min-w-0 flex-1 truncate">{byId.get(p.id)?.title}</span>
                      <span className="tnum shrink-0 text-ink-faint">
                        {formatDay(p.baseFinish)} <ArrowRight className="inline h-3 w-3" />{' '}
                        <span className={p.shift > 0 ? 'font-semibold text-danger-fg' : undefined}>
                          {formatDay(p.finish)}
                        </span>
                      </span>
                    </li>
                  ))}
                  {movedOthers.length > 6 && (
                    <li className="text-xs text-ink-faint">and {movedOthers.length - 6} more</li>
                  )}
                </ul>
              )}
              {status === 'blocked' && task.status !== 'blocked' && (
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  A blocked task cannot be underway, so it is pushed to today at the earliest and
                  still needs its full{' '}
                  {pluralDays(spanDays(preview.placements.get(task.id)!.start, preview.placements.get(task.id)!.finish))}{' '}
                  once it clears.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ------------------------------------------------- dependencies */}
        {(predecessors.length > 0 || dependents.length > 0) && (
          <section className="grid gap-4 sm:grid-cols-2">
            <DependencyList
              label="Waits for"
              tasks={predecessors}
              empty="Nothing — this can start on its planned date."
              onJump={onJumpToTask}
            />
            <DependencyList
              label="Holds up"
              tasks={dependents}
              empty="Nothing downstream depends on this."
              onJump={onJumpToTask}
            />
          </section>
        )}

        {/* -------------------------------------------------------- CP-3 */}
        <section className="space-y-3 rounded-lg border border-line bg-bg-subtle p-3.5">
          <p className="label flex items-center gap-1.5">
            <Link2 className="h-3 w-3" />
            Linked work
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={
                <span className="flex items-center gap-1.5">
                  <Target className="h-3.5 w-3.5" />
                  Target segment
                </span>
              }
              hint={
                task.segmentId ? (
                  <Link
                    href={`/targeting/${task.segmentId}`}
                    className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                  >
                    Open {task.segmentName}
                    {task.segmentReach ? ` · ${formatCompact(task.segmentReach)} reachable` : ''}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : (
                  'Attach the audience this task is aimed at.'
                )
              }
            >
              <Select
                value={task.segmentId ?? ''}
                disabled={!canEdit || busy}
                onChange={(e) => void onLink(task.id, { segmentId: e.target.value || null })}
              >
                <option value="">No segment</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.detail}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Approval gate
                </span>
              }
              hint={
                task.approvalChainId ? (
                  <Link href="/approvals" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                    {task.approvalStepCount} step{task.approvalStepCount === 1 ? '' : 's'}
                    {task.approvalsPending > 0 ? ` · ${task.approvalsPending} waiting now` : ''}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : (
                  'Work here reaches a channel ungoverned until a chain is set.'
                )
              }
            >
              <Select
                value={task.approvalChainId ?? ''}
                disabled={!canEdit || busy}
                onChange={(e) => void onLink(task.id, { approvalChainId: e.target.value || null })}
              >
                <option value="">No gate</option>
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.detail}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink">
              <Layers className="h-3.5 w-3.5" />
              Assets from this task
              <span className="tnum text-ink-faint">{task.assets.length}</span>
            </p>
            {task.assets.length === 0 ? (
              <p className="text-xs leading-relaxed text-ink-faint">
                Nothing has been produced against this task yet. Attach an asset already generated for
                this campaign, or write a brief in the Studio.
              </p>
            ) : (
              <ul className="space-y-1">
                {task.assets.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5"
                  >
                    <ChannelChip channel={a.channel} size="sm" showLabel={false} />
                    <Link
                      href={`/studio/${a.id}`}
                      className="min-w-0 flex-1 truncate text-[13px] text-ink hover:text-brand-600"
                    >
                      {a.title}
                    </Link>
                    {a.compositeScore !== null && (
                      <span className="tnum shrink-0 text-2xs text-ink-faint">{a.compositeScore}/100</span>
                    )}
                    <AssetStatusBadge status={a.status as AssetStatus} />
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => void onAssetTask(a.id, null)}
                        disabled={busy}
                        className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
                        aria-label={`Detach ${a.title}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canEdit && attachable.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <Select
                  value={attachId}
                  onChange={(e) => setAttachId(e.target.value)}
                  className="h-8 flex-1 py-0 text-[13px]"
                >
                  <option value="">Attach an existing campaign asset…</option>
                  {attachable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title} ({a.channel})
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  disabled={!attachId || busy}
                  onClick={async () => {
                    await onAssetTask(attachId, task.id)
                    setAttachId('')
                  }}
                >
                  Attach
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function DependencyList({
  label,
  tasks,
  empty,
  onJump,
}: {
  label: string
  tasks: TaskView[]
  empty: string
  onJump: (id: string) => void
}) {
  return (
    <div>
      <p className="label mb-1.5">{label}</p>
      {tasks.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onJump(t.id)}
                className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-line-strong"
              >
                {t.isMilestone && <MilestoneMark />}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{t.title}</span>
                {t.status === 'done' ? (
                  <Badge tone="ok">Done</Badge>
                ) : (
                  <span className="tnum shrink-0 text-2xs text-ink-faint">
                    {t.dueDate ? formatDay(toDay(t.dueDate)) : '—'}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
