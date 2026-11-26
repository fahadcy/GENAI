'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, RefreshCw, Scale } from 'lucide-react'
import { discrepancyAction, reconcileAction } from '@/app/actions/budget'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Textarea } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { money } from '@/lib/budget/money'
import { DISC_STATUS, KIND_LABEL, SEVERITY_TONE } from '@/lib/budget/view'
import type { DiscrepancyKind, ReconciliationReport, Severity } from '@/lib/budget/types'
import { cn } from '@/lib/cn'

export type DiscrepancyRow = {
  id: string
  kind: DiscrepancyKind
  severity: Severity
  amountPence: number
  title: string
  detail: string
  suggestion: string
  status: string
  present: boolean
  note: string | null
  firstSeenAt: string
}

export function ReconcilePanel({
  planId,
  report,
  reportHash,
  createdAt,
  discrepancies,
  canPlan,
  canResolve,
  hasCards,
}: {
  planId: string
  report: ReconciliationReport | null
  reportHash: string | null
  createdAt: string | null
  discrepancies: DiscrepancyRow[]
  canPlan: boolean
  canResolve: boolean
  hasCards: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const [filter, setFilter] = React.useState<'open' | 'all'>('open')
  const run = async () => {
    setBusy(true)
    const r = await reconcileAction(planId)
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Reconciled' : 'Could not reconcile', body: r.message })
    if (r.ok) router.refresh()
  }
  const shown = discrepancies.filter((d) => (filter === 'open' ? d.status === 'open' && d.present : true))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Scale className="h-4 w-4" />}
          title="Three-way match"
          description="Plan, what the platforms report, and what actually left the card — line by line. Threshold billing makes small gaps normal; anything outside one billing threshold is flagged below."
          actions={
            canPlan ? (
              <Button size="sm" onClick={run} loading={busy} disabled={!hasCards && !report}>
                <RefreshCw className="h-3.5 w-3.5" /> Reconcile now
              </Button>
            ) : undefined
          }
        />
        {!report ? (
          <EmptyState
            icon={<Scale className="h-5 w-5" />}
            title={hasCards ? 'Not reconciled yet' : 'No card connected'}
            description={hasCards ? 'Run a reconciliation to match card charges to platform spend and the plan.' : 'Connect a card or import a statement on the Cards tab, then reconcile.'}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 px-5 pt-3 text-xs text-ink-faint">
              {report.simulated && (
                <Badge tone="warn" dot>
                  Includes simulated data
                </Badge>
              )}
              <span>
                {createdAt && new Date(createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · sha256{' '}
                <span className="font-mono">{reportHash?.slice(0, 12)}</span>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-4">
              <Mini label="Planned" value={money(report.totals.plannedPence)} />
              <Mini label="Platforms report" value={money(report.totals.platformPence)} />
              <Mini label="Card charged" value={money(report.totals.cardPence)} />
              <Mini label="Matched cleanly" value={money(report.totals.explainedPence)} hint={report.totals.cardPence ? `${Math.round((report.totals.explainedPence / report.totals.cardPence) * 100)}% of charges` : undefined} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead>
                  <tr className="border-y border-line bg-bg-subtle text-left text-2xs uppercase tracking-wide text-ink-faint">
                    <th className="px-5 py-2 font-semibold">Line</th>
                    <th className="px-3 py-2 text-right font-semibold">Plan</th>
                    <th className="px-3 py-2 text-right font-semibold">Platform</th>
                    <th className="px-3 py-2 text-right font-semibold">Card</th>
                    <th className="px-3 py-2 text-right font-semibold">Billing gap</th>
                    <th className="px-3 py-2 text-right font-semibold">Card vs plan</th>
                    <th className="px-5 py-2 font-semibold">Match</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.rows.map((r, i) => (
                    <tr key={r.lineId ?? `x${i}`} className={cn(!r.lineId && 'bg-danger-bg/40')}>
                      <td className="px-5 py-2 font-medium text-ink">{r.label}</td>
                      <td className="tnum px-3 py-2 text-right">{r.plannedPence ? money(r.plannedPence) : '—'}</td>
                      <td className="tnum px-3 py-2 text-right">{r.platformPence === null ? <span className="text-ink-faint">not connected</span> : money(r.platformPence)}</td>
                      <td className="tnum px-3 py-2 text-right">{money(r.cardPence)}</td>
                      <td className="tnum px-3 py-2 text-right text-ink-muted">{r.billingGapPence === null ? '—' : `${r.billingGapPence > 0 ? '+' : ''}${money(r.billingGapPence)}`}</td>
                      <td className={cn('tnum px-3 py-2 text-right', r.planGapPence > 0 && r.plannedPence ? 'text-danger-fg' : 'text-ink-muted')}>
                        {r.planGapPence > 0 ? '+' : ''}
                        {money(r.planGapPence)}
                      </td>
                      <td className="px-5 py-2">
                        {r.lineId && r.cardPence === 0 && !r.platformPence ? (
                          <span className="text-xs text-ink-faint">nothing yet</span>
                        ) : r.matched ? (
                          <span className="inline-flex items-center gap-1 text-xs text-ok-fg">
                            <CheckCircle2 className="h-3.5 w-3.5" /> clean
                          </span>
                        ) : (
                          <span className="text-xs text-warn-fg">see below</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-3 text-2xs leading-relaxed text-ink-faint">
              Billing gap = card − platform: VAT, FX fees, and spend not yet billed under threshold billing. A card charged with nothing to match it is shown in red.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Discrepancies"
          description="Each one says what it is, the money involved, and what to do. Explaining or resolving one needs a note, which goes on the audit trail; one that comes back after being resolved reopens."
          actions={
            <div className="flex gap-1">
              {(['open', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn('rounded-md px-2.5 py-1 text-xs font-medium', filter === f ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:text-ink')}
                >
                  {f === 'open' ? `Open (${discrepancies.filter((d) => d.status === 'open' && d.present).length})` : `All (${discrepancies.length})`}
                </button>
              ))}
            </div>
          }
        />
        {shown.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title={filter === 'open' ? 'Nothing open' : 'No discrepancies'} description="Plan, platforms and card agree within billing tolerances." />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((d) => (
              <DiscrepancyItem key={d.id} d={d} canPlan={canResolve} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function DiscrepancyItem({ d, canPlan }: { d: DiscrepancyRow; canPlan: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = React.useState<null | 'explained' | 'resolved'>(null)
  const [note, setNote] = React.useState(d.note ?? '')
  const [busy, setBusy] = React.useState(false)
  const save = async (status: 'open' | 'explained' | 'resolved') => {
    setBusy(true)
    const r = await discrepancyAction(d.id, status, status === 'open' ? null : note)
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Updated' : 'Not updated', body: r.message })
    if (r.ok) {
      setOpen(null)
      router.refresh()
    }
  }
  const st = DISC_STATUS[d.status] ?? DISC_STATUS.open
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={SEVERITY_TONE[d.severity]} dot>
              {d.severity}
            </Badge>
            <Badge>{KIND_LABEL[d.kind] ?? d.kind}</Badge>
            <Badge tone={st.tone}>{st.label}</Badge>
            {!d.present && <Badge>no longer found</Badge>}
          </div>
          <p className="text-[13px] font-medium text-ink">{d.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{d.detail}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink">
            <span className="font-semibold">What to do: </span>
            {d.suggestion}
          </p>
          {d.note && <p className="mt-1 text-xs italic text-ink-faint">Note: {d.note}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="tnum text-[15px] font-semibold text-ink">{money(d.amountPence)}</span>
          {canPlan && (
            <div className="flex gap-1">
              {d.status === 'open' ? (
                <>
                  <Button size="xs" variant="ghost" onClick={() => setOpen('explained')}>
                    Explain
                  </Button>
                  <Button size="xs" onClick={() => setOpen('resolved')}>
                    Resolve
                  </Button>
                </>
              ) : (
                <Button size="xs" variant="ghost" onClick={() => save('open')} loading={busy}>
                  Reopen
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === 'explained' ? 'Explain this discrepancy' : 'Mark as resolved'}
        description={d.title}
        size="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => open && save(open)} loading={busy} disabled={!note.trim()}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Note" hint="Recorded against your name in the audit trail.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={open === 'explained' ? 'e.g. LinkedIn bills in USD; FX is expected.' : 'e.g. Refund received from Google on 14 Oct.'} />
        </Field>
      </Modal>
    </li>
  )
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="label">{label}</div>
      <div className="tnum mt-1 text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="text-2xs text-ink-faint">{hint}</div>}
    </div>
  )
}
