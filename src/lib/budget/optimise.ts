/**
 * The allocator: split a budget across lines so the next pound always goes
 * where it returns most — and say how sure it is.
 *
 * Method
 * ------
 * Equalising marginal returns is the textbook answer (and what Meridian,
 * Robyn and PyMC-Marketing's optimisers do with a point estimate of each
 * curve). This allocator differs in four ways, each aimed at a gap the
 * research found in current tools:
 *
 *  1. It optimises against the bootstrap draws, not one curve. Each step's
 *     marginal return is a distribution; with risk aversion above zero the
 *     allocator prefers a reliable return to a slightly higher but shaky one.
 *  2. It allocates *cash*, not platform-reported spend. Each line carries a
 *     cash factor from the card reconciliation (FX, non-recoverable VAT, card
 *     fees) and an incrementality factor (lift tests, CRM deduplication). A
 *     channel that bills in dollars with a 3% FX fee is genuinely 3% more
 *     expensive, and no allocator that only reads platform APIs can see that.
 *  3. It refuses to spend beyond the evidence. By default no line goes past
 *     1.5× the largest week it has ever had: the curve out there is a guess.
 *     Money it will not place is reported as unallocated, never forced in.
 *  4. It can set aside a learning budget, placed where the draws disagree
 *     most about which line is best (Thompson sampling), so the plan buys
 *     information as well as outcomes.
 *
 * S-shaped curves defeat a plain greedy step (the first pounds into a channel
 * with a threshold return almost nothing, so greedy never starts it). Each
 * step therefore looks ahead several step sizes and takes the best average
 * return per pound — the standard remedy, and exact for concave curves.
 *
 * Pure and deterministic.
 */
import { curveAt, quantile } from './curves'
import { fmtNum, money, pct } from './money'
import type {
  AllocationInput,
  AllocationLineInput,
  AllocationLineResult,
  AllocationResult,
  Band,
  Curve,
} from './types'

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

type Prepared = {
  line: AllocationLineInput
  curves: Curve[] // index 0 = point estimate; then draws
  optimisable: boolean
  capPence: number // max cash, all constraints included
  capReason: 'max' | 'evidence_cap' | 'shift_limit' | 'none'
  floorPence: number
  floorReason: 'min' | 'shift_limit'
}

const LOOKAHEAD = [1, 2, 4, 8, 16, 32]

function metricOf(input: AllocationInput): 'conversions' | 'revenue' {
  const withFit = input.lines.find((l) => l.fit)
  return withFit?.fit?.metric ?? (input.objective === 'conversions' ? 'conversions' : 'revenue')
}

/** Period value of `cash` pence on one line under one curve. */
function valueAt(p: Prepared, curve: Curve, cash: number, input: AllocationInput): number {
  const weeklyPlatform = cash / Math.max(1e-9, p.line.cashFactor) / input.weeks
  const outcome = input.weeks * curveAt(curve, weeklyPlatform) * p.line.incrementality
  if (input.objective !== 'profit') return outcome
  const metric = p.line.fit?.metric ?? 'conversions'
  const revenue = metric === 'revenue' ? outcome : outcome * (input.valuePerConversionPence ?? 0)
  return revenue - cash
}

function band(values: number[]): Band {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
  }
}

