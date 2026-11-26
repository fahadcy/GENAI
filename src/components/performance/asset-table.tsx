'use client'

import * as React from 'react'
import Link from 'next/link'
import { Flame, LayoutList } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, CardHeader, EmptyState, Select } from '@/components/ui/primitives'
import { compact } from './chart-kit'
import { ChannelChip, formatMoney, formatPercent } from '@/components/domain'

export type AssetRow = {
  assetId: string
  title: string
  channel: string
  campaignId: string | null
  campaignName: string | null
  impressions: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  recentCtr: number | null
  baselineCtr: number | null
  ctrDelta: number | null
}

/** The threshold the copilot's fatigue detector uses. Kept in step deliberately. */
const FATIGUE_DROP = 0.25

const ORDERINGS = {
  reach: { label: 'Most impressions', compare: (a: AssetRow, b: AssetRow) => b.impressions - a.impressions },
  revenue: { label: 'Most revenue', compare: (a: AssetRow, b: AssetRow) => b.revenue - a.revenue },
  conversions: { label: 'Most conversions', compare: (a: AssetRow, b: AssetRow) => b.conversions - a.conversions },
  falling: {
    label: 'Sharpest CTR fall',
    compare: (a: AssetRow, b: AssetRow) => (a.ctrDelta ?? 1) - (b.ctrDelta ?? 1),
  },
  rising: {
    label: 'Sharpest CTR rise',
    compare: (a: AssetRow, b: AssetRow) => (b.ctrDelta ?? -1) - (a.ctrDelta ?? -1),
  },
} as const

type OrderKey = keyof typeof ORDERINGS

/**
 * PF-3, the evidence half. The copilot raises a fatigue finding; this is where
 * a marketer checks it against every other live asset and sees that the drop is
 * particular to one piece of creative rather than a bad week everywhere.
 *
 * The CTR-shift column is a diverging bar around a zero line: direction carries
 * the sign, length carries the size, and the signed number sits beside it, so
 * the reading never rests on colour alone.
 */
export function AssetTable({
  rows,
  currency,
  rangeDays,
}: {
  rows: AssetRow[]
  currency: string
  rangeDays: number
}) {
  const [order, setOrder] = React.useState<OrderKey>('falling')

  const sorted = React.useMemo(() => [...rows].sort(ORDERINGS[order].compare), [rows, order])
  const fatiguing = rows.filter((r) => r.ctrDelta !== null && r.ctrDelta <= -FATIGUE_DROP).length

  return (
    <div className="card">
      <CardHeader
        title="Assets in market"
        description={
          fatiguing > 0
            ? `${fatiguing} live asset${fatiguing === 1 ? ' has' : 's have'} lost a quarter or more of their click-through rate against their own baseline.`
            : 'Click-through over the last three days against each asset’s own fourteen-day baseline.'
        }
        actions={
          <Select
            value={order}
            onChange={(e) => setOrder(e.target.value as OrderKey)}
            aria-label="Order assets by"
            className="h-8 w-auto py-0 text-[13px]"
          >
            {(Object.keys(ORDERINGS) as OrderKey[]).map((k) => (
              <option key={k} value={k}>
                {ORDERINGS[k].label}
              </option>
            ))}
          </Select>
        }
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon={<LayoutList className="h-5 w-5" />}
          title="No asset has delivered in this window"
          description="Assets appear here once they have published and started collecting daily metrics."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead>
              <tr className="border-b border-line">
                <th className="label px-5 py-2 text-left">Asset</th>
                <th className="label px-3 py-2 text-right">Impr.</th>
                <th className="label px-3 py-2 text-right">CTR</th>
                <th className="label px-3 py-2 text-right">Conv.</th>
                <th className="label px-3 py-2 text-right">Revenue</th>
                <th
                  className="label px-5 py-2 text-right"
                  title="Last 3 days against the 14 days before them"
                >
                  CTR shift
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((r) => {
                const ctr = r.impressions > 0 ? r.clicks / r.impressions : null
                const fatigued = r.ctrDelta !== null && r.ctrDelta <= -FATIGUE_DROP
                return (
                  <tr key={r.assetId} className="transition-colors hover:bg-surface-hover">
                    <td className="py-2.5 pl-5 pr-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ChannelChip channel={r.channel} size="sm" showLabel={false} />
                        <div className="min-w-0">
                          <Link
                            href={`/studio/${r.assetId}`}
                            className="block max-w-[280px] truncate font-medium text-ink hover:text-brand-600"
                            title={r.title}
                          >
                            {r.title}
                          </Link>
                          <p className="max-w-[280px] truncate text-2xs text-ink-faint">
                            {r.campaignName ?? 'No campaign'}
                            {r.spend > 0 && ` · ${formatMoney(r.spend, currency)} spent`}
                          </p>
                        </div>
                        {fatigued && (
                          <Badge tone="danger" className="shrink-0">
                            <Flame className="h-3 w-3" />
                            Fatigue
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-ink-muted">
                      {compact(r.impressions)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-ink-muted">
                      {ctr === null ? '—' : formatPercent(ctr, 2)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right font-semibold text-ink">
                      {r.conversions.toLocaleString()}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-ink-muted">
                      {formatMoney(r.revenue, currency)}
                    </td>
                    <td className="py-2.5 pl-3 pr-5">
                      <CtrShift row={r} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-line px-5 py-3 text-2xs leading-relaxed text-ink-faint">
        Volume, conversions and revenue cover the last {rangeDays} days. The CTR shift always
        compares the last three days with the fourteen before them, whatever range is selected —
        fatigue is a question about right now, and a ninety-day average would hide it. Assets
        without enough impressions in both windows show no shift rather than a number that would
        be noise.
      </p>
    </div>
  )
}

function CtrShift({ row }: { row: AssetRow }) {
  const { ctrDelta, baselineCtr, recentCtr } = row

  if (ctrDelta === null) {
    return (
      <div className="text-right">
        <span className="text-xs text-ink-faint" title="Fewer than 400 recent or 800 baseline impressions">
          too thin to judge
        </span>
      </div>
    )
  }

  const up = ctrDelta >= 0
  // Clamped so one collapse does not squash every other bar to a sliver.
  const magnitude = Math.min(1, Math.abs(ctrDelta) / 0.6)

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Diverging bar around a zero rule: side carries the sign, length the
            size. The signed number sits beside it, so nothing rests on hue. */}
        <span className="relative h-3 w-14 shrink-0" aria-hidden>
          <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-line-strong" />
          <span
            className={cn(
              'absolute top-1/2 h-1.5 -translate-y-1/2 rounded-[2px]',
              up ? 'bg-ok-fg' : 'bg-danger-fg',
            )}
            style={
              up
                ? { left: '50%', width: `${magnitude * 50}%` }
                : { right: '50%', width: `${magnitude * 50}%` }
            }
          />
        </span>
        <span
          className={cn(
            'tnum w-11 text-right text-xs font-semibold',
            Math.abs(ctrDelta) < 0.02 ? 'text-ink-faint' : up ? 'text-ok-fg' : 'text-danger-fg',
          )}
        >
          {up ? '↑' : '↓'} {formatPercent(Math.abs(ctrDelta), 0)}
        </span>
      </div>
      <span
        className="tnum whitespace-nowrap text-2xs text-ink-faint"
        title="Baseline CTR (14 days) → last three days"
      >
        {baselineCtr !== null ? formatPercent(baselineCtr, 2) : '—'} →{' '}
        {recentCtr !== null ? formatPercent(recentCtr, 2) : '—'}
      </span>
    </div>
  )
}
