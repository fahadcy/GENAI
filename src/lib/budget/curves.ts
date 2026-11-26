/**
 * Response curves: how much a channel returns at a given weekly spend.
 *
 * Fitted per channel from weekly history with geometric adstock and a Hill
 * saturation curve — the functional form Google Meridian and Meta Robyn both
 * use — but fitted directly rather than inside a full Bayesian MMM, so it runs
 * in milliseconds on the twenty to fifty weeks a small advertiser actually has.
 *
 * What it does that a naive "ROAS per channel" table does not:
 *
 *  - Diminishing returns. The next pound into a channel returns less than the
 *    average pound, and the allocator works on the next pound.
 *  - Carryover. Spend this week still works next week, so a week with low
 *    spend after a heavy one does not look like a miracle.
 *  - Honest uncertainty. A residual bootstrap refits the curve on many
 *    plausible versions of the same history; the spread of those curves is
 *    what the allocator optimises against.
 *  - Credibility weighting. With little history the fit is blended with a weak
 *    prior (a curve that says "returns flatten past about twice what you spend
 *    now"), in proportion to the evidence. Twelve weeks cannot produce a curve
 *    that promises a fortune at three times current spend.
 *
 * Pure, deterministic for a given seed, and unit-tested.
 */
import type { Curve, CurveFit, CurveParams, Observation } from './types'
import { seeded } from './random'

/* ------------------------------------------------------------ primitives */

export function adstock(spend: number[], theta: number): number[] {
  const out = new Array<number>(spend.length)
  let carry = 0
  for (let i = 0; i < spend.length; i++) {
    carry = spend[i] + theta * carry
    out[i] = carry
  }
  return out
}

export function hill(x: number, alpha: number, gamma: number): number {
  if (x <= 0) return 0
  if (gamma <= 0) return 1
  const xa = Math.pow(x, alpha)
  return xa / (xa + Math.pow(gamma, alpha))
}

/**
 * Steady-state weekly response to a constant weekly spend. Spending s every
 * week settles the adstock at s / (1 − theta), and the response follows.
 */
export function responseAt(params: CurveParams, weeklySpendPence: number): number {
  const ad = weeklySpendPence / (1 - Math.min(params.theta, 0.95))
  return params.beta * hill(ad, params.alpha, params.gamma)
}

export function curveAt(curve: Curve, weeklySpendPence: number): number {
  let total = 0
  for (const c of curve.components) total += c.weight * responseAt(c.params, weeklySpendPence)
  return total
}

/**
 * Weekly spend at which the curve reaches `share` of its ceiling, by bisection.
 * Used to say "this channel is 80% saturated at £X a week".
 */
export function spendForShare(curve: Curve, share: number, hiPence = 1e10): number {
  const ceiling = curveAt(curve, hiPence)
  if (ceiling <= 0) return 0
  let lo = 0
  let hi = hiPence
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (curveAt(curve, mid) / ceiling < share) lo = mid
    else hi = mid
  }
  return Math.round(hi)
}

/* ---------------------------------------------------------------- fitting */

const THETAS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
const ALPHAS = [0.7, 1, 1.3, 1.7, 2.2, 3]
const GAMMA_MULTIPLES = [0.4, 0.6, 0.8, 1, 1.3, 1.7, 2.2, 3, 4.5, 7]

type Grid = { thetas: number[]; alphas: number[]; gammas: number[] }

/** Least-squares beta for fixed shape; closed form because response is linear in beta. */
function fitBeta(h: number[], y: number[]): number {
  let hy = 0
  let hh = 0
  for (let i = 0; i < h.length; i++) {
    hy += h[i] * y[i]
    hh += h[i] * h[i]
  }
  return hh > 0 ? Math.max(0, hy / hh) : 0
}

