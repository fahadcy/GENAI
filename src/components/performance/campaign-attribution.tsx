import * as React from 'react'
import Link from 'next/link'
import { Waypoints } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, CardHeader, EmptyState, ProgressBar } from '@/components/ui/primitives'
import { formatCompact, formatMoney, formatPercent } from '@/components/domain'

export type CampaignRow = {
  campaignId: string
  name: string
  status: string
  objective: string
  goalMetric: string
  targetValue: number | null
  budget: number
  impressions: number
  opens: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  pipeline: number
}

const GOAL_LABEL: Record<string, string> = {
  signups: 'signups',
  conversions: 'conversions',
  opens: 'opens',
  clicks: 'clicks',
  impressions: 'impressions',
  revenue: 'revenue',
}

/**
 * PF-2: the same facts rolled up to the thing someone is accountable for.
 *
 * Two bars per campaign, and they answer different questions: goal progress
 * ("are we getting there?") and budget consumption ("what is it costing?").
 * Reading them together is what tells you whether a campaign is efficient or
 * merely expensive.
 */
export function CampaignAttribution({
  rows,
  currency,
  rangeDays,
}: {
  rows: CampaignRow[]
  currency: string
  rangeDays: number
}) {
  return (
    <div className="card flex flex-col">
      <CardHeader
        title="By campaign"
        description={`Everything measured in the last ${rangeDays} days, attributed to the campaign that commissioned it.`}
        icon={<Waypoints className="h-4 w-4" />}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Waypoints className="h-5 w-5" />}
          title="No campaign has measurable results yet"
          description="Metrics attach to a campaign through the assets it published. Once one of those sends goes out, its numbers roll up here."
        />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((c) => {
            const attained = goalAttained(c)
            const goalPct = c.targetValue && c.targetValue > 0 ? attained / c.targetValue : null
            const budgetPct = c.budget > 0 ? c.spend / c.budget : null
            const cpa = c.spend > 0 && c.conversions > 0 ? c.spend / c.conversions : null
            const roas = c.spend > 0 ? c.revenue / c.spend : null

            return (
              <li key={c.campaignId} className="px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/planner/${c.campaignId}`}
                      className="block truncate text-[13.5px] font-semibold text-ink hover:text-brand-600"
                    >
                      {c.name}
                    </Link>
                    <p className="mt-0.5 truncate text-2xs text-ink-faint">{c.objective}</p>
                  </div>
                  <Badge tone={c.status === 'active' ? 'ok' : 'neutral'}>{c.status}</Badge>
                </div>

                <dl className="mt-2.5 grid grid-cols-4 gap-x-3">
                  <Cell label="Conv." value={c.conversions.toLocaleString()} />
                  <Cell
                    label="CPA"
                    value={cpa === null ? '—' : formatMoney(cpa, currency)}
                    title="Media spend ÷ conversions, blended across paid and organic delivery"
                  />
                  <Cell label="Revenue" value={formatMoney(c.revenue, currency)} />
                  <Cell
                    label="ROAS"
                    value={roas === null ? '—' : `${roas.toFixed(1)}×`}
                    title="Revenue ÷ media spend, blended across paid and organic delivery"
                  />
                </dl>

                {/* Stacked rather than side by side: at half a card's width the
                    "529 of 400 signups" line truncates, and the raw counts are
                    the part a marketer checks. */}
                <div className="mt-3 space-y-2">
                  <Meter
                    name="Goal"
                    label={`${formatCompact(attained)} of ${formatCompact(c.targetValue ?? 0)} ${GOAL_LABEL[c.goalMetric] ?? c.goalMetric}`}
                    pct={goalPct}
                    overTone="ok"
                    tone={goalPct !== null && goalPct >= 0.75 ? 'ok' : 'brand'}
                    empty="No target set on this campaign"
                  />
                  <Meter
                    name="Budget"
                    label={`${formatMoney(c.spend, currency)} of ${formatMoney(c.budget, currency)}`}
                    pct={budgetPct}
                    overTone="warn"
                    tone={budgetPct !== null && budgetPct > 0.9 ? 'warn' : 'brand'}
                    empty="No media spend against this campaign"
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rows.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-2xs leading-relaxed text-ink-faint">
          Cost per acquisition and return on ad spend are blended here: a campaign&apos;s organic
          results share a denominator with its paid spend, so both read better than the paid
          channels alone. The channel scorecard above is where paid efficiency is judged.
        </p>
      )}
    </div>
  )
}

/** The measure the campaign is actually judged on, not a fixed one. */
function goalAttained(c: CampaignRow): number {
  switch (c.goalMetric) {
    case 'conversions':
      return c.conversions
    case 'opens':
      return c.opens
    case 'clicks':
      return c.clicks
    case 'impressions':
      return c.impressions
    case 'revenue':
      return c.revenue
    default:
      return c.signups
  }
}

function Cell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="label truncate">{label}</dt>
      <dd className="tnum mt-0.5 truncate text-[13px] font-semibold text-ink">{value}</dd>
    </div>
  )
}

function Meter({
  name,
  label,
  pct,
  tone,
  overTone,
  empty,
}: {
  name: string
  label: string
  pct: number | null
  tone: 'brand' | 'ok' | 'warn'
  /** Passing 100% means something different per meter: goal met, budget spent. */
  overTone: 'ok' | 'warn'
  empty: string
}) {
  if (pct === null) {
    return (
      <div>
        <p className="text-2xs text-ink-faint">{empty}</p>
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-bg-inset" />
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-2xs font-semibold text-ink">
          {name}{' '}
          <span
            className={cn(
              'tnum',
              pct <= 1 ? 'text-ink-muted' : overTone === 'ok' ? 'text-ok-fg' : 'text-warn-fg',
            )}
          >
            {formatPercent(pct, 0)}
          </span>
        </span>
        <span className="tnum truncate text-2xs text-ink-faint" title={label}>
          {label}
        </span>
      </div>
      <ProgressBar value={Math.min(100, pct * 100)} className="mt-1.5" tone={tone} />
    </div>
  )
}