function prepare(input: AllocationInput): Prepared[] {
  return input.lines.map((line) => {
    const fit = line.fit
    const optimisable = !line.locked && !!fit && fit.quality !== 'none'
    const curves = fit ? [fit.curve, ...fit.draws] : []
    let capPence = line.maxPence ?? Number.POSITIVE_INFINITY
    let capReason: Prepared['capReason'] = line.maxPence !== null ? 'max' : 'none'
    if (optimisable && fit && !line.allowExtrapolation && fit.maxObservedWeeklyPence > 0) {
      const evidence = Math.round(
        input.extrapolationCap * fit.maxObservedWeeklyPence * input.weeks * line.cashFactor,
      )
      // Never cut a line below what it already has just because of the cap.
      const evidenceCap = Math.max(evidence, line.currentPence)
      if (evidenceCap < capPence) {
        capPence = evidenceCap
        capReason = 'evidence_cap'
      }
    }
    let floorPence = line.minPence
    let floorReason: Prepared['floorReason'] = 'min'
    if (optimisable && input.maxShift !== null && line.currentPence > 0) {
      const s = Math.max(0, input.maxShift)
      const up = Math.round(line.currentPence * (1 + s))
      const down = Math.round(line.currentPence * (1 - s))
      if (up < capPence) {
        capPence = up
        capReason = 'shift_limit'
      }
      // The move limit never pushes a line above the person's own maximum.
      const ceiling = line.maxPence ?? Number.POSITIVE_INFINITY
      if (down > floorPence && down <= ceiling) {
        floorPence = down
        floorReason = 'shift_limit'
      } else if (down > floorPence && ceiling < down) {
        floorPence = Math.max(floorPence, ceiling)
        floorReason = 'shift_limit'
      }
    }
    return { line, curves, optimisable, capPence, capReason, floorPence, floorReason }
  })
}

