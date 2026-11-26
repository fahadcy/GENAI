'use client'

import * as React from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { LineChart as LineChartIcon } from 'lucide-react'
import { CardHeader, EmptyState } from '@/components/ui/primitives'
import { formatMoney } from '@/components/domain'
import {
  ChartFrame,
  ChartTooltip,
  ViewToggle,
  axisMoney,
  axisProps,
  compact,
  formatDay,
  useChartTokens,
  type ChartTokens,
} from './chart-kit'

export type TrendPoint = {
  bucket: string
  signups: number
  conversions: number
  spend: number
  costPerSignup: number | null
}

/**
 * Volume and efficiency, stacked rather than overlaid.
 *
 * Signups and cost-per-signup live on scales three orders of magnitude apart.
 * Putting them on one plot would need a second y-axis, and the alignment of two
 * y-axes is arbitrary — it invents a correlation the data does not contain. Two
 * plots sharing one x-axis say the same thing honestly: read down the column to
 * see whether growth cost more or less than it used to.
 */
export function TrendPanel({
  points,
  grain,
  currency,
  rangeDays,
}: {
  points: TrendPoint[]
  grain: 'day' | 'week'
  currency: string
  rangeDays: number
}) {
  const tokens = useChartTokens()
  const [view, setView] = React.useState<'chart' | 'table'>('chart')

  const data = React.useMemo(
    () => points.map((p) => ({ ...p, label: formatDay(p.bucket, grain) })),
    [points, grain],
  )

  const grainWord = grain === 'week' ? 'Weekly' : 'Daily'
  const paidPoints = data.filter((d) => d.costPerSignup !== null)

  return (
    <div className="card">
      <CardHeader
        title="Acquisition and what it cost"
        description={`${grainWord} signups against blended cost per signup, over the last ${rangeDays} days.`}
        actions={<ViewToggle view={view} onChange={setView} />}
      />

      {data.length === 0 ? (
        <EmptyState
          icon={<LineChartIcon className="h-5 w-5" />}
          title="No measured days in this window"
          description="Nothing has been published long enough to have collected metrics yet. Once a scheduled send goes out, its daily numbers land here the following day."
        />
      ) : view === 'table' ? (
        <TrendTable data={data} currency={currency} grain={grain} />
      ) : (
        <div className="px-2 pb-4 pt-5">
          <PlotHeading
            label="Signups"
            value={compact(data.reduce((a, d) => a + d.signups, 0))}
            hint={`total over ${rangeDays} days`}
          />
          <ChartFrame height={172} ready={tokens !== null}>
            {tokens && <SignupsPlot data={data} tokens={tokens} grain={grain} />}
          </ChartFrame>

          <PlotHeading
            className="mt-5"
            label="Blended cost per signup"
            value={
              paidPoints.length > 0
                ? formatMoney(
                    data.reduce((a, d) => a + d.spend, 0) /
                      Math.max(1, data.reduce((a, d) => a + d.signups, 0)),
                    currency,
                  )
                : '—'
            }
            hint="all media spend ÷ all signups"
          />
          <ChartFrame height={196} ready={tokens !== null}>
            {tokens && (
              <CostPlot data={data} tokens={tokens} currency={currency} grain={grain} />
            )}
          </ChartFrame>

          <p className="mt-3 px-3 text-2xs leading-relaxed text-ink-faint">
            Cost per signup is blended: every pound of media spend divided by every signup, paid
            and organic together. Buckets where nothing was spent leave a gap in the line rather
            than drawing a zero.
            {grain === 'week' &&
              ' The final week runs only as far as today, so it sits below a completed one.'}
          </p>
        </div>
      )}
    </div>
  )
}