function bestFit(
  spend: number[],
  y: number[],
  grid: Grid,
  burnIn: number,
): { params: CurveParams; sse: number } {
  let best: { params: CurveParams; sse: number; score: number } | null = null
  for (const theta of grid.thetas) {
    const ad = adstock(spend, theta)
    for (const alpha of grid.alphas) {
      for (const gamma of grid.gammas) {
        const h = ad.map((a) => hill(a, alpha, gamma))
        const hs = h.slice(burnIn)
        const ys = y.slice(burnIn)
        const beta = fitBeta(hs, ys)
        let sse = 0
        for (let i = 0; i < hs.length; i++) {
          const e = ys[i] - beta * hs[i]
          sse += e * e
        }
        /*
         * A light preference for unremarkable shapes. With noisy data many
         * curves fit almost equally well, and the extreme ones (a half-
         * saturation point at seven times current spend, an alpha of three)
         * are the ones that produce reckless recommendations. One per cent of
         * SSE per unit of distance is enough to break ties, not to override
         * the data.
         */
        const midGamma = grid.gammas[Math.floor(grid.gammas.length / 2)]
        const penalty = 1 + 0.01 * (Math.abs(Math.log(gamma / midGamma)) + Math.abs(alpha - 1.3) + theta)
        const score = sse * penalty
        if (!best || score < best.score) best = { params: { beta, alpha, gamma, theta }, sse, score }
      }
    }
  }
  return { params: best!.params, sse: best!.sse }
}

/**
 * The prior: a concave curve anchored so that at the channel's typical weekly
 * spend it returns what the channel has returned on average, and flattens out
 * past roughly twice that. It is deliberately weak — it says "returns
 * diminish", not "returns diminish at exactly this rate".
 */
export function priorCurve(meanWeeklyPence: number, meanWeeklyOutcome: number): CurveParams {
  const gamma = Math.max(1, meanWeeklyPence * 2)
  const alpha = 1
  const h = hill(meanWeeklyPence, alpha, gamma)
  const beta = h > 0 ? meanWeeklyOutcome / h : 0
  return { beta, alpha, gamma, theta: 0 }
}

/** Evidence weight: n / (n + k). With k = 10, twenty weeks earns two thirds. */
export function credibilityFor(weeks: number, r2: number, k = 10): number {
  if (weeks < 6) return 0
  const base = weeks / (weeks + k)
  // A fit that explains almost nothing should not be trusted just for being long.
  return Math.max(0, Math.min(1, base * Math.min(1, 0.4 + r2)))
}

export type FitOptions = {
  metric: 'conversions' | 'revenue'
  /** Bootstrap draws. 0 gives the point estimate only. */
  draws?: number
  seed?: string
}

/**
 * Fit a channel's curve from weekly observations, oldest first.
 */
