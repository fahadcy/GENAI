/**
 * Small, dependency-free statistics. Everything the engines conclude is
 * derived here, so every number on screen can be recomputed by hand.
 */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/** Inverse standard normal CDF (Acklam's rational approximation, |ε| < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError(`normInv: p must be in (0,1), got ${p}`)
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  const hi = 1 - lo
  let q: number
  let r: number
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= hi) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}

/**
 * Beta-binomial shrinkage. With `successes` out of `trials` and a prior mean
 * `prior` worth `strength` pseudo-trials, returns the posterior mean and the
 * variance of the posterior Beta.
 */
export function shrink(successes: number, trials: number, prior: number, strength: number) {
  const a = successes + prior * strength
  const b = trials - successes + (1 - prior) * strength
  const mean = a / (a + b)
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1))
  return { mean, variance }
}

/** Jensen–Shannon divergence in bits (0 = identical, 1 = disjoint). */
export function jsDivergence(p: number[], q: number[]): number {
  const ps = normalise(p)
  const qs = normalise(q)
  const m = ps.map((v, i) => (v + qs[i]!) / 2)
  return 0.5 * kl(ps, m) + 0.5 * kl(qs, m)
}

function kl(p: number[], q: number[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const pi = p[i]!
    const qi = q[i]!
    if (pi > 0 && qi > 0) s += pi * Math.log2(pi / qi)
  }
  return s
}

export function normalise(v: number[]): number[] {
  const t = v.reduce((a, b) => a + b, 0)
  return t > 0 ? v.map((x) => x / t) : v.map(() => 0)
}

export function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
}

export function variance(v: number[]): number {
  if (v.length < 2) return 0
  const m = mean(v)
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)
}

/**
 * Days per arm to detect a change in a daily count from `lambdaOn` to
 * `lambdaOff`, two-sided, with over-dispersion `phi` (variance / mean of the
 * daily series; 1 = Poisson).
 */
export function daysPerArm(lambdaOn: number, lambdaOff: number, phi = 1, alpha = 0.05, power = 0.8): number {
  const delta = Math.abs(lambdaOn - lambdaOff)
  if (delta === 0) return Infinity
  const z = normInv(1 - alpha / 2) + normInv(power)
  return Math.ceil((z * z * phi * (lambdaOn + lambdaOff)) / (delta * delta))
}

// ───────────────────────────── Deterministic randomness (simulator + tests)

export type Rng = () => number

/** mulberry32 — tiny, fast, and identical in Node and the browser. */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussian(r: Rng): number {
  let u = 0
  while (u === 0) u = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

export function binomial(n: number, p: number, r: Rng): number {
  if (n <= 0 || p <= 0) return 0
  if (p >= 1) return n
  if (n < 60) {
    let k = 0
    for (let i = 0; i < n; i++) if (r() < p) k++
    return k
  }
  const m = n * p
  const sd = Math.sqrt(m * (1 - p))
  if (m < 12) return poisson(m, r)
  return Math.max(0, Math.min(n, Math.round(m + sd * gaussian(r))))
}

export function poisson(lambda: number, r: Rng): number {
  if (lambda <= 0) return 0
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(r)))
  const L = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= r()
  } while (p > L)
  return k - 1
}

// ───────────────────────────── Beta distribution (value of information)

/** ln Γ(x), Lanczos approximation (g = 7), accurate to ~1e-13 for x > 0. */
export function lgamma(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let s = c[0]!
  for (let i = 1; i < g + 2; i++) s += c[i]! / (x + i)
  const t = x + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s)
}

export function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) + lgamma(a + b) - lgamma(a) - lgamma(b))
}

/** E[f(R)] for R ~ Beta(a, b), midpoint rule over `steps` cells. */
export function betaExpect(f: (r: number) => number, a: number, b: number, steps = 400): number {
  let s = 0
  let w = 0
  for (let i = 0; i < steps; i++) {
    const x = (i + 0.5) / steps
    const p = betaPdf(x, a, b)
    s += f(x) * p
    w += p
  }
  return w > 0 ? s / w : 0
}

// ───────────────────────────── Linear algebra (small, dense)

/** Solve A x = b by Gauss–Jordan with partial pivoting; also returns A⁻¹. */
export function solve(A: number[][], b: number[]): { x: number[]; inv: number[][] } {
  const n = A.length
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]!])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r
    ;[M[c], M[piv]] = [M[piv]!, M[c]!]
    const d = M[c]![c]!
    if (Math.abs(d) < 1e-12) throw new Error('solve: singular matrix')
    for (let k = 0; k < M[c]!.length; k++) M[c]![k]! /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r]![c]!
      if (f === 0) continue
      for (let k = 0; k < M[r]!.length; k++) M[r]![k]! -= f * M[c]![k]!
    }
  }
  return { x: M.map((row) => row[2 * n]!), inv: M.map((row) => row.slice(n, 2 * n)) }
}
