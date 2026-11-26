'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Calculator, Check, FlaskConical, Play, TriangleAlert } from 'lucide-react'
import { applyAllocationAction, loadSimulationAction, runAllocationAction } from '@/app/actions/budget'
import { Badge, Button, Card, CardHeader, EmptyState, ProgressBar } from '@/components/ui/primitives'
import { Disclosure, useToast } from '@/components/ui/client'
import { CurveChart } from './curve-chart'
import { fmtNum, money, pct } from '@/lib/budget/money'
import { BINDING_LABEL, QUALITY } from '@/lib/budget/view'
import type { AllocationResult, AllocationSettings, Band, StoredCurve } from '@/lib/budget/types'
import { cn } from '@/lib/cn'

export type AllocationView = {
  id: string
  createdAt: string
  planVersion: number
  result: AllocationResult
  curves: StoredCurve[]
  settings: AllocationSettings
  simulated: boolean
  appliedPlanId: string | null
  hash: string
}

function unitFor(r: AllocationResult) {
  return r.objective === 'profit' ? 'profit' : r.metric === 'revenue' ? 'revenue' : 'conversions'
}

function fmtBand(b: Band | null, r: AllocationResult, short = false): string {
  if (!b) return '—'
  const f = (v: number) => (r.objective === 'profit' || r.metric === 'revenue' ? money(v) : fmtNum(v, v < 10 ? 1 : 0))
  return short ? f(b.mean) : `${f(b.mean)} (${f(b.p10)}–${f(b.p90)})`
}

