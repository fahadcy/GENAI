import type { OrganicRow } from './types'

/**
 * The site's own organic CTR curve, ctr(p) = a · p^(−b).
 *
 * Industry curves describe the average site; a brand with strong recall gets
 * far more at position 1 than a new entrant does. So the curve is fitted from
 * the workspace's own Search Console rows by impression-weighted least
 * squares in log space, and only falls back to the industry default when
 * there is not enough data to fit.
 */

export interface CtrCurve {
  a: number
  b: number
  fitted: boolean
  /** Buckets the fit used: rounded position → observed CTR and impressions. */
  points: { position: number; ctr: number; impressions: number }[]
}

export const DEFAULT_CURVE: CtrCurve = { a: 0.3, b: 1.1, fitted: false, points: [] }

const MIN_BUCKET_IMPRESSIONS = 300
const MIN_BUCKETS = 4

export function fitCtrCurve(rows: OrganicRow[]): CtrCurve {
  const buckets = new Map<number, { imp: number; clk: number }>()
  for (const r of rows) {
    if (r.position < 1 || r.position > 20) continue
    const p = Math.max(1, Math.round(r.position))
    const b = buckets.get(p) ?? { imp: 0, clk: 0 }
    b.imp += r.impressions
    b.clk += r.clicks
    buckets.set(p, b)
  }
  const points = [...buckets.entries()]
    .filter(([, b]) => b.imp >= MIN_BUCKET_IMPRESSIONS && b.clk > 0)
    .map(([position, b]) => ({ position, ctr: b.clk / b.imp, impressions: b.imp }))
    .sort((x, y) => x.position - y.position)

  if (points.length < MIN_BUCKETS) return { ...DEFAULT_CURVE, points }

  // Weighted least squares: ln ctr = ln a − b ln p, weights = impressions.
  let sw = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0
  for (const pt of points) {
    const w = pt.impressions
    const x = Math.log(pt.position)
    const y = Math.log(pt.ctr)
    sw += w
    sx += w * x
    sy += w * y
    sxx += w * x * x
    sxy += w * x * y
  }
  const denom = sw * sxx - sx * sx
  if (denom <= 0) return { ...DEFAULT_CURVE, points }
  const slope = (sw * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / sw
  const a = Math.min(0.9, Math.max(0.02, Math.exp(intercept)))
  const b = Math.min(3, Math.max(0.2, -slope))
  return { a, b, fitted: true, points }
}

export function ctrAt(curve: CtrCurve, position: number): number {
  return Math.min(0.95, curve.a * Math.max(1, position) ** -curve.b)
}
