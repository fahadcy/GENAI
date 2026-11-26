/**
 * Pacing and the cash forecast.
 *
 * Pacing answers "will each line land on plan?" from platform-reported spend
 * (accrual). The cash forecast answers a question no allocator the research
 * found asks: "when will the card actually be charged, and will it run out of
 * limit before the period ends?" — from threshold billing, run rates and what
 * has already been charged.
 *
 * Both respect the platforms' own overdelivery rules, so the worst case shown
 * is what the platform may legitimately spend, not a scare number.
 *
 * Pure: dates are ISO strings, money is pence.
 */
import { channelDef, type OverdeliveryRule } from './channels'
import { money, pct } from './money'
import type { PacingLine, PacingStatus } from './types'

/* ------------------------------------------------------------------ dates */

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)
}

/** Inclusive list of days. */
export function dayRange(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d)
  return out
}

export function dow(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

/** Monday of the ISO week containing `iso`. */
export function weekStart(iso: string): string {
  const w = dow(iso)
  return addDays(iso, w === 0 ? -6 : 1 - w)
}

/**
 * Day-of-week weights from history: how spend usually falls across the week.
 * Defaults to flat when there is too little history to say.
 */
export function dowWeights(daily: { day: string; spendPence: number }[]): number[] {
  const sums = new Array<number>(7).fill(0)
  const counts = new Array<number>(7).fill(0)
  for (const d of daily) {
    sums[dow(d.day)] += d.spendPence
    counts[dow(d.day)] += 1
  }
  if (counts.some((c) => c < 2)) return new Array(7).fill(1)
  const avg = sums.map((s, i) => s / counts[i])
  const mean = avg.reduce((a, b) => a + b, 0) / 7
  if (mean <= 0) return new Array(7).fill(1)
  return avg.map((a) => Math.max(0.05, a / mean))
}

/* ---------------------------------------------------------------- pacing */

export type PacingInput = {
  lineId: string
  label: string
  channelKey: string | null
  plannedPence: number
  periodStart: string
  periodEnd: string
  today: string
  /** Platform-reported (accrual) spend by day; missing days are zero. */
  daily: { day: string; spendPence: number }[]
  /** Longer history for the weekday shape, optional. */
  history?: { day: string; spendPence: number }[]
  /** Sum of daily budgets currently set on the platform, if known. */
  dailyBudgetPence?: number | null
}

export function paceLine(input: PacingInput): PacingLine {
  const { periodStart, periodEnd, today } = input
  // Today is never both elapsed and remaining: it counts as remaining until it is over.
  const lastActual = today <= periodEnd ? addDays(today, -1) : periodEnd
  const elapsed = today <= periodStart ? [] : dayRange(periodStart, lastActual < periodStart ? periodStart : lastActual)
  const remaining = today > periodEnd ? [] : dayRange(today < periodStart ? periodStart : today, periodEnd)
  const all = dayRange(periodStart, periodEnd)

  const byDay = new Map(input.daily.map((d) => [d.day, d.spendPence]))
  const actual = elapsed.reduce((a, d) => a + (byDay.get(d) ?? 0), 0)
  const w = dowWeights(input.history ?? input.daily)
  const weightOf = (days: string[]) => days.reduce((a, d) => a + w[dow(d)], 0)
  const totalWeight = weightOf(all)
  const expected = totalWeight > 0 ? Math.round((input.plannedPence * weightOf(elapsed)) / totalWeight) : 0

  // Run rate: the last seven elapsed days, weekday-adjusted, so a quiet weekend is not read as a slowdown.
  const recent = elapsed.slice(-7)
  const recentSpend = recent.reduce((a, d) => a + (byDay.get(d) ?? 0), 0)
  const recentWeight = weightOf(recent)
  const ratePerWeight = recentWeight > 0 ? recentSpend / recentWeight : 0
  const projected = Math.round(actual + ratePerWeight * weightOf(remaining))

  const rule = input.channelKey ? channelDef(input.channelKey)?.overdelivery : undefined
  const worstCase =
    input.dailyBudgetPence && input.dailyBudgetPence > 0
      ? Math.round(actual + maxRemainingSpend(rule, input.dailyBudgetPence, remaining, elapsed, byDay))
      : null

  const variance = input.plannedPence > 0 ? projected / input.plannedPence - 1 : 0
  const remainingWeight = weightOf(remaining)
  const suggestedDaily =
    remaining.length > 0 && input.plannedPence > 0
      ? Math.max(0, Math.round(((input.plannedPence - actual) / Math.max(1e-9, remainingWeight)) * (remainingWeight / remaining.length)))
      : null

  let status: PacingStatus
  let note: string
  if (input.plannedPence <= 0 && actual === 0) {
    status = 'no_data'
    note = 'Nothing planned and nothing spent.'
  } else if (elapsed.length === 0) {
    status = 'no_data'
    note = 'The period has not started.'
  } else if (actual === 0 && recentSpend === 0) {
    status = input.plannedPence > 0 ? 'under' : 'no_data'
    note = input.plannedPence > 0 ? 'Planned, but nothing has been spent yet.' : 'No spend.'
  } else if (variance > 0.05) {
    status = 'over'
    note = `On course to finish ${pct(variance)} over plan (${money(projected - input.plannedPence)}). Bring the daily rate to ${money(suggestedDaily ?? 0)} to land on plan.`
  } else if (variance < -0.1) {
    status = 'under'
    note = `On course to finish ${pct(-variance)} under plan (${money(input.plannedPence - projected)} unspent). ${suggestedDaily ? `Raise the daily rate to ${money(suggestedDaily)} to use it, or release it to another line.` : ''}`.trim()
  } else if (worstCase !== null && worstCase > input.plannedPence * 1.05) {
    status = 'at_risk'
    note = `On track, but the platform may legitimately spend up to ${money(worstCase)} at current daily budgets (${rule ? rule.source.split(':')[0] : 'overdelivery'}).`
  } else {
    status = 'on_track'
    note = `Landing within ${pct(Math.abs(variance))} of plan.`
  }

  return {
    lineId: input.lineId,
    label: input.label,
    plannedPence: input.plannedPence,
    actualPence: actual,
    expectedToDatePence: expected,
    projectedPence: projected,
    worstCasePence: worstCase,
    variancePct: Math.round(variance * 1000) / 1000,
    status,
    suggestedDailyPence: suggestedDaily,
    note,
  }
}

/**
 * The most a platform may legitimately spend over the remaining days at the
 * current daily budget, under its overdelivery rules. Google: 2× on a day,
 * 30.4× over the month. Meta: +75% on a day, 7× over the calendar week. With
 * no known rule, the daily budget is taken at face value.
 */
export function maxRemainingSpend(
  rule: OverdeliveryRule | undefined,
  dailyBudget: number,
  remaining: string[],
  elapsed: string[],
  byDay: Map<string, number>,
): number {
  if (!rule) return dailyBudget * remaining.length
  let total = 0
  // Track spend already used inside each calendar month and week.
  const monthUsed = new Map<string, number>()
  const weekUsed = new Map<string, number>()
  for (const d of elapsed) {
    const s = byDay.get(d) ?? 0
    monthUsed.set(d.slice(0, 7), (monthUsed.get(d.slice(0, 7)) ?? 0) + s)
    weekUsed.set(weekStart(d), (weekUsed.get(weekStart(d)) ?? 0) + s)
  }
  for (const d of remaining) {
    let cap = dailyBudget * rule.dailyMultiple
    if (rule.monthlyMultipleOfDaily) {
      const m = d.slice(0, 7)
      cap = Math.min(cap, Math.max(0, dailyBudget * rule.monthlyMultipleOfDaily - (monthUsed.get(m) ?? 0)))
    }
    if (rule.weeklyMultipleOfDaily) {
      const wk = weekStart(d)
      cap = Math.min(cap, Math.max(0, dailyBudget * rule.weeklyMultipleOfDaily - (weekUsed.get(wk) ?? 0)))
    }
    total += cap
    monthUsed.set(d.slice(0, 7), (monthUsed.get(d.slice(0, 7)) ?? 0) + cap)
    weekUsed.set(weekStart(d), (weekUsed.get(weekStart(d)) ?? 0) + cap)
  }
  return total
}

/* ----------------------------------------------------------- cash forecast */

export type CashPlatformInput = {
  platform: string
  label: string
  /** Platform spend incurred but not yet charged, pence. */
  unbilledPence: number
  /** Expected daily spend from here. */
  dailyRatePence: number
  thresholdPence: number | null
  /** Days between charges when the threshold is not reached (Google: 30). */
  maxDaysBetweenCharges: number
  /** Card cost per £1 of platform spend (VAT, FX, fees). */
  cashFactor: number
}

export type CashForecast = {
  charges: { day: string; platform: string; label: string; amountPence: number }[]
  forecastPence: number
  alreadyChargedPence: number
  limitPence: number | null
  headroomPence: number | null
  /** First day the card limit would be exceeded, or null. */
  limitHitOn: string | null
  byPlatform: { platform: string; label: string; amountPence: number; count: number }[]
  note: string
}

/**
 * Simulates threshold billing day by day: unbilled spend accrues; when it
 * reaches the threshold a charge of that size lands (several in a day for a
 * busy account); at the cycle limit whatever is unbilled is charged.
 */
export function forecastCash(args: {
  today: string
  periodEnd: string
  platforms: CashPlatformInput[]
  alreadyChargedPence: number
  limitPence: number | null
  /** Days since each platform's last charge, for the 30-day rule. */
  daysSinceLastCharge?: Record<string, number>
}): CashForecast {
  const days = args.today > args.periodEnd ? [] : dayRange(args.today, args.periodEnd)
  const charges: CashForecast['charges'] = []
  const state = args.platforms.map((p) => ({
    p,
    unbilled: p.unbilledPence,
    since: args.daysSinceLastCharge?.[p.platform] ?? 0,
  }))
  for (const d of days) {
    for (const s of state) {
      s.unbilled += s.p.dailyRatePence
      s.since += 1
      const th = s.p.thresholdPence
      let guard = 0
      while (th && th > 0 && s.unbilled >= th && guard++ < 50) {
        charges.push({ day: d, platform: s.p.platform, label: s.p.label, amountPence: Math.round(th * s.p.cashFactor) })
        s.unbilled -= th
        s.since = 0
      }
      if (s.since >= s.p.maxDaysBetweenCharges && s.unbilled > 0) {
        charges.push({ day: d, platform: s.p.platform, label: s.p.label, amountPence: Math.round(s.unbilled * s.p.cashFactor) })
        s.unbilled = 0
        s.since = 0
      }
    }
  }
  const forecast = charges.reduce((a, c) => a + c.amountPence, 0)
  let running = args.alreadyChargedPence
  let limitHitOn: string | null = null
  if (args.limitPence !== null) {
    for (const c of charges) {
      running += c.amountPence
      if (running > args.limitPence) {
        limitHitOn = c.day
        break
      }
    }
  }
  const headroom = args.limitPence === null ? null : args.limitPence - args.alreadyChargedPence - forecast
  const byPlatform = args.platforms.map((p) => {
    const mine = charges.filter((c) => c.platform === p.platform)
    return { platform: p.platform, label: p.label, amountPence: mine.reduce((a, c) => a + c.amountPence, 0), count: mine.length }
  })
  const note =
    args.limitPence === null
      ? `About ${money(forecast)} more is expected on the card before the period ends.`
      : limitHitOn
        ? `The card limit is forecast to run out on ${limitHitOn}. Charges after that will be declined and the platforms will pause delivery until the balance is paid.`
        : `About ${money(forecast)} more is expected on the card; ${money(headroom ?? 0)} of limit would remain.`
  return {
    charges,
    forecastPence: forecast,
    alreadyChargedPence: args.alreadyChargedPence,
    limitPence: args.limitPence,
    headroomPence: headroom,
    limitHitOn,
    byPlatform,
    note,
  }
}