export function AllocatorPanel({
  planId,
  planVersion,
  planStatus,
  canPlan,
  allocation,
  hasHistory,
}: {
  planId: string
  planVersion: number
  planStatus: string
  canPlan: boolean
  allocation: AllocationView | null
  hasHistory: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<'run' | 'apply' | 'sim' | null>(null)

  const act = async (kind: 'run' | 'apply' | 'sim') => {
    setBusy(kind)
    const r =
      kind === 'run' ? await runAllocationAction(planId) : kind === 'sim' ? await loadSimulationAction(planId) : await applyAllocationAction(allocation!.id)
    setBusy(null)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? (kind === 'apply' ? 'Applied' : 'Done') : 'Could not do that', body: r.message })
    if (r.ok && kind === 'apply' && r.data && 'planId' in r.data && r.data.revision) router.push(`/budget/plans/${r.data.planId}`)
    else if (r.ok) router.refresh()
  }

  const stale = allocation && allocation.planVersion !== planVersion
  const r = allocation?.result
  const closed = planStatus === 'superseded' || planStatus === 'closed'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Calculator className="h-4 w-4" />}
          title="Allocator"
          description="Splits the budget so the next pound always goes where it returns most — against many plausible versions of each channel’s curve, not one, and never past the evidence."
          actions={
            canPlan && !closed ? (
              <div className="flex flex-wrap items-center gap-2">
                {!hasHistory && (
                  <Button size="sm" variant="ghost" onClick={() => act('sim')} loading={busy === 'sim'}>
                    <FlaskConical className="h-3.5 w-3.5" /> Load simulated history
                  </Button>
                )}
                <Button size="sm" variant={allocation && !stale ? 'secondary' : 'primary'} onClick={() => act('run')} loading={busy === 'run'}>
                  <Play className="h-3.5 w-3.5" /> {allocation ? 'Run again' : 'Run allocator'}
                </Button>
              </div>
            ) : undefined
          }
        />
        {!allocation || !r ? (
          <EmptyState
            icon={<Calculator className="h-5 w-5" />}
            title={hasHistory ? 'Not run yet' : 'No channel history yet'}
            description={
              hasHistory
                ? 'Run the allocator to fit a response curve for every line with tracked outcomes and get a recommended split.'
                : 'Curves need weekly spend and outcomes. GenAI reads its own Google Ads, Meta, email and blog results automatically; import history for anything else from the Cards tab, or load the simulated market to try it.'
            }
          />
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              {allocation.simulated && (
                <Badge tone="warn" dot>
                  Simulated history
                </Badge>
              )}
              {stale && <Badge tone="warn">The plan changed since this run</Badge>}
              {allocation.appliedPlanId && (
                <Badge tone="ok">
                  <Check className="h-3 w-3" /> Applied
                </Badge>
              )}
              <span>
                Run {new Date(allocation.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · seed{' '}
                <span className="font-mono">{allocation.settings.seed.slice(0, 18)}</span> · sha256{' '}
                <span className="font-mono">{allocation.hash.slice(0, 12)}</span>
              </span>
            </div>

            <p className="max-w-4xl text-[14px] leading-relaxed text-ink">{r.summary}</p>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label={`Expected ${unitFor(r)} now`} value={fmtBand(r.totals.current, r, true)} hint={`likely ${fmtBand(r.totals.current, r).split('(')[1]?.replace(')', '') ?? ''}`} />
              <Tile
                label={`Expected ${unitFor(r)} recommended`}
                value={fmtBand(r.totals.recommended, r, true)}
                hint={`likely ${fmtBand(r.totals.recommended, r).split('(')[1]?.replace(')', '') ?? ''}`}
                tone="brand"
              />
              <Tile
                label="Chance it is better"
                value={pct(r.totals.probabilityBetter)}
                hint="share of plausible worlds where the new split wins"
                tone={r.totals.probabilityBetter >= 0.75 ? 'ok' : r.totals.probabilityBetter >= 0.55 ? 'neutral' : 'warn'}
              />
              <Tile
                label="Held back / learning"
                value={`${money(r.unallocatedPence)} / ${money(r.learningPence)}`}
                hint="not spent past the evidence / spent to learn"
              />
            </div>

            {r.warnings.length > 0 && (
              <ul className="space-y-1.5">
                {r.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md bg-warn-bg px-3 py-2 text-[13px] text-ink-muted ring-1 ring-warn-fg/20">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn-fg" />
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[860px] text-[13px]">
                <thead>
                  <tr className="border-y border-line bg-bg-subtle text-left text-2xs uppercase tracking-wide text-ink-faint">
                    <th className="px-5 py-2 font-semibold">Line</th>
                    <th className="px-3 py-2 text-right font-semibold">Now</th>
                    <th className="px-3 py-2 text-right font-semibold">Recommended</th>
                    <th className="px-3 py-2 text-right font-semibold">Change</th>
                    <th className="px-3 py-2 text-right font-semibold">Expected {unitFor(r)}</th>
                    <th className="px-3 py-2 text-right font-semibold">Next £100</th>
                    <th className="w-28 px-3 py-2 font-semibold">Saturation</th>
                    <th className="px-5 py-2 font-semibold">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {r.lines.map((l) => (
                    <tr key={l.id} className={cn(!l.optimisable && 'text-ink-muted')}>
                      <td className="px-5 py-2.5 align-top">
                        <div className="font-medium text-ink">{l.label}</div>
                        {BINDING_LABEL[l.binding] && <div className="text-2xs text-ink-faint">{BINDING_LABEL[l.binding]}</div>}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right align-top">{money(l.currentPence)}</td>
                      <td className="tnum px-3 py-2.5 text-right align-top font-semibold text-ink">
                        {money(l.recommendedPence)}
                        {l.learningPence > 0 && <div className="text-2xs font-normal text-info-fg">incl. {money(l.learningPence)} learning</div>}
                      </td>
                      <td className={cn('tnum whitespace-nowrap px-3 py-2.5 text-right align-top', l.deltaPence > 0 ? 'text-ok-fg' : l.deltaPence < 0 ? 'text-danger-fg' : 'text-ink-faint')}>
                        {l.deltaPence === 0 ? '—' : `${l.deltaPence > 0 ? '+' : ''}${money(l.deltaPence)}`}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right align-top">{fmtBand(l.outcomeRecommended, r)}</td>
                      <td className="tnum px-3 py-2.5 text-right align-top">{fmtBand(l.marginalPer100, r, true)}</td>
                      <td className="px-3 py-2.5 align-top">
                        {l.saturation !== null ? (
                          <div title={`${pct(l.saturation)} of the way to its ceiling`}>
                            <ProgressBar value={l.saturation * 100} tone={l.saturation > 0.8 ? 'warn' : 'brand'} />
                            <div className="tnum mt-1 text-2xs text-ink-faint">{pct(l.saturation)}</div>
                          </div>
                        ) : (
                          <span className="text-2xs text-ink-faint">no curve</span>
                        )}
                      </td>
                      <td className="max-w-md px-5 py-2.5 align-top text-xs leading-relaxed text-ink-muted">{l.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canPlan && !closed && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-bg-subtle px-4 py-3">
                <p className="text-[13px] text-ink-muted">
                  {planStatus === 'active' || planStatus === 'approved' || planStatus === 'in_review'
                    ? 'Applying drafts a revision of the plan. It goes through approval before it replaces anything.'
                    : 'Applying updates this draft. It still goes through approval before it goes live.'}
                </p>
                {allocation.appliedPlanId && allocation.appliedPlanId !== planId ? (
                  <Link href={`/budget/plans/${allocation.appliedPlanId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink underline">
                    Open the revision <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => act('apply')} loading={busy === 'apply'} disabled={!!stale || !!allocation.appliedPlanId}>
                    Apply recommendation
                  </Button>
                )}
              </div>
            )}

            {allocation.curves.length > 0 && (
              <div>
                <h3 className="mb-2 text-[13px] font-semibold text-ink">Response curves</h3>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {allocation.curves.map((c) => {
                    const line = r.lines.find((l) => l.key === c.channelKey)
                    const weeks = allocation.settings.weeks
                    const cash = allocation.settings.cashFactors[c.channelKey] ?? 1
                    const q = QUALITY[c.quality]
                    return (
                      <div key={c.channelKey} className="rounded-lg border border-line p-3">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[13px] font-medium text-ink">{line?.label ?? c.channelKey}</span>
                          <Badge tone={q.tone}>{q.label}</Badge>
                        </div>
                        <CurveChart
                          curve={c}
                          label={line?.label ?? c.channelKey}
                          currentWeekly={line ? line.currentPence / cash / weeks : 0}
                          recommendedWeekly={line ? line.recommendedPence / cash / weeks : 0}
                          metricLabel={c.metric}
                        />
                        <p className="mt-1.5 text-2xs leading-snug text-ink-faint">
                          {c.weeks} weeks · fit explains {pct(c.r2)} · {pct(c.credibility)} evidence, {pct(1 - c.credibility)} prior · 80% saturated at {money(c.saturationWeeklyPence)}/wk
                        </p>
                        {c.notes.length > 0 && <p className="mt-1 text-2xs leading-snug text-warn-fg">{c.notes.join(' ')}</p>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <Disclosure summary="How this was worked out">
              <div className="space-y-2 text-[13px] leading-relaxed text-ink-muted">
                <p>
                  Each line with weekly spend and outcomes gets a response curve: carryover (adstock) and diminishing returns (a Hill curve), the
                  same family Google Meridian and Meta Robyn use. With little history the fit is blended with a weak prior in proportion to the
                  evidence, so a short history cannot promise a fortune.
                </p>
                <p>
                  The curve is refitted {allocation.curves[0] ? 80 : 0} times on resampled versions of the history. The allocator moves money in
                  small steps to wherever the next step returns most{allocation.settings.riskAversion > 0 ? ', discounting returns it is unsure of' : ''}, and
                  reports the share of those plausible worlds in which the new split beats the old one.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>Risk aversion: {pct(allocation.settings.riskAversion)} · learning budget: {pct(allocation.settings.learningShare)} of flexible money</li>
                  <li>
                    No line goes past {allocation.settings.extrapolationCap}× its biggest week on record
                    {allocation.settings.maxShift !== null ? `, or moves more than ${pct(allocation.settings.maxShift)} in one reallocation` : ''}.
                  </li>
                  <li>
                    Cash factors from the card reconciliation:{' '}
                    {Object.keys(allocation.settings.cashFactors).length
                      ? Object.entries(allocation.settings.cashFactors)
                          .map(([k, v]) => `${r.lines.find((l) => l.key === k)?.label ?? k} ${money(Math.round(v * 100))} per £1`)
                          .join(', ')
                      : 'none yet — reconcile a card to measure what each channel really costs to pay for.'}
                  </li>
                  <li>
                    Incrementality:{' '}
                    {Object.entries(allocation.settings.incrementality).filter(([, v]) => v < 1).length
                      ? Object.entries(allocation.settings.incrementality)
                          .filter(([, v]) => v < 1)
                          .map(([k, v]) => `${r.lines.find((l) => l.key === k)?.label ?? k} ${pct(v)}`)
                          .join(', ')
                      : 'every line counts its reported results in full. Set a lower share on a line when a lift test or your CRM shows the platform over-claims.'}
                  </li>
                </ul>
              </div>
            </Disclosure>
          </div>
        )}
      </Card>
    </div>
  )
}

function Tile({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: 'neutral' | 'brand' | 'ok' | 'warn' }) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'brand' ? 'border-brand-200 bg-brand-50' : tone === 'ok' ? 'border-ok-fg/25 bg-ok-bg' : tone === 'warn' ? 'border-warn-fg/25 bg-warn-bg' : 'border-line',
      )}
    >
      <div className="label">{label}</div>
      <div className="tnum mt-1.5 text-xl font-semibold text-ink">{value}</div>
      {hint && <div className="mt-1 text-2xs leading-snug text-ink-faint">{hint}</div>}
    </div>
  )
}
