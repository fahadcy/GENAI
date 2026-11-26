import type { Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import type { QueryVerdict } from './overlap'
import { daysPerArm, mean, normCdf, normInv, variance } from '../stats'
import { formatMoney, microsToMoney, pct, queryKey, round, stableId } from '../normalise'

/**
 * Pause experiments.
 *
 * A switchback design: the harvest searches are blocked with exact-match
 * negatives on "off" days and served on "on" days. Two weeks is the atom —
 * week two mirrors week one — so every weekday is observed in both arms and
 * the Monday/Saturday difference cannot masquerade as an effect.
 *
 * Recapture is read as a ratio to search volume, with Search Console
 * impressions as the volume meter (an ad pause does not change how often
 * people search):
 *
 *     r̂ = (organic CTR on off-days − organic CTR on on-days) / paid clicks per impression on on-days
 *
 * Normalising by impressions removes day-to-day demand swings — the largest
 * noise source in raw click counts — so a test resolves in weeks rather than
 * months, and the weekly cycle cancels by construction.
 */

export type Arm = 'on' | 'off'

const WEEK_A: Arm[] = ['on', 'off', 'on', 'off', 'on', 'off', 'on']
const WEEK_B: Arm[] = WEEK_A.map((a) => (a === 'on' ? 'off' : 'on'))

export function switchbackSchedule(days: number): Arm[] {
  const out: Arm[] = []
  for (let i = 0; out.length < days; i++) out.push(...(i % 2 === 0 ? WEEK_A : WEEK_B))
  return out.slice(0, days)
}

export interface PauseTestDesign {
  id: string
  queries: { key: string; display: string; campaignIds: string[] }[]
  /** Harvest candidates left out of this cell because they add more noise than signal. */
  deferred: { key: string; display: string; reason: string }[]
  daily: { paidClicks: number; organicClicks: number; organicImpressions: number; overdispersion: number }
  recapturePrior: number
  breakEvenRecapture: number
  /** Standard error of the recapture estimate the design will achieve. */
  expectedSe: number
  daysPerArm: number
  totalDays: number
  testable: boolean
  schedule: Arm[]
  /** Worst case: every paused click is lost and none comes back organically. */
  worstCaseCost: number
  valueOfTest: number
  monthlyCost: number
  monthlyValue: number
}

/** Smallest recapture difference worth resolving; below it the decision barely matters. */
export const DECISION_MARGIN = 0.25
/** Act when the evidence is 90% one way; otherwise keep testing. */
export const DECISION_CONFIDENCE = 0.9
const POWER = 0.8
const MIN_TEST_DAYS = 28

export function designPauseTest(
  input: SerpTwinInput,
  harvest: QueryVerdict[],
  settings: SerpTwinSettings,
): PauseTestDesign | null {
  if (harvest.length === 0) return null

  // Per-query click totals, to choose the cell.
  const clicks = new Map<string, { paid: number; org: number }>()
  for (const h of harvest) clicks.set(h.key, { paid: 0, org: 0 })
  for (const r of input.searchTerms) {
    const c = clicks.get(queryKey(r.searchTerm))
    if (c) c.paid += r.clicks
  }
  for (const r of input.organic) {
    const c = clicks.get(queryKey(r.query))
    if (c) c.org += r.clicks
  }

  // Noise-aware cell selection. Recapture is read off total clicks, so every organic click
  // in the cell is noise the test must see through. A query with 5 paid clicks beside 70
  // organic ones makes the estimate worse, not better. Greedily add queries while the
  // signal-to-noise ratio Σpaid / √Σ(paid+organic) keeps rising.
  const snr = (keys: string[]) => {
    const p = keys.reduce((s, k) => s + clicks.get(k)!.paid, 0)
    const t = keys.reduce((s, k) => s + clicks.get(k)!.paid + clicks.get(k)!.org, 0)
    return t > 0 ? p / Math.sqrt(t) : 0
  }
  const ordered = [...harvest].sort((a, b) => snr([b.key]) - snr([a.key]))
  const cell: QueryVerdict[] = []
  const deferred: PauseTestDesign['deferred'] = []
  for (const h of ordered) {
    const next = [...cell, h]
    if (cell.length === 0 || snr(next.map((x) => x.key)) > snr(cell.map((x) => x.key))) cell.push(h)
    else {
      const c = clicks.get(h.key)!
      deferred.push({
        key: h.key,
        display: h.display,
        reason: `${c.paid} paid beside ${c.org} organic clicks — adds more noise than signal; queue for a second cell`,
      })
    }
  }
  const keys = new Set(cell.map((h) => h.key))

  const perDay = new Map<string, { paid: number; org: number; imp: number; cost: number; value: number }>()
  const campaigns = new Map<string, Set<string>>()
  for (const r of input.searchTerms) {
    const k = queryKey(r.searchTerm)
    if (!keys.has(k)) continue
    const d = perDay.get(r.date) ?? { paid: 0, org: 0, imp: 0, cost: 0, value: 0 }
    d.paid += r.clicks
    d.cost += microsToMoney(r.costMicros)
    d.value += r.conversionValue > 0 ? r.conversionValue : r.conversions * settings.fallbackValuePerConversion
    perDay.set(r.date, d)
    campaigns.set(k, (campaigns.get(k) ?? new Set()).add(r.campaignId))
  }
  for (const r of input.organic) {
    if (!keys.has(queryKey(r.query))) continue
    const d = perDay.get(r.date) ?? { paid: 0, org: 0, imp: 0, cost: 0, value: 0 }
    d.org += r.clicks
    d.imp += r.impressions
    perDay.set(r.date, d)
  }

  const datesSorted = [...perDay.keys()].sort()
  const series = datesSorted.map((d) => perDay.get(d)!)
  const paidMean = mean(series.map((d) => d.paid))
  const orgMean = mean(series.map((d) => d.org))
  const impMean = mean(series.map((d) => d.imp))
  // Over-dispersion of organic clicks once search volume is accounted for, stratified by
  // query so a day with more login searches (high CTR) is not mistaken for noise.
  const qDay = new Map<string, Map<string, { org: number; imp: number }>>()
  for (const r of input.organic) {
    const k = queryKey(r.query)
    if (!keys.has(k)) continue
    const m = qDay.get(k) ?? new Map()
    const d = m.get(r.date) ?? { org: 0, imp: 0 }
    d.org += r.clicks
    d.imp += r.impressions
    m.set(r.date, d)
    qDay.set(k, m)
  }
  const expected = new Map<string, number>()
  for (const m of qDay.values()) {
    const tot = [...m.values()].reduce((a, d) => ({ org: a.org + d.org, imp: a.imp + d.imp }), {
      org: 0,
      imp: 0,
    })
    const c = tot.imp > 0 ? tot.org / tot.imp : 0
    for (const [date, d] of m) expected.set(date, (expected.get(date) ?? 0) + d.imp * c)
  }
  const resid = datesSorted.map((d) => perDay.get(d)!.org - (expected.get(d) ?? 0))
  const phi = Math.max(1, orgMean > 0 ? variance(resid) / orgMean : 1)

  const w = cell.reduce((s, h) => s + h.monthlyCost, 0) || 1
  const rPrior = cell.reduce((s, h) => s + h.recapturePrior * h.monthlyCost, 0) / w
  const mCost = cell.reduce((s, h) => s + h.monthlyCost, 0)
  const mValue = cell.reduce((s, h) => s + h.monthlyValue, 0)
  const breakEven = mValue > 0 ? 1 - mCost / mValue : 0

  // Sized for the decision rule the readout uses: if the truth sits DECISION_MARGIN above
  // (or below) break-even, the readout reaches DECISION_CONFIDENCE with probability POWER.
  // One day per arm gives s.e.(r̂) ≈ √(2φ·organic + paid) / paid.
  const margin = Math.max(Math.abs(rPrior - breakEven), DECISION_MARGIN)
  const sd1 = paidMean > 0 ? Math.sqrt(2 * phi * orgMean + paidMean) / paidMean : Infinity
  const n = Number.isFinite(sd1)
    ? Math.ceil((((normInv(DECISION_CONFIDENCE) + normInv(POWER)) * sd1) / margin) ** 2)
    : Infinity
  const totalDays = Number.isFinite(n) ? Math.max(MIN_TEST_DAYS, Math.ceil((2 * n) / 14) * 14) : Infinity
  const testable = totalDays <= settings.maxExperimentDays
  const perArm = Number.isFinite(totalDays) ? totalDays / 2 : Infinity
  const expectedSe = sd1 / Math.sqrt(perArm)

  const dailyCost = mean(series.map((d) => d.cost))
  const dailyValue = mean(series.map((d) => d.value))

  return {
    id: `pt-${stableId(...[...keys].sort())}`,
    queries: cell.map((h) => ({
      key: h.key,
      display: h.display,
      campaignIds: [...(campaigns.get(h.key) ?? [])],
    })),
    deferred,
    daily: { paidClicks: paidMean, organicClicks: orgMean, organicImpressions: impMean, overdispersion: phi },
    recapturePrior: rPrior,
    breakEvenRecapture: breakEven,
    expectedSe,
    daysPerArm: n,
    totalDays,
    testable,
    schedule: testable ? switchbackSchedule(totalDays) : [],
    worstCaseCost: Math.max(0, (Number.isFinite(perArm) ? perArm : 0) * (dailyValue - dailyCost)),
    valueOfTest: cell.reduce((s, h) => s + h.valueOfTest, 0),
    monthlyCost: mCost,
    monthlyValue: mValue,
  }
}

export function pauseTestRecommendation(d: PauseTestDesign, settings: SerpTwinSettings): Recommendation {
  const money = (n: number) => formatMoney(n, settings.currency)
  const negatives = d.queries.map((q) => ({ text: q.key, matchType: 'EXACT', campaignIds: q.campaignIds }))
  return {
    id: `ov-${d.id}`,
    engine: 'overlap',
    title: d.testable
      ? `Run a ${d.totalDays}-day pause test on ${d.queries.length} searches you already win organically`
      : `${d.queries.length} harvest candidates — too little volume to test by switchback`,
    summary: d.testable
      ? `You spend ${money(d.monthlyCost)}/month on searches where you rank in the top three with no strong competitor. Pausing pays if at least ${pct(Math.max(0, d.breakEvenRecapture))} of those clicks come back through your organic listing. Google's published average says ${pct(d.recapturePrior)}; this account's real number is unknown, and this test measures it. Expected value of running it: ${money(d.valueOfTest)}/month.`
      : `A switchback test would need ${Number.isFinite(d.totalDays) ? d.totalDays : 'unbounded'} days to separate the effect from daily noise, beyond the ${settings.maxExperimentDays}-day limit. Group with more searches, or run a geo split instead.`,
    monthlyImpact: d.testable ? d.valueOfTest : 0,
    confidence: d.testable ? 'estimated' : 'hypothesis',
    evidence: [
      { label: 'Searches in the cell', value: String(d.queries.length) },
      {
        label: 'Daily paid / organic clicks',
        value: `${d.daily.paidClicks.toFixed(1)} / ${d.daily.organicClicks.toFixed(1)}`,
      },
      { label: 'Over-dispersion (φ)', value: d.daily.overdispersion.toFixed(2) },
      { label: 'Break-even recapture', value: pct(Math.max(0, d.breakEvenRecapture)) },
      { label: 'Prior recapture (Chan et al. 2012)', value: pct(d.recapturePrior) },
      {
        label: 'Days per arm (90% decision, power 0.8)',
        value: Number.isFinite(d.daysPerArm) ? String(d.daysPerArm) : '∞',
      },
      {
        label: 'Expected precision (± 1 s.e.)',
        value: Number.isFinite(d.expectedSe) ? `±${pct(d.expectedSe)} recapture` : '—',
      },
      ...(d.deferred.length
        ? [{ label: 'Held for a second cell', value: d.deferred.map((x) => `“${x.display}”`).join(', ') }]
        : []),
      { label: 'Worst-case cost of the test', value: money(d.worstCaseCost) },
    ],
    actions: d.testable
      ? [
          {
            kind: 'start_pause_experiment',
            description: `Apply exact-match negatives on “off” days for ${d.totalDays} days (switchback), then read out`,
            payload: {
              experimentId: d.id,
              schedule: d.schedule,
              negatives,
              breakEvenRecapture: round(d.breakEvenRecapture, 4),
            },
            undo: { kind: 'remove_negative_keywords', negatives },
            requiresApproval: true,
          },
        ]
      : [],
    assumptions: [
      'Recapture prior from Chan, Yuan, Koehler & Kumar (Google, 2012), adjusted for competitor overlap. It prices the test only; no pause is recommended on the prior alone.',
      'Value of the test = E[max(0, cost − value × (1 − R))] with R ~ Beta(prior, concentration 6).',
      'Outcome metric is total clicks; conversions are read as a secondary check at readout.',
      `Sized to resolve a ${pct(DECISION_MARGIN)} recapture difference; the readout acts only at ${pct(DECISION_CONFIDENCE)} confidence either way.`,
    ],
  }
}

// ───────────────────────────── Readout

export interface PauseTestDay {
  date: string
  arm: Arm
  paidClicks: number
  organicClicks: number
  /** Search Console impressions for the cell's searches — the demand meter. */
  organicImpressions: number
}

export type PauseDecision = 'pause' | 'resume' | 'extend'

export interface PauseTestReadout {
  daysOn: number
  daysOff: number
  organicCtrOn: number
  organicCtrOff: number
  paidPerImpressionOn: number
  recapture: number
  se: number
  ci95: [number, number]
  breakEvenRecapture: number
  /** P(true recapture > break-even), normal approximation. */
  pAboveBreakEven: number
  decision: PauseDecision
  explanation: string
}

export function readPauseTest(days: PauseTestDay[], breakEvenRecapture: number): PauseTestReadout {
  const on = days.filter((d) => d.arm === 'on')
  const off = days.filter((d) => d.arm === 'off')
  const sum = (xs: PauseTestDay[], f: (d: PauseTestDay) => number) => xs.reduce((s, d) => s + f(d), 0)
  const impOn = sum(on, (d) => d.organicImpressions)
  const impOff = sum(off, (d) => d.organicImpressions)
  const orgOn = sum(on, (d) => d.organicClicks)
  const orgOff = sum(off, (d) => d.organicClicks)
  const paidOn = sum(on, (d) => d.paidClicks)

  const ctrOn = impOn > 0 ? orgOn / impOn : 0
  const ctrOff = impOff > 0 ? orgOff / impOff : 0
  const q = impOn > 0 ? paidOn / impOn : 0
  const r = q > 0 ? (ctrOff - ctrOn) / q : 0

  // Over-dispersion from on-day residuals, then the delta method for the ratio.
  const resid = on.map((d) => d.organicClicks - d.organicImpressions * ctrOn)
  const phi = Math.max(1, orgOn > 0 ? variance(resid) / (orgOn / Math.max(1, on.length)) : 1)
  const vCtrOn = (phi * orgOn) / impOn ** 2
  const vCtrOff = (phi * orgOff) / impOff ** 2
  const vQ = paidOn / impOn ** 2
  const se = q > 0 ? Math.sqrt((vCtrOn + vCtrOff) / q ** 2 + (r * r * vQ) / q ** 2) : Infinity

  const z = normInv(0.975)
  const lo = r - z * se
  const hi = r + z * se
  const pAbove = normCdf((r - breakEvenRecapture) / se)

  let decision: PauseDecision
  let explanation: string
  if (pAbove >= DECISION_CONFIDENCE) {
    decision = 'pause'
    explanation = `Measured recapture ${pct(r)} (95% ${pct(lo)} to ${pct(hi)}), ${pct(pAbove)} likely above break-even (${pct(breakEvenRecapture)}). Organic brings the clicks back; the spend is not buying them.`
  } else if (pAbove <= 1 - DECISION_CONFIDENCE) {
    decision = 'resume'
    explanation = `Measured recapture ${pct(r)} (95% ${pct(lo)} to ${pct(hi)}), only ${pct(pAbove)} likely above break-even (${pct(breakEvenRecapture)}). The ads are genuinely incremental here; keep them.`
  } else {
    decision = 'extend'
    explanation = `Measured recapture ${pct(r)} (95% ${pct(lo)} to ${pct(hi)}) straddles break-even (${pct(breakEvenRecapture)}). Not enough evidence either way; extend by two weeks.`
  }

  return {
    daysOn: on.length,
    daysOff: off.length,
    organicCtrOn: ctrOn,
    organicCtrOff: ctrOff,
    paidPerImpressionOn: q,
    recapture: r,
    se,
    ci95: [lo, hi],
    breakEvenRecapture,
    pAboveBreakEven: pAbove,
    decision,
    explanation,
  }
}

/** Remove day-of-week means, keeping the grand mean. */
export function weekdayAdjust(dates: string[], values: number[]): number[] {
  const byDow = new Map<number, number[]>()
  dates.forEach((d, i) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay()
    byDow.set(w, [...(byDow.get(w) ?? []), values[i]!])
  })
  const grand = mean(values)
  return dates.map((d, i) => values[i]! - mean(byDow.get(new Date(`${d}T00:00:00Z`).getUTCDay())!) + grand)
}
