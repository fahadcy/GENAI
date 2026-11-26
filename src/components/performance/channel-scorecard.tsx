'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, Download, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, CardHeader, EmptyState } from '@/components/ui/primitives'
import { ChannelChip, channelLabel, formatMoney, formatPercent } from '@/components/domain'
import { compact, downloadCsv, toCsv } from './chart-kit'

export type ChannelRow = {
  channel: string
  impressions: number
  clicks: number
  conversions: number
  signups: number
  spend: number
  revenue: number
  pipeline: number
  prevSpend: number
  prevConversions: number
}

type Derived = ChannelRow & {
  ctr: number | null
  cpa: number | null
  prevCpa: number | null
  roas: number | null
}

type SortKey = 'channel' | 'impressions' | 'clicks' | 'ctr' | 'conversions' | 'spend' | 'cpa' | 'revenue' | 'roas'

const COLUMNS: { key: SortKey; label: string; align: 'left' | 'right'; hint: string }[] = [
  { key: 'channel', label: 'Channel', align: 'left', hint: 'Sort by channel name' },
  { key: 'impressions', label: 'Impr.', align: 'right', hint: 'Impressions delivered' },
  { key: 'clicks', label: 'Clicks', align: 'right', hint: 'Clicks recorded' },
  { key: 'ctr', label: 'CTR', align: 'right', hint: 'Clicks ÷ impressions' },
  { key: 'conversions', label: 'Conv.', align: 'right', hint: 'Conversions attributed' },
  { key: 'spend', label: 'Spend', align: 'right', hint: 'Media spend in the window' },
  { key: 'cpa', label: 'CPA', align: 'right', hint: 'Spend ÷ conversions' },
  { key: 'revenue', label: 'Revenue', align: 'right', hint: 'Revenue attributed' },
  { key: 'roas', label: 'ROAS', align: 'right', hint: 'Revenue ÷ spend' },
]

/**
 * PF-1 and PF-5. Every channel in one table because more than about seven
 * classes stops being a chart — a table reads them all at once, sorts on any
 * column, and exports cleanly.
 *
 * Best and worst cost per acquisition are marked with an icon and a word as
 * well as a colour, so the flag survives colour-blindness and greyscale print.
 */