function PlotHeading({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: string
  hint: string
  className?: string
}) {
  return (
    <div className={`flex items-baseline gap-2.5 px-3 ${className ?? ''}`}>
      <span className="label">{label}</span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">{value}</span>
      <span className="text-2xs text-ink-faint">{hint}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ plots */

const Y_WIDTH = 52
const MARGIN = { top: 14, right: 58, left: 4, bottom: 0 }

type Row = TrendPoint & { label: string }

function SignupsPlot({ data, tokens, grain }: { data: Row[]; tokens: ChartTokens; grain: 'day' | 'week' }) {
  const axis = axisProps(tokens)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={MARGIN}>
        <defs>
          <linearGradient id="perf-signups-wash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tokens['--series-1']} stopOpacity={0.16} />
            <stop offset="100%" stopColor={tokens['--series-1']} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={tokens['--line']} strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" {...axis} hide />
        <YAxis
          {...axis}
          width={Y_WIDTH}
          allowDecimals={false}
          tickFormatter={(v: number) => compact(v)}
        />
        <Tooltip
          cursor={{ stroke: tokens['--line'], strokeWidth: 1 }}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as Row | undefined
            if (!row) return null
            return (
              <ChartTooltip
                active={active}
                label={formatDay(row.bucket, grain)}
                rows={[
                  { key: 's', color: tokens['--series-1'], label: 'Signups', value: row.signups.toLocaleString() },
                  { key: 'c', label: 'Conversions', value: row.conversions.toLocaleString() },
                ]}
              />
            )
          }}
        />
        <Area
          type="monotone"
          dataKey="signups"
          stroke={tokens['--series-1']}
          strokeWidth={2}
          fill="url(#perf-signups-wash)"
          activeDot={{ r: 4, strokeWidth: 2, stroke: tokens['--surface'] }}
          dot={endpointDot(data.length, tokens, tokens['--series-1'], 'signups', (v) => compact(v))}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function CostPlot({
  data,
  tokens,
  currency,
  grain,
}: {
  data: Row[]
  tokens: ChartTokens
  currency: string
  grain: 'day' | 'week'
}) {
  const axis = axisProps(tokens)
  // Every third label on a daily axis; every label on a weekly one.
  const interval = grain === 'week' ? 0 : Math.max(0, Math.ceil(data.length / 8) - 1)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ ...MARGIN, bottom: 4 }}>
        <CartesianGrid stroke={tokens['--line']} strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" {...axis} interval={interval} minTickGap={8} />
        <YAxis
          {...axis}
          width={Y_WIDTH}
          tickFormatter={(v: number) => axisMoney(v, currency)}
        />
        <Tooltip
          cursor={{ stroke: tokens['--line'], strokeWidth: 1 }}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as Row | undefined
            if (!row) return null
            return (
              <ChartTooltip
                active={active}
                label={formatDay(row.bucket, grain)}
                rows={[
                  {
                    key: 'cps',
                    color: tokens['--series-3'],
                    label: 'Cost per signup',
                    value: row.costPerSignup === null ? 'no spend' : formatMoney(row.costPerSignup, currency),
                  },
                  { key: 'spend', label: 'Spend', value: formatMoney(row.spend, currency) },
                ]}
              />
            )
          }}
        />
        <Line
          type="monotone"
          dataKey="costPerSignup"
          stroke={tokens['--series-3']}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          connectNulls={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: tokens['--surface'] }}
          dot={endpointDot(data.length, tokens, tokens['--series-3'], 'costPerSignup', (v) =>
            formatMoney(v, currency),
          )}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * Labels only the final point. A value beside every point is unreadable; the
 * endpoint is the one a marketer actually looks for, and the axis carries the
 * rest.
 */
function endpointDot(
  length: number,
  tokens: ChartTokens,
  color: string,
  field: 'signups' | 'costPerSignup',
  format: (v: number) => string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (props: any) => {
    const { cx, cy, index, payload } = props as {
      cx?: number
      cy?: number
      index: number
      payload?: Row
    }
    // Area passes `value` as a [base, top] pair, so the number is read off the
    // datum instead — one code path that is right for both chart types.
    const value = payload ? payload[field] : null
    if (index !== length - 1 || cx === undefined || cy === undefined || value === null || value === undefined) {
      return <g key={`d${index}`} />
    }
    return (
      <g key={`d${index}`}>
        <circle cx={cx} cy={cy} r={4} fill={color} stroke={tokens['--surface']} strokeWidth={2} />
        <text
          x={cx + 9}
          y={cy}
          dominantBaseline="middle"
          fontSize={11}
          fontWeight={600}
          fill={tokens['--ink']}
        >
          {format(value)}
        </text>
      </g>
    )
  }
}

/* ------------------------------------------------------------ table twin */

function TrendTable({ data, currency, grain }: { data: Row[]; currency: string; grain: 'day' | 'week' }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line">
            <th className="label px-5 py-2 text-left">{grain === 'week' ? 'Week' : 'Day'}</th>
            <th className="label px-3 py-2 text-right">Signups</th>
            <th className="label px-3 py-2 text-right">Conversions</th>
            <th className="label px-3 py-2 text-right">Spend</th>
            <th className="label px-5 py-2 text-right">Cost / signup</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((d) => (
            <tr key={d.bucket}>
              <td className="px-5 py-1.5 text-ink-muted">{formatDay(d.bucket, grain)}</td>
              <td className="tnum px-3 py-1.5 text-right font-medium text-ink">
                {d.signups.toLocaleString()}
              </td>
              <td className="tnum px-3 py-1.5 text-right text-ink-muted">
                {d.conversions.toLocaleString()}
              </td>
              <td className="tnum px-3 py-1.5 text-right text-ink-muted">
                {formatMoney(d.spend, currency)}
              </td>
              <td className="tnum px-5 py-1.5 text-right font-medium text-ink">
                {d.costPerSignup === null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  formatMoney(d.costPerSignup, currency)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
