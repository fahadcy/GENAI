'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Minus, Plus, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, ProgressBar } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'
import { changePlan } from '@/app/(app)/settings/actions'
import { PLANS, basePrice, monthlyPrice, stackTotal, tierFor, type PlanId } from './plans'

export function PlanPicker({
  currentPlan,
  currentSeats,
  seatsUsed,
  canManage,
}: {
  currentPlan: string
  currentSeats: number
  seatsUsed: number
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [plan, setPlan] = React.useState<PlanId>((currentPlan as PlanId) ?? 'trial')
  const [seats, setSeats] = React.useState(currentSeats)
  const [busy, setBusy] = React.useState(false)

  const changed = plan !== currentPlan || seats !== currentSeats
  const selected = tierFor(plan)
  const price = monthlyPrice(selected, seats)

  const apply = async () => {
    setBusy(true)
    try {
      const result = await changePlan({ plan, seats })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="grid gap-3 lg:grid-cols-4">
        {PLANS.map((tier) => {
          const on = tier.id === plan
          const isCurrent = tier.id === currentPlan
          // Compared at the tier's own included headcount — see stackTotal().
          const tierPrice = basePrice(tier)
          const stack = stackTotal(tier)

          return (
            <button
              key={tier.id}
              type="button"
              disabled={!canManage}
              onClick={() => {
                setPlan(tier.id)
                if (seats < tier.includedSeats) setSeats(tier.includedSeats)
              }}
              className={cn(
                'card flex flex-col p-4 text-left transition-all disabled:cursor-not-allowed',
                on ? 'border-brand-500 ring-2 ring-brand-500/20' : 'hover:border-line-strong',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[13.5px] font-semibold text-ink">{tier.name}</p>
                  <p className="mt-0.5 text-2xs text-ink-faint">{tier.bestFor}</p>
                </div>
                {isCurrent ? (
                  <Badge tone="brand">Current</Badge>
                ) : on ? (
                  <Check className="h-4 w-4 shrink-0 text-brand-600" />
                ) : null}
              </div>

              <div className="mt-3">
                {tier.price === null ? (
                  <p className="text-lg font-semibold tracking-tight text-ink">Let's talk</p>
                ) : (
                  <p className="tnum text-lg font-semibold tracking-tight text-ink">
                    {formatMoney(tier.price, 'GBP')}
                    <span className="text-xs font-normal text-ink-faint">
                      {tier.billing === 'per_seat' ? ' / seat / month' : ' / month'}
                    </span>
                  </p>
                )}
                <p className="mt-1 text-2xs text-ink-muted">
                  {tier.billing === 'per_seat'
                    ? 'billed per person'
                    : `${tier.includedSeats} seats included${tier.extraSeatPrice ? `, then ${formatMoney(tier.extraSeatPrice, 'GBP')} each` : ''}`}
                </p>
              </div>

              <p className="mt-3 text-xs leading-relaxed text-ink-muted">{tier.tagline}</p>

              {/* The commercial argument in one line: what this tier retires. */}
              <div className="mt-3 border-t border-line pt-3">
                <p className="label">Replaces</p>
                <ul className="mt-1.5 space-y-0.5">
                  {tier.replaces.map((r) => (
                    <li key={r.category} className="flex items-baseline justify-between gap-2 text-2xs">
                      <span className="truncate text-ink-muted">{r.typical}</span>
                      <span className="tnum shrink-0 text-ink-faint">
                        {formatMoney(r.monthly, 'GBP')}
                      </span>
                    </li>
                  ))}
                </ul>
                {tierPrice !== null && stack > tierPrice && (
                  <p className="tnum mt-2 text-2xs font-semibold text-ok-fg">
                    {formatMoney(stack - tierPrice, 'GBP')}/mo less at {tier.includedSeats} seat
                    {tier.includedSeats === 1 ? '' : 's'}
                  </p>
                )}
              </div>
            </button>
          )
        })}
      </div>

      <Card className="mt-4 overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">Seats</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              {seatsUsed} {seatsUsed === 1 ? 'person has' : 'people have'} access today. A seat is a
              person who can sign in, whatever their role — analysts and reviewers included.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="flex items-center rounded-lg border border-line">
              <button
                type="button"
                disabled={!canManage || seats <= Math.max(1, seatsUsed)}
                onClick={() => setSeats((s) => Math.max(1, s - 1))}
                className="px-2.5 py-1.5 text-ink-muted transition-colors hover:text-ink disabled:opacity-30"
                aria-label="One fewer seat"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="tnum w-10 text-center text-sm font-semibold text-ink">{seats}</span>
              <button
                type="button"
                disabled={!canManage || seats >= 500}
                onClick={() => setSeats((s) => Math.min(500, s + 1))}
                className="px-2.5 py-1.5 text-ink-muted transition-colors hover:text-ink disabled:opacity-30"
                aria-label="One more seat"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="text-right">
              <p className="tnum text-lg font-semibold leading-none tracking-tight text-ink">
                {price === null ? 'Custom' : formatMoney(price, 'GBP')}
              </p>
              <p className="mt-1 text-2xs text-ink-faint">
                {price === null ? 'priced per agreement' : `${selected.name} · per month`}
              </p>
            </div>

            {canManage && changed && (
              <Button size="sm" variant="primary" loading={busy} onClick={apply}>
                {plan === currentPlan ? 'Update seats' : `Move to ${selected.name}`}
              </Button>
            )}
          </div>
        </div>

        {seats < seatsUsed && (
          <p className="border-t border-line bg-danger-bg px-5 py-2.5 text-xs text-danger-fg">
            {seatsUsed} people already have access. Remove members before reducing to {seats} seats.
          </p>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------------------- usage */

export function UsageMeters({
  usage,
  limits,
  planName,
}: {
  usage: { label: string; value: number; hint: string; limit: number | null }[]
  limits: string
  planName: string
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Usage this month"
        description={`Counted from live rows, not a metering estimate. ${limits}`}
        actions={<Badge tone="neutral">{planName}</Badge>}
      />
      <ul className="divide-y divide-line">
        {usage.map((row) => {
          const pct = row.limit ? Math.min(100, (row.value / row.limit) * 100) : null
          const tone = pct === null ? 'brand' : pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'brand'
          return (
            <li key={row.label} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">{row.label}</span>
                <span className="tnum text-[13px] text-ink">
                  {row.value.toLocaleString('en-GB')}
                  {row.limit !== null && (
                    <span className="text-ink-faint"> / {row.limit.toLocaleString('en-GB')}</span>
                  )}
                </span>
              </div>
              {pct !== null && <ProgressBar value={pct} tone={tone} className="mt-2" />}
              <p className="mt-1.5 text-2xs text-ink-faint">
                {row.hint}
                {pct !== null && pct >= 75 && ` · ${Math.round(pct)}% of the plan allowance`}
                {row.limit === null && ' · unlimited on this plan'}
              </p>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ------------------------------------------------------------ AI spend */

export function AiSpendPanel({
  totals,
  byAgent,
  byMonth,
  liveModel,
}: {
  totals: {
    runs: number
    costUsd: number
    tokens: number
    cacheHits: number
    failures: number
    avgLatencyMs: number | null
    simulatedRuns: number
  }
  byAgent: { agent: string; provider: string; model: string; runs: number; costUsd: number; tokens: number }[]
  byMonth: { period: string; runs: number; costUsd: number }[]
  liveModel: boolean
}) {
  const cacheRate = totals.runs > 0 ? totals.cacheHits / totals.runs : 0
  const maxMonth = Math.max(1, ...byMonth.map((m) => m.runs))

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="AI usage and cost"
        description="Every model call is recorded with its tokens, latency and cost. Nothing here is estimated from a monthly bill."
        icon={<Sparkles className="h-4 w-4" />}
        actions={
          <Badge tone={liveModel ? 'brand' : 'neutral'}>
            {liveModel ? 'Live model' : 'Deterministic simulator'}
          </Badge>
        }
      />

      {!liveModel && (
        <p className="border-b border-line bg-bg-subtle px-5 py-2.5 text-xs leading-relaxed text-ink-muted">
          No model key is configured, so generation runs on the built-in deterministic simulator. Every
          agent, guardrail and cost record below behaves exactly as it would against a live provider —
          the cost is simply zero. Add a key to switch, without changing a line of application code.
        </p>
      )}

      {totals.runs === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-ink-faint">
          No model calls recorded on this workspace yet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
            <Figure label="Model calls" value={totals.runs.toLocaleString('en-GB')} foot="all time" />
            <Figure
              label="Spend"
              value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(2)}` : '$0.00'}
              foot={liveModel ? 'billed in USD by the provider' : 'simulator, no provider charge'}
            />
            <Figure
              label="Tokens"
              value={totals.tokens.toLocaleString('en-GB')}
              foot="prompt and completion"
            />
            <Figure
              label="Cache hit rate"
              value={`${Math.round(cacheRate * 100)}%`}
              foot={`${totals.cacheHits} calls served without a request`}
            />
          </div>

          {byMonth.length > 0 && (
            <div className="border-t border-line px-5 py-4">
              <p className="label mb-2.5">Calls by month</p>
              <ul className="space-y-1.5">
                {[...byMonth].reverse().map((m) => (
                  <li key={m.period} className="flex items-center gap-3">
                    <span className="tnum w-16 shrink-0 text-2xs text-ink-faint">{m.period}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${Math.max(3, (m.runs / maxMonth) * 100)}%` }}
                      />
                    </div>
                    <span className="tnum w-24 shrink-0 text-right text-2xs text-ink-muted">
                      {m.runs} call{m.runs === 1 ? '' : 's'}
                      {m.costUsd > 0 && ` · $${m.costUsd.toFixed(2)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto border-t border-line">
            <table className="w-full min-w-[460px] text-left">
              <thead>
                <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-2 font-semibold">Agent</th>
                  <th className="px-3 py-2 font-semibold">Model</th>
                  <th className="px-3 py-2 text-right font-semibold">Calls</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                  <th className="px-5 py-2 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byAgent.map((row) => (
                  <tr key={`${row.agent}-${row.model}`}>
                    <td className="px-5 py-2.5 font-mono text-2xs text-ink">{row.agent}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-muted">
                      <span className="block truncate" title={`${row.model} · ${row.provider}`}>
                        {row.model}
                      </span>
                      <span className="block text-2xs text-ink-faint">{row.provider}</span>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-[13px] text-ink">{row.runs}</td>
                    <td className="tnum px-3 py-2.5 text-right text-xs text-ink-muted">
                      {row.tokens.toLocaleString('en-GB')}
                    </td>
                    <td className="tnum px-5 py-2.5 text-right text-[13px] text-ink">
                      ${row.costUsd.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totals.failures > 0 && (
            <p className="border-t border-line px-5 py-2.5 text-2xs text-warn-fg">
              {totals.failures} call{totals.failures === 1 ? '' : 's'} failed and fell back to the
              simulator, so no work was lost.
            </p>
          )}
        </>
      )}
    </Card>
  )
}

function Figure({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="px-5 py-3.5">
      <p className="label">{label}</p>
      <p className="tnum mt-1 text-lg font-semibold leading-none tracking-tight text-ink">{value}</p>
      <p className="mt-1.5 text-2xs leading-snug text-ink-faint">{foot}</p>
    </div>
  )
}
