'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Lock, Pencil, Plus, Scale, Send, ShieldCheck, ThumbsDown, ThumbsUp, Trash2, Zap } from 'lucide-react'
import {
  activatePlanAction,
  balanceLinesAction,
  closePlanAction,
  removeLineAction,
  revisePlanAction,
  saveLineAction,
  submitPlanAction,
  updatePlanAction,
} from '@/app/actions/budget'
import { decideAction } from '@/app/actions/approvals'
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@/components/ui/primitives'
import { ConfirmButton, Modal, useToast } from '@/components/ui/client'
import { money, pct, toPence } from '@/lib/budget/money'
import { cn } from '@/lib/cn'

export type LineRow = {
  id: string
  channelKey: string
  label: string
  category: string
  categoryLabel: string
  plannedPence: number
  minPence: number
  maxPence: number | null
  locked: boolean
  allowExtrapolation: boolean
  incrementality: number
  incrementalitySource: string | null
  adCampaignIds: string[]
  notes: string | null
  /** For a revision: the amount on the plan it revises. */
  parentPence: number | null
}

export type PlanView = {
  id: string
  name: string
  status: string
  version: number
  totalPence: number
  periodStart: string
  periodEnd: string
  objective: 'conversions' | 'revenue' | 'profit'
  riskAversion: number
  learningShare: number
  maxShift: number | null
  valuePerConversionPence: number | null
  cardLimitPence: number | null
  notes: string | null
  parentPlanId: string | null
}

type Option = { key: string; label: string; category: string; description: string }

function useRun() {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string; data?: unknown }>, onOk?: (d: unknown) => void) => {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Done' : 'Not done', body: r.message })
    if (r.ok) {
      onOk?.(r.data)
      router.refresh()
    }
    return r.ok
  }
  return { busy, run }
}

