import * as React from 'react'
import type { StoredCurve } from '@/lib/budget/types'
import { money } from '@/lib/budget/money'

/**
 * One channel's response curve, drawn by hand in SVG so it follows the theme
 * tokens directly: the fitted line, the P10–P90 band from the bootstrap, the
 * edge of the evidence (largest week on record), and markers for current and
 * recommended weekly spend. Small enough to sit six to a row.
 */
export function CurveChart({
  curve,
  label,
  currentWeekly,
  recommendedWeekly,
  metricLabel,
}: {
  curve: StoredCurve
  label: string
  currentWeekly: number
  recommendedWeekly: number
  metricLabel: string
}) {
  const W = 280
  const H = 150
  const pad = { l: 34, r: 10, t: 12, b: 24 }
  const s = curve.series
  if (s.length < 2) return null
  const maxX = s[s.length - 1].spendPence
  const maxY = Math.max(...s.map((p) => p.p90), 1e-9) * 1.08
  const x = (v: number) => pad.l + (Math.min(v, maxX) / maxX) * (W - pad.l - pad.r)
  const y = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b)
  const line = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.spendPence).toFixed(1)},${y(p.mean).toFixed(1)}`).join(' ')
  const band =
    s.map((p, i) => `${i ? 'L' : 'M'}${x(p.spendPence).toFixed(1)},${y(p.p90).toFixed(1)}`).join(' ') +
    ' ' +
    [...s].reverse().map((p) => `L${x(p.spendPence).toFixed(1)},${y(p.p10).toFixed(1)}`).join(' ') +
    ' Z'
  const at = (w: number) => {
    // Linear interpolation on the stored series.
    for (let i = 1; i < s.length; i++) {
      if (s[i].spendPence >= w) {
        const a = s[i - 1]
        const b = s[i]
        const t = (w - a.spendPence) / Math.max(1, b.spendPence - a.spendPence)
        return a.mean + (b.mean - a.mean) * t
      }
    }
    return s[s.length - 1].mean
  }
  const edge = curve.maxObservedWeeklyPence
  const fmtY = (v: number) => (metricLabel === 'revenue' ? money(v) : v >= 10 ? Math.round(v).toString() : v.toFixed(1))

  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${label} response curve`}>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgb(var(--line))" />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="rgb(var(--line))" />
        {/* Beyond the evidence: shaded, because the curve out there is a guess. */}
        {edge > 0 && edge < maxX && (
          <>
            <rect x={x(edge)} y={pad.t} width={W - pad.r - x(edge)} height={H - pad.t - pad.b} fill="rgb(var(--bg-inset))" opacity={0.7} />
            <text x={x(edge) + 3} y={pad.t + 9} fontSize="8" fill="rgb(var(--ink-faint))">
              beyond your data
            </text>
          </>
        )}
        <path d={band} fill="rgb(var(--series-1))" opacity={0.16} />
        <path d={line} fill="none" stroke="rgb(var(--series-1))" strokeWidth={1.8} />
        {[
          { w: currentWeekly, label: 'now', color: 'rgb(var(--ink-muted))' },
          { w: recommendedWeekly, label: 'rec.', color: 'rgb(var(--series-2))' },
        ].map((m, i) =>
          m.w > 0 ? (
            <g key={i}>
              <line x1={x(m.w)} x2={x(m.w)} y1={y(at(m.w))} y2={H - pad.b} stroke={m.color} strokeDasharray="2 2" />
              <circle cx={x(m.w)} cy={y(at(m.w))} r={3.2} fill={m.color} />
              <text x={x(m.w)} y={H - pad.b + 10 + i * 0} fontSize="8" textAnchor={i ? 'start' : 'end'} dx={i ? 2 : -2} fill={m.color}>
                {m.label}
              </text>
            </g>
          ) : null,
        )}
        <text x={pad.l - 4} y={pad.t + 6} fontSize="8" textAnchor="end" fill="rgb(var(--ink-faint))">
          {fmtY(maxY / 1.08)}
        </text>
        <text x={pad.l - 4} y={H - pad.b} fontSize="8" textAnchor="end" fill="rgb(var(--ink-faint))">
          0
        </text>
        <text x={W - pad.r} y={H - 4} fontSize="8" textAnchor="end" fill="rgb(var(--ink-faint))">
          {money(maxX)}/wk
        </text>
      </svg>
      <figcaption className="mt-1 text-2xs leading-snug text-ink-faint">
        Weekly {metricLabel} against weekly spend. Shaded band: 80% of plausible curves. Past the grey edge the line is extrapolated.
      </figcaption>
    </figure>
  )
}