export function allocate(input: AllocationInput): AllocationResult {
  if (input.totalPence < 0) throw new AllocationError('The total budget cannot be negative.')
  if (input.weeks <= 0) throw new AllocationError('The plan period must be at least one week.')
  if (input.objective === 'profit' && metricOf(input) === 'conversions' && !input.valuePerConversionPence) {
    throw new AllocationError('To optimise for profit, say what a conversion is worth.')
  }
  const lambda = Math.max(0, Math.min(1, input.riskAversion)) * 1.5
  const learningShare = Math.max(0, Math.min(0.25, input.learningShare))
  const warnings: string[] = []

  const prepared = prepare(input)
  const alloc = new Map<string, number>()
  const binding = new Map<string, AllocationLineResult['binding']>()

  /* ---- 1. Fixed lines keep their amount, within their own limits. */
  let fixedTotal = 0
  for (const p of prepared) {
    if (p.optimisable) continue
    const l = p.line
    const amount = l.locked
      ? l.currentPence
      : Math.max(l.minPence, Math.min(l.maxPence ?? Number.POSITIVE_INFINITY, l.currentPence))
    alloc.set(l.id, amount)
    binding.set(l.id, l.locked ? 'locked' : 'fixed')
    fixedTotal += amount
  }

  const flexible = prepared.filter((p) => p.optimisable)
  const pool = input.totalPence - fixedTotal
  const minimums = flexible.reduce((a, p) => a + p.floorPence, 0)
  if (pool < minimums) {
    throw new AllocationError(
      `The total (${money(input.totalPence)}) does not cover the locked and fixed lines (${money(fixedTotal)}) plus the minimums on the rest (${money(minimums)})${input.maxShift !== null ? `, which include the ${pct(input.maxShift)} limit on how far one reallocation may cut a line` : ''}.`,
    )
  }
  for (const p of flexible) {
    if (p.floorPence > p.capPence) {
      if (p.floorReason === 'min') warnings.push(`${p.line.label}: its minimum is above what the evidence supports; the minimum wins.`)
      p.capPence = p.floorPence
    }
    alloc.set(p.line.id, p.floorPence)
  }

  const free = pool - minimums
  const canLearn = flexible.filter((p) => p.curves.length > 1).length >= 2
  const learningPool = canLearn ? Math.floor(free * learningShare) : 0
  if (learningShare > 0 && !canLearn) {
    warnings.push('No learning budget was set aside: it needs at least two lines with response curves.')
  }
  let remaining = free - learningPool

  /* ---- 2. Greedy on risk-adjusted marginal return per pound, with lookahead. */
  const step = Math.max(100, Math.round(free / 400))
  const utility = (p: Prepared, from: number, amount: number): number => {
    const gains = p.curves.map((c) => valueAt(p, c, from + amount, input) - valueAt(p, c, from, input))
    if (gains.length === 1) return gains[0] / amount
    const m = gains.reduce((a, b) => a + b, 0) / gains.length
    const sd = Math.sqrt(gains.reduce((a, b) => a + (b - m) * (b - m), 0) / (gains.length - 1))
    return (m - lambda * sd) / amount
  }

  let guard = 0
  while (remaining > 0 && guard++ < 5000) {
    let best: { p: Prepared; amount: number; u: number } | null = null
    for (const p of flexible) {
      const have = alloc.get(p.line.id)!
      const room = p.capPence - have
      if (room <= 0) continue
      const firstStep = Math.min(step, room, remaining)
      let u = Number.NEGATIVE_INFINITY
      for (const k of LOOKAHEAD) {
        const amount = Math.min(step * k, room, remaining)
        u = Math.max(u, utility(p, have, amount))
        if (amount < step * k) break
      }
      if (!best || u > best.u) best = { p, amount: firstStep, u }
    }
    if (!best || best.u <= 0) break
    alloc.set(best.p.line.id, alloc.get(best.p.line.id)! + best.amount)
    remaining -= best.amount
  }
  let unallocated = Math.max(0, remaining)

  /* ---- 3. Learning budget: Thompson sampling over the draws. */
  const learning = new Map<string, number>()
  if (learningPool > 0) {
    const wins = new Map<string, number>()
    const nDraws = Math.max(...flexible.map((p) => p.curves.length)) - 1
    for (let d = 1; d <= nDraws; d++) {
      let top: { id: string; m: number } | null = null
      for (const p of flexible) {
        const have = alloc.get(p.line.id)!
        if (have >= p.capPence) continue
        const c = p.curves[1 + ((d - 1) % (p.curves.length - 1 || 1))] ?? p.curves[0]
        const m = (valueAt(p, c, have + step, input) - valueAt(p, c, have, input)) / step
        if (!top || m > top.m) top = { id: p.line.id, m }
      }
      if (top && top.m > 0) wins.set(top.id, (wins.get(top.id) ?? 0) + 1)
    }
    const total = [...wins.values()].reduce((a, b) => a + b, 0)
    let left = learningPool
    if (total > 0) {
      for (const p of flexible) {
        const share = Math.floor((learningPool * (wins.get(p.line.id) ?? 0)) / total)
        // The learning budget obeys every limit the greedy pass did: maximum, evidence cap, move limit.
        const room = p.capPence - alloc.get(p.line.id)!
        const give = Math.max(0, Math.min(share, room))
        if (give > 0) {
          learning.set(p.line.id, give)
          alloc.set(p.line.id, alloc.get(p.line.id)! + give)
          left -= give
        }
      }
    }
    // Rounding pence from the shares go to the line that won most often.
    const top = [...wins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const topLine = flexible.find((p) => p.line.id === top)
    if (topLine && left > 0 && left < 100 * flexible.length) {
      const room = topLine.capPence - alloc.get(topLine.line.id)!
      const give = Math.max(0, Math.min(left, room))
      alloc.set(topLine.line.id, alloc.get(topLine.line.id)! + give)
      learning.set(topLine.line.id, (learning.get(topLine.line.id) ?? 0) + give)
      left -= give
    }
    unallocated += left
  }

  // Leftovers smaller than a step are rounding, not a decision: place them on the best line with room.
  if (unallocated > 0 && unallocated < step) {
    let best: { p: Prepared; u: number } | null = null
    for (const p of flexible) {
      const have = alloc.get(p.line.id)!
      if (p.capPence - have < unallocated) continue
      const u = utility(p, have, unallocated)
      if (u > 0 && (!best || u > best.u)) best = { p, u }
    }
    if (best) {
      alloc.set(best.p.line.id, alloc.get(best.p.line.id)! + unallocated)
      unallocated = 0
    }
  }

  /* ---- 4. Report. */
  const nWorlds = Math.max(1, ...flexible.map((p) => p.curves.length))
  const worldCurrent = new Array<number>(nWorlds).fill(0)
  const worldRec = new Array<number>(nWorlds).fill(0)

  const lines: AllocationLineResult[] = prepared.map((p) => {
    const l = p.line
    const rec = alloc.get(l.id) ?? 0
    const base: Omit<AllocationLineResult, 'reason' | 'binding'> = {
      id: l.id,
      key: l.key,
      label: l.label,
      category: l.category,
      currentPence: l.currentPence,
      recommendedPence: rec,
      deltaPence: rec - l.currentPence,
      learningPence: learning.get(l.id) ?? 0,
      optimisable: p.optimisable,
      outcomeCurrent: null,
      outcomeRecommended: null,
      marginalPer100: null,
      saturation: null,
      extrapolated: false,
    }
    if (!p.curves.length) {
      return {
        ...base,
        binding: binding.get(l.id) ?? 'fixed',
        reason: l.locked
          ? 'Locked at its planned amount.'
          : 'No response curve — there are no tracked outcomes for this line — so it keeps its planned amount within its limits.',
      }
    }

    const worlds = p.curves.length > 1 ? p.curves.slice(1) : p.curves
    const cur = worlds.map((c) => valueAt(p, c, l.currentPence, input))
    const nxt = worlds.map((c) => valueAt(p, c, rec, input))
    const marg = worlds.map((c) => (valueAt(p, c, rec + 10_000, input) - valueAt(p, c, rec, input)))
    for (let w = 0; w < nWorlds; w++) {
      worldCurrent[w] += cur[w % cur.length]
      worldRec[w] += nxt[w % nxt.length]
    }
    const weekly = rec / l.cashFactor / input.weeks
    const ceiling = curveAt(p.curves[0], 1e12)
    const saturation = ceiling > 0 ? curveAt(p.curves[0], weekly) / ceiling : null
    const extrapolated =
      !!l.fit && l.fit.maxObservedWeeklyPence > 0 && weekly > l.fit.maxObservedWeeklyPence * input.extrapolationCap

    let b: AllocationLineResult['binding'] = binding.get(l.id) ?? 'none'
    if (p.optimisable) {
      if (rec - (learning.get(l.id) ?? 0) <= p.floorPence && p.floorPence > 0) b = p.floorReason
      else if (rec >= p.capPence) b = p.capReason
      else b = 'none'
    }

    const result = {
      ...base,
      outcomeCurrent: band(cur),
      outcomeRecommended: band(nxt),
      marginalPer100: band(marg),
      saturation,
      extrapolated,
      binding: b,
    }
    return { ...result, reason: explain(result, l, input) }
  })

  const allocated = lines.reduce((a, l) => a + l.recommendedPence, 0)
  const current = band(worldCurrent)
  const recommended = band(worldRec)
  const better = worldRec.filter((v, i) => v > worldCurrent[i]).length / nWorlds
  const metric = metricOf(input)

  if (unallocated > 0) {
    warnings.push(
      input.objective === 'profit'
        ? `${money(unallocated)} is left unallocated: no line returns more than it costs past this point.`
        : `${money(unallocated)} is left unallocated: every line with a curve has reached its limit or the edge of its evidence. Keep it in reserve, raise a limit, or allow a line to go past its evidence.`,
    )
  }
  const extrap = lines.filter((l) => l.extrapolated)
  if (extrap.length) {
    warnings.push(`${extrap.map((l) => l.label).join(', ')}: spending past the evidence. Expect the forecast to be wrong in either direction.`)
  }

  return {
    objective: input.objective,
    metric,
    totalPence: input.totalPence,
    allocatedPence: allocated,
    unallocatedPence: unallocated,
    learningPence: [...learning.values()].reduce((a, b) => a + b, 0),
    lines,
    totals: {
      current,
      recommended,
      probabilityBetter: Math.round(better * 1000) / 1000,
      upliftMean: recommended.mean - current.mean,
    },
    warnings,
    summary: summarise(lines, current, recommended, better, input, metric, unallocated),
  }
}

/* -------------------------------------------------------------- language */

function unit(input: AllocationInput, metric: 'conversions' | 'revenue', n: number): string {
  if (input.objective === 'profit') return `${money(n)} profit`
  if (metric === 'revenue') return `${money(n)} revenue`
  return `${fmtNum(n, n < 10 ? 1 : 0)} conversion${Math.abs(n - 1) < 0.05 ? '' : 's'}`
}

function explain(
  r: Omit<AllocationLineResult, 'reason'>,
  l: AllocationLineInput,
  input: AllocationInput,
): string {
  const metric = l.fit?.metric ?? 'conversions'
  const m = r.marginalPer100!
  const nextHundred = `The next £100 returns ${unit(input, metric, m.mean)} (likely ${unit(input, metric, m.p10)} to ${unit(input, metric, m.p90)})`
  const sat = r.saturation !== null ? ` It is ${pct(r.saturation)} of the way to its ceiling.` : ''
  const adj: string[] = []
  if (l.cashFactor > 1.005) adj.push(`each £1 of platform spend costs ${money(Math.round(l.cashFactor * 100))} on the card`)
  if (l.incrementality < 0.995) adj.push(`only ${pct(l.incrementality)} of its reported results are counted as incremental`)
  const adjText = adj.length ? ` Adjusted because ${adj.join(' and ')}.` : ''
  const learn = r.learningPence > 0 ? ` ${money(r.learningPence)} of it is learning budget: the evidence disagrees most about this line.` : ''

  switch (r.binding) {
    case 'evidence_cap':
      return `Held at 1.5× its biggest week on record. Returns past that are a guess — test before going further. ${nextHundred}.${sat}${adjText}`
    case 'max':
      return `At its maximum. ${nextHundred}, so it would take more if the limit allowed.${sat}${adjText}`
    case 'shift_limit':
      return `${r.deltaPence >= 0 ? 'Raised' : 'Cut'} as far as one reallocation allows (${pct(input.maxShift ?? 0)}). Bigger swings reset platform learning and outrun the evidence; the next run can move it further. ${nextHundred}.${sat}${adjText}`
    case 'min':
      return `Kept at its minimum: other lines return more per pound. ${nextHundred}.${sat}${adjText}`
    default:
      break
  }
  if (r.deltaPence > 0) return `Increased: it returns more per pound than the lines money came from. ${nextHundred}.${sat}${adjText}${learn}`
  if (r.deltaPence < 0) return `Reduced: returns flatten at the current level. ${nextHundred}, less than elsewhere.${sat}${adjText}${learn}`
  return `Unchanged: already where its next pound matches the other lines. ${nextHundred}.${sat}${adjText}${learn}`
}

function summarise(
  lines: AllocationLineResult[],
  current: Band,
  rec: Band,
  better: number,
  input: AllocationInput,
  metric: 'conversions' | 'revenue',
  unallocated: number,
): string {
  const moves = lines
    .filter((l) => l.optimisable && Math.abs(l.deltaPence) >= Math.max(5000, input.totalPence * 0.01))
    .sort((a, b) => b.deltaPence - a.deltaPence)
  if (moves.length === 0 && unallocated === 0) {
    return `The current split is already close to optimal: moving money between lines would change the expected outcome by less than the uncertainty in it.`
  }
  const ups = moves.filter((m) => m.deltaPence > 0).map((m) => `${m.label} +${money(m.deltaPence)}`)
  const downs = moves.filter((m) => m.deltaPence < 0).map((m) => `${m.label} ${money(m.deltaPence)}`)
  const verb = input.objective === 'profit' ? 'profit' : metric === 'revenue' ? 'revenue' : 'conversions'
  const delta = rec.mean - current.mean
  const deltaText =
    input.objective === 'profit' || metric === 'revenue'
      ? money(delta)
      : `${fmtNum(delta, Math.abs(delta) < 10 ? 1 : 0)} conversions`
  const parts = [
    ups.length ? `Move money to ${ups.join(', ')}` : null,
    downs.length ? `from ${downs.join(', ')}` : null,
  ].filter(Boolean)
  const certainty =
    better >= 0.9 ? 'very likely' : better >= 0.75 ? 'likely' : better >= 0.55 ? 'more likely than not' : 'not clearly'
  return `${parts.join(' ')}. Expected ${verb} change: ${delta >= 0 ? '+' : ''}${deltaText} over the period. In ${pct(better)} of plausible worlds the new split does better, so it is ${certainty} an improvement.${unallocated > 0 ? ` ${money(unallocated)} is held back rather than spent past the evidence.` : ''}`
}