export function PlanLines({
  plan,
  lines,
  options,
  campaigns,
  editable,
}: {
  plan: PlanView
  lines: LineRow[]
  options: Option[]
  campaigns: { id: string; name: string; status: string }[]
  editable: boolean
}) {
  const { busy, run } = useRun()
  const [editing, setEditing] = React.useState<LineRow | 'new' | null>(null)
  const sum = lines.reduce((a, l) => a + l.plannedPence, 0)
  const diff = plan.totalPence - sum
  const isRevision = lines.some((l) => l.parentPence !== null)

  return (
    <Card>
      <CardHeader
        title="Lines"
        description="Every kind of marketing cost has a line. Lines with tracked outcomes are optimised; the rest keep their amount within their limits, and all of them are paced and reconciled."
        actions={
          editable ? (
            <div className="flex flex-wrap gap-2">
              {diff !== 0 && (
                <Button size="sm" variant="ghost" onClick={() => run('balance', () => balanceLinesAction(plan.id))} loading={busy === 'balance'}>
                  <Scale className="h-3.5 w-3.5" /> Balance to total
                </Button>
              )}
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" /> Add line
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-line bg-bg-subtle text-left text-2xs uppercase tracking-wide text-ink-faint">
              <th className="px-5 py-2 font-semibold">Line</th>
              <th className="px-3 py-2 text-right font-semibold">Amount</th>
              {isRevision && <th className="px-3 py-2 text-right font-semibold">Was</th>}
              <th className="px-3 py-2 text-right font-semibold">Share</th>
              <th className="px-3 py-2 font-semibold">Limits</th>
              <th className="px-3 py-2 font-semibold">Evidence</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="px-5 py-2.5 align-top">
                  <div className="flex items-center gap-1.5 font-medium text-ink">
                    {l.locked && <Lock className="h-3 w-3 text-ink-faint" aria-label="Locked" />}
                    {l.label}
                  </div>
                  <div className="text-2xs text-ink-faint">{l.categoryLabel}</div>
                </td>
                <td className="tnum px-3 py-2.5 text-right align-top font-semibold text-ink">{money(l.plannedPence)}</td>
                {isRevision && (
                  <td className={cn('tnum px-3 py-2.5 text-right align-top', l.parentPence !== null && l.parentPence !== l.plannedPence ? (l.plannedPence > l.parentPence ? 'text-ok-fg' : 'text-danger-fg') : 'text-ink-faint')}>
                    {l.parentPence === null ? 'new' : l.parentPence === l.plannedPence ? '—' : money(l.parentPence)}
                  </td>
                )}
                <td className="tnum px-3 py-2.5 text-right align-top text-ink-muted">{plan.totalPence ? pct(l.plannedPence / plan.totalPence, 1) : '—'}</td>
                <td className="px-3 py-2.5 align-top text-xs text-ink-muted">
                  {l.minPence ? `min ${money(l.minPence)}` : ''}
                  {l.minPence && l.maxPence !== null ? ' · ' : ''}
                  {l.maxPence !== null ? `max ${money(l.maxPence)}` : ''}
                  {!l.minPence && l.maxPence === null && <span className="text-ink-faint">none</span>}
                  {l.adCampaignIds.length > 0 && <div className="text-2xs">{l.adCampaignIds.length} linked campaign{l.adCampaignIds.length === 1 ? '' : 's'}</div>}
                </td>
                <td className="px-3 py-2.5 align-top text-xs text-ink-muted">
                  {l.incrementality < 1 ? `${pct(l.incrementality)} incremental` : 'reported results in full'}
                  {l.allowExtrapolation && <div className="text-2xs text-warn-fg">may go past its evidence</div>}
                </td>
                <td className="px-5 py-2.5 text-right align-top">
                  {editable && (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(l)} aria-label={`Edit ${l.label}`}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <ConfirmButton
                        size="xs"
                        variant="ghost"
                        aria-label={`Remove ${l.label}`}
                        title={`Remove ${l.label}?`}
                        description="Its amount stays in the total until you balance or reassign it."
                        confirmLabel="Remove"
                        onConfirm={async () => {
                          await run(`rm:${l.id}`, () => removeLineAction(plan.id, l.id))
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </ConfirmButton>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong">
              <td className="px-5 py-2.5 font-semibold text-ink">Total</td>
              <td className={cn('tnum px-3 py-2.5 text-right font-semibold', diff === 0 ? 'text-ink' : 'text-danger-fg')}>{money(sum)}</td>
              <td colSpan={isRevision ? 5 : 4} className="px-3 py-2.5 text-xs text-ink-muted">
                {diff === 0 ? `matches the ${money(plan.totalPence)} budget` : diff > 0 ? `${money(diff)} not assigned to a line` : `${money(-diff)} over the ${money(plan.totalPence)} budget`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {editing && (
        <LineModal
          plan={plan}
          line={editing === 'new' ? null : editing}
          options={options.filter((o) => editing !== 'new' ? true : !lines.some((l) => l.channelKey === o.key))}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  )
}

function LineModal({
  plan,
  line,
  options,
  campaigns,
  onClose,
}: {
  plan: PlanView
  line: LineRow | null
  options: Option[]
  campaigns: { id: string; name: string; status: string }[]
  onClose: () => void
}) {
  const { busy, run } = useRun()
  const [key, setKey] = React.useState(line?.channelKey ?? options[0]?.key ?? '')
  const [label, setLabel] = React.useState(line?.label ?? '')
  const [amount, setAmount] = React.useState(line ? String(line.plannedPence / 100) : '')
  const [min, setMin] = React.useState(line?.minPence ? String(line.minPence / 100) : '')
  const [max, setMax] = React.useState(line?.maxPence != null ? String(line.maxPence / 100) : '')
  const [locked, setLocked] = React.useState(line?.locked ?? false)
  const [extrap, setExtrap] = React.useState(line?.allowExtrapolation ?? false)
  const [incr, setIncr] = React.useState(String(Math.round((line?.incrementality ?? 1) * 100)))
  const [incrSource, setIncrSource] = React.useState(line?.incrementalitySource ?? '')
  const [linked, setLinked] = React.useState<string[]>(line?.adCampaignIds ?? [])
  const opt = options.find((o) => o.key === key)

  const save = () =>
    run('save', () =>
      saveLineAction(plan.id, {
        id: line?.id,
        channelKey: key,
        label: label || undefined,
        plannedPence: toPence(amount),
        minPence: min ? toPence(min) : 0,
        maxPence: max ? toPence(max) : null,
        locked,
        allowExtrapolation: extrap,
        incrementality: Math.max(1, Number(incr) || 100) / 100,
        incrementalitySource: incrSource || null,
        adCampaignIds: linked,
      }),
    ).then((ok) => ok && onClose())

  return (
    <Modal
      open
      onClose={onClose}
      title={line ? `Edit ${line.label}` : 'Add a line'}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={save} loading={busy === 'save'} disabled={!key || amount === ''}>
            Save line
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind of cost" hint={opt?.description}>
            <Select value={key} onChange={(e) => setKey(e.target.value)} disabled={!!line}>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name on the plan" hint="Optional, e.g. “Google — brand search”.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={opt?.label} maxLength={80} />
          </Field>
          <Field label="Amount for the period (£)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum (£)">
              <Input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Maximum (£)">
              <Input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="none" />
            </Field>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Share of reported results that are incremental (%)" hint="100 unless a lift test, holdout or your CRM shows the platform over-claims. Platforms each claim the same customers.">
            <Input inputMode="numeric" value={incr} onChange={(e) => setIncr(e.target.value.replace(/\D/g, '').slice(0, 3))} />
          </Field>
          <Field label="Where that number comes from">
            <Input value={incrSource} onChange={(e) => setIncrSource(e.target.value)} placeholder="e.g. Meta Conversion Lift, Sept 2026" maxLength={200} />
          </Field>
        </div>
        <div className="space-y-2 text-[13px] text-ink-muted">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            Lock this amount — the allocator will not move it (contracts, retainers, committed sponsorship).
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={extrap} onChange={(e) => setExtrap(e.target.checked)} />
            Let the allocator go past 1.5× the biggest week on record. Only when you accept that its forecast out there is a guess.
          </label>
        </div>
        {(opt?.category === 'paid_media' || key === 'google_ads') && campaigns.length > 0 && (
          <Field label="GenAI Google Ads campaigns this line pays for" hint="Pacing uses their daily budgets for the worst case, and a live plan can set their daily budgets.">
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {campaigns.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={linked.includes(c.id)} onChange={(e) => setLinked((v) => (e.target.checked ? [...v, c.id] : v.filter((x) => x !== c.id)))} />
                  {c.name} <span className="text-2xs text-ink-faint">{c.status}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  )
}

export function PlanSettings({ plan, editable }: { plan: PlanView; editable: boolean }) {
  const { busy, run } = useRun()
  const [v, setV] = React.useState({
    name: plan.name,
    total: String(plan.totalPence / 100),
    start: plan.periodStart,
    end: plan.periodEnd,
    objective: plan.objective,
    risk: String(Math.round(plan.riskAversion * 100)),
    learning: String(Math.round(plan.learningShare * 100)),
    shift: plan.maxShift === null ? '' : String(Math.round(plan.maxShift * 100)),
    value: plan.valuePerConversionPence ? String(plan.valuePerConversionPence / 100) : '',
    limit: plan.cardLimitPence ? String(plan.cardLimitPence / 100) : '',
    notes: plan.notes ?? '',
  })
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value })
  const save = () =>
    run('settings', () =>
      updatePlanAction(plan.id, {
        name: v.name,
        totalPence: toPence(v.total),
        periodStart: v.start,
        periodEnd: v.end,
        objective: v.objective,
        riskAversion: Math.min(100, Number(v.risk) || 0) / 100,
        learningShare: Math.min(25, Number(v.learning) || 0) / 100,
        maxShift: v.shift === '' ? null : Math.max(5, Number(v.shift)) / 100,
        valuePerConversionPence: v.value ? toPence(v.value) : null,
        cardLimitPence: v.limit ? toPence(v.limit) : null,
        notes: v.notes || null,
      }),
    )
  return (
    <Card>
      <CardHeader title="Settings" description="The envelope and how cautious the allocator should be." />
      <fieldset disabled={!editable} className={cn("grid gap-3 p-5 sm:grid-cols-2", !editable && "opacity-75")}>
        <Field label="Name" className="sm:col-span-2">
          <Input value={v.name} onChange={set('name')} />
        </Field>
        <Field label="Total (£)">
          <Input inputMode="decimal" value={v.total} onChange={set('total')} />
        </Field>
        <Field label="Optimise for">
          <Select value={v.objective} onChange={set('objective')}>
            <option value="conversions">Most conversions</option>
            <option value="revenue">Most revenue</option>
            <option value="profit">Most profit</option>
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={v.start} onChange={set('start')} />
        </Field>
        <Field label="To">
          <Input type="date" value={v.end} onChange={set('end')} />
        </Field>
        <Field label="Risk aversion (%)" hint="0 maximises the expected result; 100 strongly prefers results it is sure of.">
          <Input inputMode="numeric" value={v.risk} onChange={set('risk')} />
        </Field>
        <Field label="Learning budget (% of flexible money)" hint="Spent where the evidence disagrees most, to learn. Up to 25.">
          <Input inputMode="numeric" value={v.learning} onChange={set('learning')} />
        </Field>
        <Field label="Largest move per line in one reallocation (%)" hint="Blank for no limit. Big swings reset platform learning phases.">
          <Input inputMode="numeric" value={v.shift} onChange={set('shift')} />
        </Field>
        <Field label="Value of a conversion (£)" hint="Needed for the profit objective when only conversions are tracked.">
          <Input inputMode="decimal" value={v.value} onChange={set('value')} />
        </Field>
        <Field label="Card limit for the period (£)" hint="For the cash forecast. Blank uses the connected cards’ limits.">
          <Input inputMode="decimal" value={v.limit} onChange={set('limit')} />
        </Field>
        <Field label="Notes for the reviewer" className="sm:col-span-2">
          <Textarea rows={2} value={v.notes} onChange={set('notes')} />
        </Field>
        {editable && (
          <div className="flex justify-end sm:col-span-2">
            <Button size="sm" onClick={save} loading={busy === 'settings'}>
              Save settings
            </Button>
          </div>
        )}
      </fieldset>
    </Card>
  )
}

export function PlanGovernance({
  plan,
  problems,
  canPlan,
  canActivate,
  decision,
  approvedVersion,
}: {
  plan: PlanView
  problems: string[]
  canPlan: boolean
  canActivate: boolean
  decision: null | { requestId: string; chainName: string; stepName: string; stepIndex: number; totalSteps: number; eligible: boolean; canDecide: boolean; stepRole: string }
  approvedVersion: number | null
}) {
  const router = useRouter()
  const { busy, run } = useRun()
  const [comment, setComment] = React.useState('')
  const [rejecting, setRejecting] = React.useState(false)
  const s = plan.status

  return (
    <Card>
      <CardHeader icon={<ShieldCheck className="h-4 w-4" />} title="Approval" description="A plan commits money across every channel, so it goes through the same approval chains as a campaign." />
      <div className="space-y-3 p-5 text-[13px]">
        {problems.length > 0 && (s === 'draft' || s === 'changes_requested') && (
          <ul className="space-y-1 rounded-md bg-danger-bg px-3 py-2 text-danger-fg ring-1 ring-danger-fg/20">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {(s === 'draft' || s === 'changes_requested') && (
          <>
            <p className="text-ink-muted">
              {s === 'changes_requested' ? 'A reviewer asked for changes. Edit the plan, then send it again.' : 'When the lines are right, send the plan for approval. Any later edit sends it back here.'}
            </p>
            {canPlan && (
              <Button variant="primary" size="sm" onClick={() => run('submit', () => submitPlanAction(plan.id))} loading={busy === 'submit'} disabled={problems.length > 0}>
                <Send className="h-3.5 w-3.5" /> Send for approval
              </Button>
            )}
          </>
        )}
        {s === 'in_review' && decision && (
          <div className="space-y-3">
            <p className="text-ink-muted">
              With <strong className="text-ink">{decision.chainName}</strong> — step {decision.stepIndex + 1} of {decision.totalSteps}: {decision.stepName}.
            </p>
            <div className="rounded-md bg-bg-subtle px-3 py-2 text-ink">
              You are approving {money(plan.totalPence)} of spend from {plan.periodStart} to {plan.periodEnd}, line by line as shown.
            </div>
            {decision.canDecide && decision.eligible ? (
              <>
                {rejecting && <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What needs to change? (required)" />}
                <div className="flex flex-wrap gap-2">
                  {!rejecting ? (
                    <>
                      <Button variant="success" size="sm" onClick={() => run('approve', () => decideAction(decision.requestId, 'approve', undefined, `/budget/plans/${plan.id}`))} loading={busy === 'approve'}>
                        <ThumbsUp className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button size="sm" onClick={() => setRejecting(true)}>
                        <ThumbsDown className="h-3.5 w-3.5" /> Request changes
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={!comment.trim()}
                        loading={busy === 'reject'}
                        onClick={() => run('reject', () => decideAction(decision.requestId, 'reject', comment, `/budget/plans/${plan.id}`), () => setRejecting(false))}
                      >
                        Send back
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-ink-faint">This step is for {decision.stepRole}s.</p>
            )}
          </div>
        )}
        {s === 'approved' && (
          <>
            <p className="text-ink-muted">
              Approved{approvedVersion ? ` at v${approvedVersion}` : ''}. Making it live {plan.parentPlanId ? 'replaces the plan it revises' : 'makes it the plan everything is paced and reconciled against'}.
            </p>
            {canActivate ? (
              <ConfirmButton
                variant="primary"
                size="sm"
                tone="primary"
                title="Make this plan live?"
                description={`${money(plan.totalPence)} from ${plan.periodStart} to ${plan.periodEnd}. Pacing, reconciliation and linked controls switch to it.`}
                confirmLabel="Make live"
                onConfirm={async () => {
                  await run('activate', () => activatePlanAction(plan.id), () => router.push('/budget'))
                }}
              >
                <Zap className="h-3.5 w-3.5" /> Make live
              </ConfirmButton>
            ) : (
              <p className="text-xs text-ink-faint">An owner or marketing ops makes it live.</p>
            )}
          </>
        )}
        {s === 'active' && (
          <>
            <p className="text-ink-muted">Live. Changes go into a revision, which is approved before it replaces this plan.</p>
            <div className="flex flex-wrap gap-2">
              {canPlan && (
                <Button size="sm" onClick={() => run('revise', () => revisePlanAction(plan.id), (d) => d && router.push(`/budget/plans/${(d as { id: string }).id}`))} loading={busy === 'revise'}>
                  Draft a revision
                </Button>
              )}
              {canActivate && (
                <ConfirmButton size="sm" variant="ghost" title="Close this plan?" description="Pacing and reconciliation stop. The history stays." confirmLabel="Close plan" onConfirm={async () => {
                    await run('close', () => closePlanAction(plan.id))
                  }}>
                  Close plan
                </ConfirmButton>
              )}
            </div>
          </>
        )}
        {(s === 'superseded' || s === 'closed') && <Badge>{s === 'superseded' ? 'Replaced by a revision' : 'Closed'}</Badge>}
      </div>
    </Card>
  )
}