export function ChannelScorecard({
  rows,
  currency,
  rangeDays,
}: {
  rows: ChannelRow[]
  currency: string
  rangeDays: number
}) {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'conversions',
    dir: 'desc',
  })

  const derived = React.useMemo<Derived[]>(
    () =>
      rows.map((r) => ({
        ...r,
        ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
        cpa: r.spend > 0 && r.conversions > 0 ? r.spend / r.conversions : null,
        prevCpa: r.prevSpend > 0 && r.prevConversions > 0 ? r.prevSpend / r.prevConversions : null,
        roas: r.spend > 0 ? r.revenue / r.spend : null,
      })),
    [rows],
  )

  // Only paid channels can have a cost per acquisition, so the best/worst marks
  // are scoped to those — flagging an organic channel as "best CPA" because it
  // spent nothing would be meaningless.
  const paid = derived.filter((d) => d.cpa !== null)
  const bestCpa = paid.length > 1 ? Math.min(...paid.map((d) => d.cpa as number)) : null
  const worstCpa = paid.length > 1 ? Math.max(...paid.map((d) => d.cpa as number)) : null

  const sorted = React.useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...derived].sort((a, b) => {
      if (sort.key === 'channel') return factor * channelLabel(a.channel).localeCompare(channelLabel(b.channel))
      const av = a[sort.key] as number | null
      const bv = b[sort.key] as number | null
      // Rows with no value for the sorted measure always sink to the bottom,
      // whichever direction is active — otherwise they'd top an ascending sort.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return factor * (av - bv)
    })
  }, [derived, sort])

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'channel' ? 'asc' : 'desc' }))

  const exportCsv = () => {
    const csv = toCsv(
      [
        'Channel', 'Impressions', 'Clicks', 'CTR', 'Conversions', 'Signups',
        `Spend (${currency})`, `CPA (${currency})`, `Revenue (${currency})`,
        `Pipeline (${currency})`, 'ROAS',
      ],
      sorted.map((r) => [
        channelLabel(r.channel),
        r.impressions,
        r.clicks,
        r.ctr === null ? '' : (r.ctr * 100).toFixed(2),
        r.conversions,
        r.signups,
        r.spend.toFixed(2),
        r.cpa === null ? '' : r.cpa.toFixed(2),
        r.revenue.toFixed(2),
        r.pipeline.toFixed(2),
        r.roas === null ? '' : r.roas.toFixed(2),
      ]),
    )
    const stamp = new Date().toISOString().slice(0, 10)
    downloadCsv(`aurea-channel-scorecard-${rangeDays}d-${stamp}.csv`, csv)
  }

  return (
    <div className="card">
      <CardHeader
        title="Channel scorecard"
        description={`Every channel with delivery in the last ${rangeDays} days, sorted on any column.`}
        actions={
          <Button size="xs" variant="secondary" onClick={exportCsv} disabled={sorted.length === 0}>
            <Download className="h-3 w-3" />
            Export CSV
          </Button>
        }
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="h-5 w-5" />}
          title="No delivery in this window"
          description="Widen the range, or publish a scheduled asset — channel numbers appear the day after a send goes out."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-[13px]">
            <thead>
              <tr className="border-b border-line">
                {COLUMNS.map((c, i) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={cn(
                      'px-3 py-2',
                      c.align === 'left' ? 'text-left' : 'text-right',
                      i === 0 && 'pl-5',
                      i === COLUMNS.length - 1 && 'pr-5',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      title={c.hint}
                      className={cn(
                        'label inline-flex items-center gap-1 transition-colors hover:text-ink',
                        sort.key === c.key && 'text-ink',
                      )}
                    >
                      {c.align === 'right' && sort.key === c.key && <SortIcon dir={sort.dir} />}
                      {c.label}
                      {c.align === 'left' && sort.key === c.key && <SortIcon dir={sort.dir} />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((r) => {
                const isBest = r.cpa !== null && r.cpa === bestCpa
                const isWorst = r.cpa !== null && r.cpa === worstCpa && bestCpa !== worstCpa
                const cpaShift =
                  r.cpa !== null && r.prevCpa !== null ? r.cpa / r.prevCpa - 1 : null
                return (
                  <tr key={r.channel} className="transition-colors hover:bg-surface-hover">
                    {/* The best/worst flag rides the channel, not the number:
                        it keeps the CPA column purely numeric so the figures in
                        it stay aligned down the page. */}
                    <td className="py-2 pl-5 pr-3">
                      <div className="flex items-center gap-2">
                        <ChannelChip channel={r.channel} size="sm" />
                        {isBest && <Badge tone="ok">Best CPA</Badge>}
                        {isWorst && <Badge tone="danger">Worst CPA</Badge>}
                      </div>
                    </td>
                    <Num>{compact(r.impressions)}</Num>
                    <Num>{compact(r.clicks)}</Num>
                    <Num>{r.ctr === null ? '—' : formatPercent(r.ctr, 2)}</Num>
                    <Num strong>{r.conversions.toLocaleString()}</Num>
                    <Num>{r.spend > 0 ? formatMoney(r.spend, currency) : <Organic />}</Num>
                    <td className="px-3 py-2 text-right align-middle">
                      {r.cpa === null ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <>
                          <span className="tnum block font-semibold text-ink">
                            {formatMoney(r.cpa, currency)}
                          </span>
                          {cpaShift !== null && Math.abs(cpaShift) >= 0.05 && (
                            <span
                              className={cn(
                                'tnum inline-flex items-center gap-0.5 text-2xs font-semibold',
                                cpaShift < 0 ? 'text-ok-fg' : 'text-danger-fg',
                              )}
                              title={`Cost per acquisition ${cpaShift < 0 ? 'fell' : 'rose'} ${formatPercent(Math.abs(cpaShift), 0)} against the previous ${rangeDays} days`}
                            >
                              {cpaShift < 0 ? (
                                <TrendingDown className="h-3 w-3" />
                              ) : (
                                <TrendingUp className="h-3 w-3" />
                              )}
                              {formatPercent(Math.abs(cpaShift), 0)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <Num>{formatMoney(r.revenue, currency)}</Num>
                    <td className="tnum py-2 pl-3 pr-5 text-right font-medium text-ink">
                      {r.roas === null ? (
                        <span className="text-ink-faint" title="No media spend, so there is no return to divide">
                          —
                        </span>
                      ) : (
                        `${r.roas.toFixed(1)}×`
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {bestCpa !== null && worstCpa !== null && bestCpa !== worstCpa && (
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-ink-muted">
          {channelLabel(paid.find((p) => p.cpa === worstCpa)?.channel ?? '')} is acquiring at{' '}
          <span className="tnum font-semibold text-ink">{(worstCpa / bestCpa).toFixed(1)}×</span> the
          cost of {channelLabel(paid.find((p) => p.cpa === bestCpa)?.channel ?? '')} over this
          window. The copilot proposes a bounded budget shift when that gap holds with enough
          volume behind it.
        </p>
      )}
    </div>
  )
}

function Num({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <td className={cn('tnum px-3 py-2 text-right', strong ? 'font-semibold text-ink' : 'text-ink-muted')}>
      {children}
    </td>
  )
}

function Organic() {
  return (
    <span className="text-ink-faint" title="No media spend on this channel">
      organic
    </span>
  )
}

function SortIcon({ dir }: { dir: 'asc' | 'desc' }) {
  return dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
}
