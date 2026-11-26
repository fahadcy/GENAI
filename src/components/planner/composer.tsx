'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  BookmarkCheck,
  Check,
  Flag,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { CHANNEL_META, ChannelChip, formatMoney } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'
import {
  commitPlanAction,
  draftFromTemplateAction,
  draftPlanAction,
  type ObjectiveInput,
} from '@/app/(app)/planner/actions'
import { formatDay, fromDay, spanDays, toDay } from './schedule'
import { GOAL_METRIC_LABEL, ROLE_TITLE, type DraftPlan, type DraftTask, type TemplateView } from './types'

const CHANNEL_KEYS = Object.keys(CHANNEL_META) as Channel[]
const GOALS = ['signups', 'conversions', 'opens', 'clicks', 'impressions']

/**
 * The front door for CP-1: an objective goes in, a sequenced plan comes back,
 * and nothing exists in the database until someone has read it. The draft
 * carries real owners and real dates, so the review is of the plan that will
 * ship rather than a sketch of it.
 */
export function CampaignComposer({
  todayIso,
  currency,
  templates,
  canCreate,
}: {
  todayIso: string
  currency: string
  templates: TemplateView[]
  canCreate: boolean
}) {
  const router = useRouter()
  const toast = useToast()

  const [name, setName] = React.useState('')
  const [objective, setObjective] = React.useState('')
  const [channels, setChannels] = React.useState<string[]>(['email', 'linkedin'])
  const [startDate, setStartDate] = React.useState(() => fromDay(toDay(todayIso) + 7))
  const [durationDays, setDurationDays] = React.useState(42)
  const [budget, setBudget] = React.useState(10000)
  const [goalMetric, setGoalMetric] = React.useState('signups')
  const [targetValue, setTargetValue] = React.useState<number | ''>(250)

  const [drafting, setDrafting] = React.useState(false)
  const [committing, setCommitting] = React.useState(false)
  const [draft, setDraft] = React.useState<DraftPlan | null>(null)
  const [tasks, setTasks] = React.useState<DraftTask[]>([])

  const objectiveOk = objective.trim().length >= 12
  const nameOk = name.trim().length >= 3

  const applyDraft = (plan: DraftPlan) => {
    setDraft(plan)
    setTasks(plan.tasks)
    if (plan.recommendedChannels.length > 0) setChannels(plan.recommendedChannels)
  }

  const generate = async () => {
    setDrafting(true)
    try {
      const res = await draftPlanAction({
        name,
        objective,
        channels,
        startDate,
        durationDays,
        budget,
        goalMetric,
        targetValue: targetValue === '' ? null : targetValue,
      })
      if (!res.ok || !res.data) {
        toast.push({ tone: 'danger', title: 'No plan produced', body: res.message })
        return
      }
      applyDraft(res.data)
      toast.push({
        tone: 'ok',
        title: `Plan drafted — ${res.data.tasks.length} tasks`,
        body: 'Read it below. Nothing has been created yet.',
      })
    } catch {
      toast.push({
        tone: 'danger',
        title: 'The planning agent did not answer',
        body: 'Nothing was created. Your objective is still here — try again.',
      })
    } finally {
      setDrafting(false)
    }
  }

  const useTemplate = async (template: TemplateView) => {
    setDrafting(true)
    try {
      const res = await draftFromTemplateAction(template.id, {
        name: name.trim() || `${template.name} — ${formatDay(toDay(startDate))}`,
        startDate,
      })
      if (!res.ok || !res.data) {
        toast.push({ tone: 'danger', title: 'Template not applied', body: res.message })
        return
      }
      const d = res.data
      hydrateFromDefaults(d.defaults)
      applyDraft(d)
      toast.push({
        tone: 'ok',
        title: `"${template.name}" re-anchored`,
        body: `${d.tasks.length} tasks now start from ${formatDay(toDay(startDate))}. Review before creating.`,
      })
    } finally {
      setDrafting(false)
    }
  }

  const hydrateFromDefaults = (d: ObjectiveInput) => {
    setName(String(d.name))
    setObjective(String(d.objective))
    setChannels(d.channels ?? [])
    setDurationDays(Number(d.durationDays))
    setBudget(Number(d.budget))
    setGoalMetric(String(d.goalMetric ?? 'signups'))
    setTargetValue(d.targetValue == null ? '' : Number(d.targetValue))
  }

  const commit = async () => {
    if (!draft) return
    setCommitting(true)
    try {
      const res = await commitPlanAction({
        draftId: draft.draftId,
        name,
        objective,
        channels,
        startDate,
        durationDays,
        budget,
        goalMetric,
        targetValue: targetValue === '' ? null : targetValue,
        summary: draft.summary,
        phases: draft.phases,
        risks: draft.risks,
        simulated: draft.simulated,
        fromTemplateId: draft.fromTemplate,
        tasks: tasks.map((t) => ({
          ref: t.ref,
          phase: t.phase,
          title: t.title,
          description: t.description,
          channel: t.channel,
          ownerRole: t.ownerRole,
          dependsOn: t.dependsOn,
          isMilestone: t.isMilestone,
          needsApproval: t.needsApproval,
          startDate: t.startDate,
          dueDate: t.dueDate,
        })),
      })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Campaign created' : 'Not created',
        body: res.message,
      })
      if (res.ok && res.data) router.push(`/planner/${res.data.campaignId}`)
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Nothing was created',
        body: 'The campaign and its plan are written together, so no half-built campaign is left behind.',
      })
    } finally {
      setCommitting(false)
    }
  }

  const discard = () => {
    setDraft(null)
    setTasks([])
  }

  /* Removing a task must also remove it from everything that depended on it,
     or the commit would write a dependency pointing at a ref that never existed. */
  const dropTask = (ref: string) =>
    setTasks((prev) =>
      prev
        .filter((t) => t.ref !== ref)
        .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== ref) })),
    )

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Plan a new campaign"
        description="State the objective. GenAI sequences the phases, tasks, owners and dependencies, and you read the whole plan before anything is created."
        icon={<Sparkles className="h-4 w-4 text-brand-600" />}
        actions={draft?.simulated ? <Badge tone="neutral">Simulated model</Badge> : undefined}
      />

      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <Field label="Objective" required>
            <Textarea
              rows={2}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && nameOk && objectiveOk) {
                  void generate()
                }
              }}
              placeholder="Drive 400 qualified signups for the unified workspace launch among heads of marketing at UK and US mid-market SaaS companies"
              className="text-[13.5px]"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Campaign name" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q4 platform launch"
              />
            </Field>
            <Field label="Channels" hint={`${channels.length} selected`}>
              <div className="flex flex-wrap gap-1">
                {CHANNEL_KEYS.map((c) => {
                  const on = channels.includes(c)
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        setChannels((prev) =>
                          prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
                        )
                      }
                      className={cn(
                        'rounded-md border px-2 py-1 text-2xs font-medium transition-colors',
                        on
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-line bg-bg-subtle text-ink-muted hover:border-line-strong hover:text-ink',
                      )}
                    >
                      {CHANNEL_META[c].label}
                    </button>
                  )
                })}
              </div>
            </Field>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-line bg-bg-subtle p-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="Runs for" hint={`ends ${formatDay(toDay(startDate) + durationDays)}`}>
              <div className="relative">
                <Input
                  type="number"
                  min={7}
                  max={180}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value) || 7)}
                  className="pr-12"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-faint">
                  days
                </span>
              </div>
            </Field>
          </div>
          <Field label="Budget" hint={formatMoney(budget, currency)}>
            <Input
              type="number"
              min={0}
              step={500}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value) || 0)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Goal">
              <Select value={goalMetric} onChange={(e) => setGoalMetric(e.target.value)}>
                {GOALS.map((g) => (
                  <option key={g} value={g}>
                    {GOAL_METRIC_LABEL[g] ?? g}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Target">
              <Input
                type="number"
                min={0}
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </Field>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        {templates.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-2xs text-ink-faint">
              <BookmarkCheck className="h-3 w-3" />
              From a template:
            </span>
            {templates.slice(0, 4).map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={!canCreate || drafting}
                onClick={() => void useTemplate(t)}
                className="max-w-[220px] truncate rounded-md border border-line bg-bg-subtle px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
              >
                {t.name} · {t.taskCount} tasks
              </button>
            ))}
          </div>
        ) : (
          <p className="text-2xs text-ink-faint">
            Save any plan as a template once it works, and it will appear here.
          </p>
        )}
        <div className="flex items-center gap-2">
          {!canCreate && (
            <p className="text-xs text-ink-faint">Your role cannot create campaigns.</p>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={generate}
            loading={drafting}
            disabled={!canCreate || !nameOk || !objectiveOk}
          >
            {!drafting && <Wand2 className="h-3.5 w-3.5" />}
            Generate plan
          </Button>
        </div>
      </div>

      {draft && (
        <div className="animate-fade-up border-t border-line">
          <div className="flex items-start gap-3 bg-brand-50/60 px-5 py-3.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <div className="min-w-0 flex-1">
              <p className="label">
                {draft.fromTemplate ? 'Rehydrated from a template' : 'The pla GenAI proposes'}
              </p>
              <p className="mt-1 text-[13.5px] leading-snug text-ink">{draft.summary}</p>
              <p className="mt-1.5 text-xs text-ink-muted">
                {tasks.length} tasks · {draft.phases.length} phases ·{' '}
                {tasks.filter((t) => t.isMilestone).length} milestone
                {tasks.filter((t) => t.isMilestone).length === 1 ? '' : 's'} ·{' '}
                {tasks.filter((t) => t.needsApproval).length} gated · finishing{' '}
                {formatDay(Math.max(...tasks.map((t) => toDay(t.dueDate))))}
              </p>
            </div>
            <button
              type="button"
              onClick={discard}
              className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Discard this draft"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {draft.risks.length > 0 && (
            <ul className="space-y-1.5 border-b border-line bg-warn-bg/40 px-5 py-3">
              {draft.risks.map((r, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-muted">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn-fg" />
                  {r}
                </li>
              ))}
            </ul>
          )}

          <DraftTable tasks={tasks} phases={draft.phases} onDrop={dropTask} />

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg-subtle px-5 py-3">
            <p className="mr-auto text-xs text-ink-faint">
              Nothing has been written yet. Creating writes the campaign and all {tasks.length} tasks
              in one transaction.
            </p>
            <Button variant="ghost" size="sm" onClick={discard} disabled={committing}>
              Discard
            </Button>
            <Button variant="secondary" size="sm" onClick={generate} loading={drafting} disabled={committing}>
              Regenerate
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={commit}
              loading={committing}
              disabled={tasks.length === 0 || !nameOk}
            >
              Create campaign
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function DraftTable({
  tasks,
  phases,
  onDrop,
}: {
  tasks: DraftTask[]
  phases: string[]
  onDrop: (ref: string) => void
}) {
  const byRef = new Map(tasks.map((t) => [t.ref, t]))
  const ordered = phases.length > 0 ? phases : [...new Set(tasks.map((t) => t.phase))]

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left">
        <thead>
          <tr className="border-b border-line">
            {['Task', 'Owner', 'Window', 'Waits for', ''].map((h) => (
              <th key={h} className="label px-5 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((phase) => {
            const inPhase = tasks.filter((t) => t.phase === phase)
            if (inPhase.length === 0) return null
            return (
              <React.Fragment key={phase}>
                <tr className="bg-bg-subtle">
                  <td colSpan={5} className="px-5 py-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                    {phase}
                    <span className="ml-2 font-normal normal-case tracking-normal text-ink-faint">
                      {inPhase.length} task{inPhase.length === 1 ? '' : 's'}
                    </span>
                  </td>
                </tr>
                {inPhase.map((t) => (
                  <tr key={t.ref} className="border-b border-line last:border-b-0 hover:bg-surface-hover">
                    <td className="px-5 py-2.5">
                      <div className="flex items-start gap-2">
                        {t.isMilestone && <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-600" />}
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium leading-snug text-ink">{t.title}</p>
                          {t.description && (
                            <p className="mt-0.5 line-clamp-1 text-xs text-ink-faint">{t.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {t.channel && <ChannelChip channel={t.channel} size="sm" />}
                        {t.needsApproval && (
                          <Badge tone="warn">
                            <ShieldCheck className="h-3 w-3" />
                            Gated
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink">
                        {t.ownerName ? (
                          <Avatar name={t.ownerName} hue={t.ownerHue ?? 250} size={18} />
                        ) : (
                          <Check className="h-3.5 w-3.5 text-ink-faint" />
                        )}
                        <span className="truncate">
                          {t.ownerName ?? ROLE_TITLE[t.ownerRole] ?? t.ownerRole}
                        </span>
                      </span>
                      <p className="mt-0.5 text-2xs text-ink-faint">
                        {ROLE_TITLE[t.ownerRole] ?? t.ownerRole}
                      </p>
                    </td>
                    <td className="tnum whitespace-nowrap px-5 py-2.5 text-[13px] text-ink-muted">
                      {formatDay(toDay(t.startDate))} – {formatDay(toDay(t.dueDate))}
                      <p className="text-2xs text-ink-faint">
                        {spanDays(toDay(t.startDate), toDay(t.dueDate))} days
                      </p>
                    </td>
                    <td className="px-5 py-2.5 text-xs text-ink-muted">
                      {t.dependsOn.length === 0 ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <span className="line-clamp-2">
                          {t.dependsOn.map((d) => byRef.get(d)?.title ?? d).join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => onDrop(t.ref)}
                        className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
                        aria-label={`Remove ${t.title} from the plan`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