export function fitCurve(channelKey: string, history: Observation[], options: FitOptions): CurveFit {
  const metric = options.metric
  const obs = [...history].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  const spend = obs.map((o) => Math.max(0, o.spendPence))
  const y = obs.map((o) => Math.max(0, metric === 'revenue' ? o.revenuePence : o.conversions))
  const weeks = obs.length
  const notes: string[] = []

  const spendWeeks = spend.filter((s) => s > 0)
  const meanSpend = spendWeeks.length ? spendWeeks.reduce((a, b) => a + b, 0) / spendWeeks.length : 0
  const meanY = weeks ? y.reduce((a, b) => a + b, 0) / weeks : 0
  const maxSpend = spend.length ? Math.max(...spend) : 0

  const empty = (quality: CurveFit['quality'], note: string): CurveFit => {
    const prior = priorCurve(meanSpend, meanY)
    const curve: Curve = { components: [{ params: prior, weight: 1 }] }
    return {
      channelKey,
      metric,
      curve,
      draws: widenPrior(prior, options.draws ?? 0, options.seed ?? channelKey),
      weeks,
      r2: 0,
      credibility: 0,
      maxObservedWeeklyPence: maxSpend,
      meanWeeklyPence: Math.round(meanSpend),
      saturationWeeklyPence: spendForShare(curve, 0.8),
      quality,
      notes: [...notes, note],
    }
  }

  if (meanSpend <= 0) {
    return { ...empty('none', 'No spend recorded, so there is nothing to learn a curve from.'), draws: [] }
  }
  if (meanY <= 0) {
    return { ...empty('none', 'Spend but no recorded outcomes. Connect conversion tracking for this channel.'), draws: [] }
  }
  if (weeks < 6) {
    return empty('thin', `Only ${weeks} week${weeks === 1 ? '' : 's'} of history. The curve is the prior: returns are assumed to flatten past about twice current spend.`)
  }

  const cv = stdev(spendWeeks) / meanSpend
  if (cv < 0.08) {
    notes.push(
      'Spend has barely changed week to week, so the data cannot show where returns flatten. Vary the budget for a few weeks, or run a test, to learn the curve.',
    )
  }

  // Burn-in: the first weeks' adstock lacks the carryover from before the data starts.
  const burnIn = Math.min(2, Math.floor(weeks / 8))
  const grid: Grid = {
    thetas: THETAS,
    alphas: ALPHAS,
    gammas: GAMMA_MULTIPLES.map((m) => m * meanSpend),
  }
  const point = bestFit(spend, y, grid, burnIn)

  const ys = y.slice(burnIn)
  const meanYs = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length)
  const sst = ys.reduce((a, b) => a + (b - meanYs) * (b - meanYs), 0)
  const r2 = sst > 0 ? Math.max(0, 1 - point.sse / sst) : 0
  const credibility = credibilityFor(weeks, r2)
  const prior = priorCurve(meanSpend, meanY)

  const blend = (p: CurveParams): Curve => ({
    components:
      credibility >= 0.999
        ? [{ params: p, weight: 1 }]
        : [
            { params: p, weight: credibility },
            { params: prior, weight: 1 - credibility },
          ].filter((c) => c.weight > 0),
  })

  const curve = blend(point.params)

  // Residual bootstrap: perturb the outcomes with the fit's own residuals and refit.
  const nDraws = options.draws ?? 0
  const draws: Curve[] = []
  if (nDraws > 0) {
    const rand = seeded(options.seed ?? `curve:${channelKey}:${weeks}`)
    const ad = adstock(spend, point.params.theta)
    const fitted = ad.map((a) => point.params.beta * hill(a, point.params.alpha, point.params.gamma))
    const residuals = y.map((v, i) => v - fitted[i]).slice(burnIn)
    // A coarser grid for the refits: the draws need spread, not precision.
    const coarse: Grid = {
      thetas: [0, 0.2, 0.4, 0.6],
      alphas: [0.7, 1, 1.5, 2.2],
      gammas: [0.5, 0.8, 1.2, 1.8, 2.8, 4.5].map((m) => m * meanSpend),
    }
    for (let d = 0; d < nDraws; d++) {
      const yStar = fitted.map((f, i) =>
        i < burnIn ? y[i] : Math.max(0, f + residuals[Math.floor(rand() * residuals.length)]),
      )
      const refit = bestFit(spend, yStar, coarse, burnIn)
      draws.push(blend(refit.params))
    }
  }

  const quality: CurveFit['quality'] =
    weeks >= 26 && r2 >= 0.5 && cv >= 0.08 ? 'good' : weeks >= 12 && r2 >= 0.25 ? 'usable' : 'thin'
  if (quality === 'thin') notes.push('Treat this curve as a rough guide: the history is short or noisy.')

  return {
    channelKey,
    metric,
    curve,
    draws,
    weeks,
    r2: round(r2, 3),
    credibility: round(credibility, 3),
    maxObservedWeeklyPence: maxSpend,
    meanWeeklyPence: Math.round(meanSpend),
    saturationWeeklyPence: spendForShare(curve, 0.8),
    quality,
    notes,
  }
}

/**
 * With no fit, the draws still need spread: scale the prior's ceiling and
 * half-saturation point up and down so the allocator knows how little it knows.
 */
function widenPrior(prior: CurveParams, n: number, seed: string): Curve[] {
  const rand = seeded(`prior:${seed}`)
  const out: Curve[] = []
  for (let i = 0; i < n; i++) {
    const g = prior.gamma * Math.exp((rand() - 0.5) * 1.4)
    const scale = Math.exp((rand() - 0.5) * 0.8)
    // Keep the average return at current spend roughly where it was.
    const p = { ...prior, gamma: g }
    const anchor = hill(prior.gamma / 2, 1, prior.gamma) / Math.max(1e-9, hill(prior.gamma / 2, 1, g))
    out.push({ components: [{ params: { ...p, beta: prior.beta * anchor * scale }, weight: 1 }] })
  }
  return out
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1))
}

function round(n: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Points for drawing a curve: weekly spend → outcome, with the bootstrap band. */
export function curveSeries(
  fit: CurveFit,
  maxWeeklyPence: number,
  points = 24,
): { spendPence: number; mean: number; p10: number; p90: number }[] {
  const out: { spendPence: number; mean: number; p10: number; p90: number }[] = []
  for (let i = 0; i <= points; i++) {
    const s = (maxWeeklyPence * i) / points
    const point = curveAt(fit.curve, s)
    const ds = fit.draws.map((d) => curveAt(d, s)).sort((a, b) => a - b)
    out.push({
      spendPence: Math.round(s),
      mean: point,
      p10: ds.length ? quantile(ds, 0.1) : point,
      p90: ds.length ? quantile(ds, 0.9) : point,
    })
  }
  return out
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
