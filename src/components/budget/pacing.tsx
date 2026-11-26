'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, CreditCard, Gauge, Link2 } from 'lucide-react'
import { applyAdBudgetAction, applyVideoCeilingAction, enforceCardLimitAction } from '@/app/actions/budget'
import { Badge, Button, Card, CardHeader, EmptyState, ProgressBar } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { money, pct } from '@/lib/budget/money'
import { PACING_STATUS } from '@/lib/budget/view'
import type { PacingLine } from '@/lib/budget/types'
import type { CashForecast } from '@/lib/budget/pacing'
import { cn } from '@/lib/cn'

export type PacingRow = PacingLine & { channelKey: string; category: string; source: 'platform' | 'card' | 'none' }
export type ControlRow = {
  lineId: string
  lineLabel: string
  kind: 'ad_campaign' | 'video_ceiling' | 'card'
  id: string
  name: string
  status: string
  currentDailyPence: number | null
  recommendedDailyPence: number | null
  canApply: boolean
  note: string
}

export function PacingPanel({
  rows,
  cash,
  controls,
  planId,
  planStatus,
  canActivate,
  canCards,
  today,
  periodStart,
  periodEnd,
}: {
  rows: PacingRow[]
  cash: CashForecast | null
  controls: ControlRow[]
  planId: string
  planStatus: string
  canActivate: boolean
  canCards: boolean
  today: string
  periodStart: string
  periodEnd: string
}) {
  const elapsedShare = Math.max(0, Math.min(1, (Date.parse(today) - Date.parse(periodStart)) / Math.max(1, Date.parse(periodEnd) - Date.parse(periodStart) + 86_400_000)))
  const withData = rows.filter((r) => r.status !== 'no_data' || r.actualPence > 0)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<Gauge className="h-4 w-4" />}
          title="Pacing"
          description={`${pct(elapsedShare)} of the period gone. Ad lines pace on what the platforms report, weekday-adjusted; other lines on what the card shows. The worst case respects each platform’s own overspend rules.`}
        />
        {withData.length === 0 ? (
          <EmptyState icon={<Gauge className="h-5 w-5" />} title="Nothing spent yet" description="Pacing appears once platforms report spend or charges reach a connected card." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-[13px]">
              <thead>
                <tr className="border-b border-line bg-bg-subtle text-left text-2xs uppercase tracking-wide text-ink-faint">
                  <th className="px-5 py-2 font-semibold">Line</th>
                  <th className="px-3 py-2 text-right font-semibold">Planned</th>
                  <th className="w-40 px-3 py-2 font-semibold">Spent</th>
                  <th className="px-3 py-2 text-right font-semibold">Projected</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-5 py-2 font-semibold">What to do</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const s = PACING_STATUS[r.status]
                  const share = r.plannedPence > 0 ? r.actualPence / r.plannedPence : 0
                  return (
                    <tr key={r.lineId}>
                      <td className="px-5 py-2.5 align-top">
                        <div className="font-medium text-ink">{r.label}</div>
                        <div className="text-2xs text-ink-faint">{r.source === 'platform' ? 'platform-reported' : r.source === 'card' ? 'from card charges' : 'no data source'}</div>
                      </td>
                      <td className="tnum px-3 py-2.5 text-right align-top">{money(r.plannedPence)}</td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="relative">
                          <ProgressBar value={Math.min(100, share * 100)} tone={r.status === 'over' ? 'danger' : r.status === 'at_risk' ? 'warn' : 'brand'} />
                          {/* Where spend should be by now. */}
                          <span
                            className="absolute -top-0.5 h-2.5 w-px bg-ink"
                            style={{ left: `${Math.min(100, r.plannedPence ? (r.expectedToDatePence / r.plannedPence) * 100 : 0)}%` }}
                            title={`Expected by now: ${money(r.expectedToDatePence)}`}
                          />
                        </div>
                        <div className="tnum mt-1 text-2xs text-ink-faint">
                          {money(r.actualPence)} · expected {money(r.expectedToDatePence)}
                        </div>
                      </td>
                      <td className="tnum px-3 py-2.5 text-right align-top">
                        {money(r.projectedPence)}
                        {r.worstCasePence !== null && <div className="text-2xs text-ink-faint">worst {money(r.worstCasePence)}</div>}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <Badge tone={s.tone} dot>
                          {s.label}
                        </Badge>
                      </td>
                      <td className="max-w-sm px-5 py-2.5 align-top text-xs leading-relaxed text-ink-muted">{r.note}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {cash && <CashCard cash={cash} />}

      <Card>
        <CardHeader
          icon={<Link2 className="h-4 w-4" />}
          title="Where the money is controlled"
          description="Campaigns, the video ceiling and dedicated cards linked to this plan, with the setting that lands each line on plan from today."
        />
        {controls.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-5 w-5" />}
            title="Nothing linked yet"
            description="Link Google Ads campaigns to a line on the plan page, or dedicate a card to a line on the Cards tab. A plan with a video line can set the Video Studio ceiling."
          />
        ) : (
          <ul className="divide-y divide-line">
            {controls.map((c) => (
              <ControlItem key={`${c.kind}:${c.id}`} c={c} planId={planId} planStatus={planStatus} canActivate={canActivate} canCards={canCards} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function ControlItem({ c, planId, canActivate, canCards }: { c: ControlRow; planId: string; planStatus: string; canActivate: boolean; canCards: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const allowed = c.kind === 'card' ? canCards : canActivate
  const apply = async () => {
    setBusy(true)
    const r =
      c.kind === 'ad_campaign'
        ? await applyAdBudgetAction(planId, c.id, c.recommendedDailyPence ?? 0)
        : c.kind === 'video_ceiling'
          ? await applyVideoCeilingAction(planId)
          : await enforceCardLimitAction(c.id, c.recommendedDailyPence ?? 0)
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Applied' : 'Not applied', body: r.message })
    if (r.ok) router.refresh()
  }
  const Icon = c.kind === 'card' ? CreditCard : CalendarClock
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">
            {c.name} <span className="font-normal text-ink-faint">· {c.lineLabel}</span>
          </div>
          <div className="tnum mt-0.5 text-xs text-ink-muted">
            {c.kind === 'ad_campaign' && (
              <>
                Daily budget {money(c.currentDailyPence ?? 0)} → <strong className="text-ink">{money(c.recommendedDailyPence ?? 0)}</strong> · {c.status}
              </>
            )}
            {c.kind === 'card' && (
              <>
                Monthly limit {c.currentDailyPence ? money(c.currentDailyPence) : 'none'} → <strong className="text-ink">{money(c.recommendedDailyPence ?? 0)}</strong>
              </>
            )}
          </div>
          <p className="mt-0.5 max-w-xl text-2xs leading-snug text-ink-faint">{c.note}</p>
        </div>
      </div>
      {c.canApply && allowed && (
        <Button size="xs" onClick={apply} loading={busy}>
          Apply
        </Button>
      )}
    </li>
  )
}

function CashCard({ cash }: { cash: CashForecast }) {
  const used = cash.limitPence ? (cash.alreadyChargedPence / cash.limitPence) * 100 : 0
  const forecast = cash.limitPence ? (cash.forecastPence / cash.limitPence) * 100 : 0
  // Charges by day, for a compact strip.
  const byDay = new Map<string, number>()
  for (const c of cash.charges) byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.amountPence)
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  const max = Math.max(1, ...days.map(([, v]) => v))
  return (
    <Card>
      <CardHeader
        icon={<CreditCard className="h-4 w-4" />}
        title="Cash forecast"
        description="When the card will actually be charged: threshold billing replayed day by day from each platform’s run rate, with what billing has added so far."
      />
      <div className="space-y-4 p-5">
        <p className={cn('text-[14px] leading-relaxed', cash.limitHitOn ? 'font-medium text-danger-fg' : 'text-ink')}>{cash.note}</p>
        {cash.limitPence !== null && (
          <div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-inset" role="img" aria-label="Card limit used and forecast">
              <div className="h-full bg-brand-600" style={{ width: `${Math.min(100, used)}%` }} />
              <div className={cn('h-full', cash.limitHitOn ? 'bg-danger-fg' : 'bg-brand-600/40')} style={{ width: `${Math.min(100 - Math.min(100, used), forecast)}%` }} />
            </div>
            <div className="tnum mt-1.5 flex flex-wrap justify-between gap-2 text-2xs text-ink-faint">
              <span>Charged {money(cash.alreadyChargedPence)}</span>
              <span>Forecast +{money(cash.forecastPence)}</span>
              <span>Limit {money(cash.limitPence)}</span>
            </div>
          </div>
        )}
        {days.length > 0 && (
          <div>
            <div className="flex h-16 items-end gap-[3px]" role="img" aria-label="Forecast charges by day">
              {days.map(([d, v]) => (
                <div key={d} className="min-w-[4px] flex-1 rounded-t" style={{ height: `${Math.max(6, (v / max) * 100)}%`, backgroundColor: 'rgb(var(--series-1))' }} title={`${d}: ${money(v)}`} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-2xs text-ink-faint">
              <span>{days[0][0]}</span>
              <span>{days[days.length - 1][0]}</span>
            </div>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          {cash.byPlatform.map((p) => (
            <div key={p.platform} className="rounded-md bg-bg-subtle px-3 py-2 text-[13px]">
              <div className="text-ink">{p.label}</div>
              <div className="tnum text-xs text-ink-muted">
                {p.count} charge{p.count === 1 ? '' : 's'} · {money(p.amountPence)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
