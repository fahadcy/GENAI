/**
 * Money helpers for the budget module. Pence in, readable strings out.
 * Formatting by hand rather than Intl so server and browser output match
 * byte for byte (see formatCompact in components/domain.tsx for the reason).
 */

export function toPence(pounds: number | string): number {
  const n = typeof pounds === 'string' ? Number(pounds.replace(/[£,\s]/g, '')) : pounds
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

export function fromPence(pence: number): number {
  return Math.round(pence) / 100
}

const SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

/** £1,234 for whole pounds over £1,000; £12.34 below. */
export function money(pence: number, currency = 'GBP', opts: { exact?: boolean } = {}): string {
  const sign = pence < 0 ? '−' : ''
  const abs = Math.abs(Math.round(pence))
  const pounds = Math.floor(abs / 100)
  const p = abs % 100
  const sym = SYMBOL[currency] ?? `${currency} `
  const grouped = pounds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (!opts.exact && pounds >= 1000) return `${sign}${sym}${grouped}`
  return `${sign}${sym}${grouped}.${p.toString().padStart(2, '0')}`
}

/** Splits a total into parts proportional to weights, summing exactly to the total. */
export function splitExact(totalPence: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0)
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0)
  const raw = weights.map((w) => (Math.max(0, w) / sum) * totalPence)
  const floors = raw.map(Math.floor)
  let rest = totalPence - floors.reduce((a, b) => a + b, 0)
  // Largest remainder method: hand the leftover pence to the biggest fractions.
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (rest <= 0) break
    floors[i] += 1
    rest -= 1
  }
  return floors
}

export function pct(n: number, dp = 0): string {
  const f = 10 ** dp
  return `${Math.round(n * 100 * f) / f}%`
}

export function fmtNum(n: number, dp = 1): string {
  if (!Number.isFinite(n)) return '—'
  const f = 10 ** dp
  const v = Math.round(n * f) / f
  return Math.abs(v) >= 1000 ? Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : v.toString()
}
