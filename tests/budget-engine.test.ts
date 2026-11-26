/**
 * Budget Allocator — the pure parts.
 *
 * Curves, the allocator, pacing, the cash forecast, descriptor
 * classification and the three-way reconciliation. No network, no database.
 * The simulator knows the true curves, so the allocator's direction can be
 * checked against the right answer rather than against itself.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { adstock, curveAt, fitCurve, hill, responseAt, spendForShare } from '../src/lib/budget/curves'
import { allocate, AllocationError } from '../src/lib/budget/optimise'
import { forecastCash, maxRemainingSpend, paceLine, dayRange, weekStart } from '../src/lib/budget/pacing'
import { classify, googleCustomerId, sanitiseDescriptor, withOccurrence } from '../src/lib/budget/merchants'
import { reconcile, type ReconcileInput } from '../src/lib/budget/reconcile'
import { simulateCardFeed, simulateHistory, simulatePlatformDays, TRUE_CHANNELS } from '../src/lib/budget/simulator'
import { money, splitExact, toPence } from '../src/lib/budget/money'
import { GOOGLE_OVERDELIVERY, META_OVERDELIVERY } from '../src/lib/budget/channels'
import type { AllocationInput, AllocationLineInput, CardTx, CurveFit, Observation } from '../src/lib/budget/types'

const history = simulateHistory({ endWeek: '2026-10-05', weeks: 60, seed: 'test' })
const fits = new Map<string, CurveFit>()
for (const [k, obs] of history) fits.set(k, fitCurve(k, obs, { metric: 'conversions', draws: 60, seed: `t:${k}` }))

function line(key: string, currentPence: number, extra: Partial<AllocationLineInput> = {}): AllocationLineInput {
  return {
    id: key,
    key,
    label: key,
    category: 'paid_media',
    currentPence,
    minPence: 0,
    maxPence: null,
    locked: false,
    fit: fits.get(key) ?? null,
    cashFactor: 1,
    incrementality: 1,
    allowExtrapolation: false,
    ...extra,
  }
}

function input(lines: AllocationLineInput[], extra: Partial<AllocationInput> = {}): AllocationInput {
  return {
    totalPence: lines.reduce((a, l) => a + l.currentPence, 0),
    weeks: 4,
    objective: 'conversions',
    riskAversion: 0,
    learningShare: 0,
    extrapolationCap: 1.5,
    maxShift: null,
    valuePerConversionPence: null,
    lines,
    ...extra,
  }
}

describe('money', () => {
  test('formats pence without floating drift', () => {
    assert.equal(money(123456), '£1,234')
    assert.equal(money(99), '£0.99')
    assert.equal(money(-5000), '−£50.00')
    assert.equal(toPence('£1,234.56'), 123456)
  })
  test('splitExact always sums to the total', () => {
    const parts = splitExact(100_001, [1, 1, 1])
    assert.equal(parts.reduce((a, b) => a + b, 0), 100_001)
    assert.deepEqual(splitExact(10, [0, 0]), [0, 0])
  })
})

describe('curves', () => {
  test('adstock carries spend forward geometrically', () => {
    assert.deepEqual(adstock([100, 0, 0], 0.5), [100, 50, 25])
  })
  test('hill is half at gamma and bounded', () => {
    assert.equal(hill(10, 1.5, 10), 0.5)
    assert.equal(hill(0, 1, 10), 0)
    assert.ok(hill(1e9, 1, 10) < 1)
  })
  test('steady-state response accounts for carryover', () => {
    const p = { beta: 100, alpha: 1, gamma: 200, theta: 0.5 }
    // £100/week settles at an adstock of £200 → half the ceiling.
    assert.ok(Math.abs(responseAt(p, 100) - 50) < 1e-9)
  })
  test('fits a curve close to the truth from a year of data', () => {
    const truth = TRUE_CHANNELS.find((c) => c.key === 'google_ads')!
    const fit = fits.get('google_ads')!
    assert.equal(fit.quality === 'good' || fit.quality === 'usable', true, `quality ${fit.quality}`)
    assert.ok(fit.r2 > 0.4, `r2 ${fit.r2}`)
    for (const s of [100_000, 150_000, 200_000]) {
      const est = curveAt(fit.curve, s)
      const real = responseAt(truth.params, s)
      assert.ok(Math.abs(est / real - 1) < 0.2, `at ${s}: est ${est.toFixed(1)} vs true ${real.toFixed(1)}`)
    }
    assert.equal(fit.draws.length, 60)
  })
  test('is deterministic for a seed', () => {
    const a = fitCurve('x', history.get('meta_ads')!, { metric: 'conversions', draws: 10, seed: 's' })
    const b = fitCurve('x', history.get('meta_ads')!, { metric: 'conversions', draws: 10, seed: 's' })
    assert.deepEqual(a.draws, b.draws)
  })
  test('falls back to the prior with thin history, and says so', () => {
    const thin = fitCurve('x', history.get('meta_ads')!.slice(-4), { metric: 'conversions', draws: 5 })
    assert.equal(thin.quality, 'thin')
    assert.equal(thin.credibility, 0)
    assert.match(thin.notes.join(' '), /prior/)
    assert.equal(thin.draws.length, 5)
  })
  test('reports no curve when there are spend but no outcomes', () => {
    const obs: Observation[] = history.get('meta_ads')!.map((o) => ({ ...o, conversions: 0, revenuePence: 0 }))
    const fit = fitCurve('x', obs, { metric: 'conversions', draws: 5 })
    assert.equal(fit.quality, 'none')
    assert.match(fit.notes.join(' '), /conversion tracking/)
  })
  test('warns when spend never varied', () => {
    const flat = history.get('meta_ads')!.map((o) => ({ ...o, spendPence: 90_000 }))
    const fit = fitCurve('x', flat, { metric: 'conversions' })
    assert.match(fit.notes.join(' '), /barely changed/)
  })
  test('credibility shrinks a short fit toward the prior', () => {
    const short = fitCurve('x', history.get('google_ads')!.slice(-14), { metric: 'conversions' })
    const long = fits.get('google_ads')!
    assert.ok(short.credibility < long.credibility)
    assert.equal(short.curve.components.length, 2)
  })
  test('saturation point is above typical spend for a channel with room', () => {
    const fit = fits.get('meta_ads')!
    assert.ok(spendForShare(fit.curve, 0.8) > fit.meanWeeklyPence)
  })
})

describe('allocate', () => {
  test('moves money toward the channel with the better marginal return (Meta, by construction)', () => {
    const r = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000)]))
    const meta = r.lines.find((l) => l.key === 'meta_ads')!
    assert.ok(meta.deltaPence > 0, `meta delta ${meta.deltaPence}`)
    assert.equal(r.allocatedPence + r.unallocatedPence, r.totalPence)
    assert.ok(r.totals.recommended.mean >= r.totals.current.mean)
    assert.ok(r.totals.probabilityBetter > 0.5)
    assert.match(r.summary, /Meta|meta_ads/)
  })
  test('agrees with the true curves: recommended split beats current under the truth', () => {
    const r = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000), line('linkedin_ads', 160_000)]))
    const truthValue = (key: string, pence: number) =>
      4 * responseAt(TRUE_CHANNELS.find((c) => c.key === key)!.params, pence / 4)
    const cur = r.lines.reduce((a, l) => a + truthValue(l.key, l.currentPence), 0)
    const rec = r.lines.reduce((a, l) => a + truthValue(l.key, l.recommendedPence), 0)
    assert.ok(rec > cur, `true outcome rec ${rec.toFixed(1)} vs current ${cur.toFixed(1)}`)
  })
  test('respects minimums, maximums and locks exactly', () => {
    const r = allocate(
      input([
        line('google_ads', 600_000, { minPence: 550_000 }),
        line('meta_ads', 360_000, { maxPence: 400_000 }),
        line('linkedin_ads', 160_000, { locked: true }),
      ]),
    )
    const g = r.lines.find((l) => l.key === 'google_ads')!
    const m = r.lines.find((l) => l.key === 'meta_ads')!
    const li = r.lines.find((l) => l.key === 'linkedin_ads')!
    assert.ok(g.recommendedPence >= 550_000)
    assert.ok(m.recommendedPence <= 400_000)
    assert.equal(li.recommendedPence, 160_000)
    assert.equal(li.binding, 'locked')
  })
  test('lines without curves keep their amount', () => {
    const r = allocate(input([line('google_ads', 600_000), line('events', 100_000, { fit: null, category: 'events' })]))
    const ev = r.lines.find((l) => l.key === 'events')!
    assert.equal(ev.recommendedPence, 100_000)
    assert.equal(ev.binding, 'fixed')
    assert.match(ev.reason, /No response curve/)
  })
  test('refuses to spend past the evidence and reports the money as unallocated', () => {
    const fit = fits.get('email')!
    const r = allocate(input([line('email', 60_000)], { totalPence: 2_000_000 }))
    const e = r.lines[0]
    assert.equal(e.binding, 'evidence_cap')
    assert.ok(e.recommendedPence <= Math.round(1.5 * fit.maxObservedWeeklyPence * 4) + 1)
    assert.ok(r.unallocatedPence > 0)
    assert.ok(r.warnings.some((w) => /unallocated/.test(w)))
  })
  test('allowing extrapolation lifts the evidence cap and flags it', () => {
    const r = allocate(input([line('email', 60_000, { allowExtrapolation: true })], { totalPence: 2_000_000 }))
    assert.equal(r.unallocatedPence, 0)
    assert.equal(r.lines[0].extrapolated, true)
  })
  test('the shift limit bounds each move', () => {
    const r = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000)], { maxShift: 0.1 }))
    for (const l of r.lines) assert.ok(Math.abs(l.deltaPence) <= l.currentPence * 0.1 + 1, `${l.key} ${l.deltaPence}`)
    assert.ok(r.lines.some((l) => l.binding === 'shift_limit'))
  })
  test('cash factor makes an expensive-to-pay channel lose money', () => {
    const base = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000)]))
    const taxed = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000, { cashFactor: 1.3 })]))
    const m0 = base.lines.find((l) => l.key === 'meta_ads')!.recommendedPence
    const m1 = taxed.lines.find((l) => l.key === 'meta_ads')!.recommendedPence
    assert.ok(m1 < m0, `${m1} should be below ${m0}`)
    assert.match(taxed.lines.find((l) => l.key === 'meta_ads')!.reason, /costs £1\.30 on the card/)
  })
  test('incrementality below one counts fewer outcomes', () => {
    const base = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000)]))
    const deflated = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000, { incrementality: 0.5 })]))
    assert.ok(
      deflated.lines.find((l) => l.key === 'meta_ads')!.recommendedPence < base.lines.find((l) => l.key === 'meta_ads')!.recommendedPence,
    )
  })
  test('risk aversion never produces a worse lower bound than risk-neutral', () => {
    const lines = [line('google_ads', 600_000), line('meta_ads', 360_000), line('linkedin_ads', 160_000)]
    const neutral = allocate(input(lines))
    const careful = allocate(input(lines, { riskAversion: 1 }))
    assert.ok(careful.totals.recommended.p10 >= neutral.totals.recommended.p10 * 0.97)
  })
  test('learning budget goes to lines with curves and is labelled', () => {
    const r = allocate(input([line('google_ads', 600_000), line('meta_ads', 360_000)], { learningShare: 0.1 }))
    assert.ok(r.learningPence > 0)
    assert.equal(r.lines.reduce((a, l) => a + l.learningPence, 0), r.learningPence)
    assert.ok(r.lines.some((l) => /learning budget/.test(l.reason)))
  })
  test('profit objective will not buy unprofitable conversions', () => {
    const r = allocate(
      input([line('google_ads', 600_000), line('meta_ads', 360_000)], {
        objective: 'profit',
        valuePerConversionPence: 1_000, // £10 a conversion: nothing is worth buying at scale
        totalPence: 4_000_000,
      }),
    )
    assert.ok(r.unallocatedPence > 0)
  })
  test('profit objective needs a conversion value', () => {
    assert.throws(() => allocate(input([line('google_ads', 600_000)], { objective: 'profit' })), AllocationError)
  })
  test('an impossible total explains itself', () => {
    assert.throws(
      () => allocate(input([line('google_ads', 600_000, { minPence: 600_000 }), line('events', 200_000, { fit: null })], { totalPence: 500_000 })),
      /does not cover/,
    )
  })
  test('is deterministic', () => {
    const lines = [line('google_ads', 600_000), line('meta_ads', 360_000)]
    assert.deepEqual(allocate(input(lines, { learningShare: 0.1 })), allocate(input(lines, { learningShare: 0.1 })))
  })
  test('handles an S-shaped channel starting from zero', () => {
    const r = allocate(input([line('google_ads', 0), line('linkedin_ads', 0)], { totalPence: 800_000 }))
    assert.ok(r.lines.find((l) => l.key === 'google_ads')!.recommendedPence > 0)
  })
})

describe('pacing', () => {
  const period = { periodStart: '2026-10-01', periodEnd: '2026-10-31' }
  const days = dayRange('2026-10-01', '2026-10-17').map((day) => ({ day, spendPence: 10_000 }))
  test('on track when spending at the planned rate', () => {
    const p = paceLine({ lineId: 'l', label: 'G', channelKey: 'google_ads', plannedPence: 310_000, today: '2026-10-18', daily: days, ...period })
    assert.equal(p.status, 'on_track')
    assert.equal(p.actualPence, 170_000)
    assert.equal(p.projectedPence, 310_000)
  })
  test('over when the run rate overshoots, with a corrective daily rate', () => {
    const p = paceLine({ lineId: 'l', label: 'G', channelKey: 'google_ads', plannedPence: 250_000, today: '2026-10-18', daily: days, ...period })
    assert.equal(p.status, 'over')
    assert.equal(p.suggestedDailyPence, Math.round(80_000 / 14))
  })
  test('under when spend stalls', () => {
    const p = paceLine({ lineId: 'l', label: 'G', channelKey: 'google_ads', plannedPence: 600_000, today: '2026-10-18', daily: days, ...period })
    assert.equal(p.status, 'under')
  })
  test('at risk when the platform may legitimately overspend at current budgets', () => {
    const p = paceLine({
      lineId: 'l', label: 'G', channelKey: 'google_ads', plannedPence: 310_000, today: '2026-10-18', daily: days, dailyBudgetPence: 14_000, ...period,
    })
    assert.equal(p.status, 'at_risk')
    assert.ok(p.worstCasePence! > 310_000)
  })
  test('Google worst case respects the 30.4× monthly cap', () => {
    const remaining = dayRange('2026-10-18', '2026-10-31')
    const elapsed = dayRange('2026-10-01', '2026-10-17')
    const byDay = new Map(elapsed.map((d) => [d, 10_000]))
    const worst = maxRemainingSpend(GOOGLE_OVERDELIVERY, 10_000, remaining, elapsed, byDay)
    // 30.4 × £100 = £3,040 for the month; £1,700 spent → at most £1,340 left (not 14 × £200 = £2,800).
    assert.equal(worst, 134_000)
  })
  test('Meta worst case respects the 7× weekly cap', () => {
    const week = dayRange('2026-10-19', '2026-10-25') // Mon..Sun
    const worst = maxRemainingSpend(META_OVERDELIVERY, 10_000, week, [], new Map())
    assert.equal(worst, 70_000)
  })
  test('weekStart is Monday', () => {
    assert.equal(weekStart('2026-10-18'), '2026-10-12')
    assert.equal(weekStart('2026-10-12'), '2026-10-12')
  })
})

describe('cash forecast', () => {
  test('threshold billing produces charges, and a card limit run-out date', () => {
    const f = forecastCash({
      today: '2026-10-18',
      periodEnd: '2026-10-31',
      alreadyChargedPence: 400_000,
      limitPence: 600_000,
      platforms: [
        { platform: 'google_ads', label: 'Google Ads', unbilledPence: 30_000, dailyRatePence: 20_000, thresholdPence: 50_000, maxDaysBetweenCharges: 30, cashFactor: 1 },
      ],
    })
    assert.ok(f.charges.length >= 5)
    assert.ok(f.charges.every((c) => c.amountPence === 50_000))
    assert.equal(f.limitHitOn !== null, true)
    assert.match(f.note, /run out/)
  })
  test('the 30-day rule bills whatever is left', () => {
    const f = forecastCash({
      today: '2026-10-18',
      periodEnd: '2026-10-20',
      alreadyChargedPence: 0,
      limitPence: null,
      daysSinceLastCharge: { google_ads: 29 },
      platforms: [{ platform: 'google_ads', label: 'G', unbilledPence: 1_000, dailyRatePence: 100, thresholdPence: 50_000, maxDaysBetweenCharges: 30, cashFactor: 1 }],
    })
    assert.equal(f.charges.length, 1)
    assert.equal(f.charges[0].amountPence, 1_100)
  })
})

describe('merchants', () => {
  test('reads the Google customer id from the descriptor', () => {
    assert.equal(googleCustomerId('GOOGLE*GOOG 482-091-7365'), '4820917365')
    assert.equal(googleCustomerId('GOOGLE *ADS4820917365'), '4820917365')
    assert.equal(googleCustomerId('FACEBK *ABC'), null)
  })
  test('classifies the major platforms', () => {
    assert.equal(classify('FACEBK *2QX8ZK9LP2').channelKey, 'meta_ads')
    assert.equal(classify('GOOGLE*GOOG 4820917365').channelKey, 'google_ads')
    assert.equal(classify('LINKEDIN *ADS 123').channelKey, 'linkedin_ads')
    assert.equal(classify('MICROSOFT*ADS-B00123').channelKey, 'microsoft_ads')
    assert.equal(classify('TIKTOK ADS 7341').channelKey, 'tiktok_ads')
    assert.equal(classify('HUBSPOT INC').channelKey, 'tools_saas')
    assert.equal(classify('TESCO STORES 2231').channelKey, null)
  })
  test("a person's rule wins and is a plain substring, not a regex", () => {
    const rules = [{ id: 'r1', contains: 'PAYPAL *CREATIVE', channelKey: 'creative_design', lineId: null, ignore: false }]
    assert.equal(classify('PAYPAL *CREATIVEHUB', rules).channelKey, 'creative_design')
    const evil = [{ id: 'r2', contains: '(a+)+$', channelKey: 'events', lineId: null, ignore: false }]
    assert.equal(classify('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', evil).channelKey, null)
  })
  test('ignore rules exclude a merchant', () => {
    const c = classify('UBER TRIP', [{ id: 'r', contains: 'uber', channelKey: null, lineId: null, ignore: true }])
    assert.equal(c.via, 'ignored')
  })
  test('masks anything that looks like a card number, keeps Google ids', () => {
    assert.equal(sanitiseDescriptor('REFUND 4111 1111 1111 1111 X'), 'REFUND ••••1111 X')
    assert.equal(sanitiseDescriptor('GOOGLE*GOOG 4820917365'), 'GOOGLE*GOOG 4820917365')
  })
  test('identical charges on one day get distinct, stable keys', () => {
    const rows = [
      { day: '2026-10-02', amountPence: 50_000, currency: 'GBP', descriptor: 'GOOGLE*GOOG 1' },
      { day: '2026-10-02', amountPence: 50_000, currency: 'GBP', descriptor: 'GOOGLE*GOOG 1' },
    ]
    const a = withOccurrence('card', rows)
    const b = withOccurrence('card', rows)
    assert.notEqual(a[0].key, a[1].key)
    assert.equal(a[1].key, b[1].key)
  })
})

describe('reconcile', () => {
  const today = '2026-10-18'
  const from = '2026-10-01'
  const to = '2026-10-31'
  const platformDays = simulatePlatformDays({ from, to: '2026-10-17', seed: 'r', weekly: { google_ads: 150_000, meta_ads: 90_000, linkedin_ads: 40_000 } })
  const raw = simulateCardFeed({ cardId: 'c', from, to, today, platformDays, googleCustomerId: '4820917365', seed: 'r' })
  const txs: ReconcileInput['txs'] = raw.map((t, i) => {
    const c = classify(t.descriptor)
    return { ...t, id: `t${i}`, platform: c.channelKey, lineId: null, accountRef: c.accountRef }
  })
  const lines = [
    { id: 'L1', key: 'google_ads', label: 'Google Ads', plannedPence: 640_000 },
    { id: 'L2', key: 'meta_ads', label: 'Meta Ads', plannedPence: 400_000 },
    { id: 'L3', key: 'linkedin_ads', label: 'LinkedIn Ads', plannedPence: 170_000 },
    { id: 'L4', key: 'tools_saas', label: 'Tools', plannedPence: 50_000 },
    { id: 'L5', key: 'ai_generation', label: 'AI', plannedPence: 20_000 },
    { id: 'L6', key: 'creative_design', label: 'Creative', plannedPence: 30_000 },
    { id: 'L7', key: 'email', label: 'Email', plannedPence: 10_000 },
  ]
  const report = reconcile({
    periodStart: from,
    periodEnd: to,
    today,
    lines,
    txs,
    platformDays,
    connectedPlatforms: ['google_ads', 'meta_ads'],
    knownGoogleAccounts: ['4820917365'],
    simulated: true,
  })
  const kinds = new Set(report.discrepancies.map((d) => d.kind))

  test('finds every planted problem', () => {
    for (const k of ['duplicate_charge', 'unbudgeted_spend', 'unknown_merchant', 'fx_cost', 'stale_pending', 'unverifiable', 'line_overrun'] as const) {
      assert.ok(kinds.has(k), `missing ${k}; got ${[...kinds].join(', ')}`)
    }
  })
  test('names the foreign Google account and the TikTok spend', () => {
    assert.ok(report.discrepancies.some((d) => /912-773-4410/.test(d.title)))
    assert.ok(report.discrepancies.some((d) => /TikTok/.test(d.title)))
  })
  test('the benign pending duplicate of a settled Google charge is not flagged', () => {
    assert.equal(report.discrepancies.filter((d) => d.kind === 'stale_pending').length, 1)
  })
  test('Meta matches cleanly — no false alarm on threshold billing', () => {
    assert.equal(report.discrepancies.some((d) => d.platform === 'meta_ads' && d.kind !== 'line_overrun'), false)
    assert.ok(report.cashFactors.meta_ads === undefined || Math.abs(report.cashFactors.meta_ads - 1) < 0.1)
  })
  test('fingerprints are stable across runs', () => {
    const again = reconcile({ periodStart: from, periodEnd: to, today, lines, txs, platformDays, connectedPlatforms: ['google_ads', 'meta_ads'], knownGoogleAccounts: ['4820917365'] })
    assert.deepEqual(again.discrepancies.map((d) => d.fingerprint).sort(), report.discrepancies.map((d) => d.fingerprint).sort())
  })
  test('three-way rows include lines and the unidentified bucket', () => {
    assert.ok(report.rows.some((r) => r.label === 'Not identified'))
    assert.ok(report.rows.some((r) => r.label.startsWith('TikTok')))
    const g = report.rows.find((r) => r.lineId === 'L1')!
    assert.ok(g.platformPence! > 0 && g.cardPence > 0)
    assert.equal(report.totals.cardPence, txs.filter((t) => t.status === 'settled').reduce((a, t) => a + t.amountPence, 0))
  })
  test('spots 20% VAT being charged on top of spend', () => {
    const days = dayRange('2026-10-01', '2026-10-20').map((day) => ({ platform: 'meta_ads', day, spendPence: 20_000, source: 'platform' as const }))
    // £3,600 of spend billable to the 18th; charged nine × £480 = £4,320 = 1.2×.
    const charges: ReconcileInput['txs'] = Array.from({ length: 9 }, (_, i) => ({
      id: `v${i}`, cardId: 'c', externalId: `v${i}`, postedAt: `2026-10-${String(i * 2 + 1).padStart(2, '0')}T10:00:00Z`, amountPence: 48_000,
      currency: 'GBP', originalAmountMinor: null, originalCurrency: null, descriptor: `FACEBK *X${i}`, status: 'settled' as const, platform: 'meta_ads', lineId: null,
    }))
    const r = reconcile({ periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-20', lines: [], txs: charges, platformDays: days, connectedPlatforms: ['meta_ads'] })
    assert.ok(r.discrepancies.some((d) => /VAT/.test(d.title)), r.discrepancies.map((d) => d.title).join(' | '))
  })
  test('flags spend that never reached the card (failed payment)', () => {
    const days = dayRange('2026-10-01', '2026-10-20').map((day) => ({ platform: 'google_ads', day, spendPence: 20_000, source: 'platform' as const }))
    const charges: ReconcileInput['txs'] = [{ id: 'g', cardId: 'c', externalId: 'g', postedAt: '2026-10-03T10:00:00Z', amountPence: 50_000, currency: 'GBP', originalAmountMinor: null, originalCurrency: null, descriptor: 'GOOGLE*GOOG 1', status: 'settled', platform: 'google_ads', lineId: null }]
    const r = reconcile({ periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-20', lines: [], txs: charges, platformDays: days, connectedPlatforms: ['google_ads'] })
    const d = r.discrepancies.find((x) => x.kind === 'unbilled_spend')
    assert.ok(d)
    assert.equal(d!.severity, 'high')
  })
  test('ignored merchants are left out entirely', () => {
    const t: ReconcileInput['txs'] = [{ id: 'u', cardId: 'c', externalId: 'u', postedAt: '2026-10-03T10:00:00Z', amountPence: 5_000, currency: 'GBP', originalAmountMinor: null, originalCurrency: null, descriptor: 'UBER', status: 'settled', platform: null, lineId: null, ignored: true }]
    const r = reconcile({ periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-20', lines: [], txs: t, platformDays: [], connectedPlatforms: [] })
    assert.equal(r.discrepancies.length, 0)
    assert.equal(r.totals.cardPence, 0)
  })
})

void ({} as CardTx)

describe('review regressions', () => {
  test('masks card numbers however they are spaced or glued', () => {
    for (const raw of ['PAN 4111  1111  1111  1111', 'CARD4111111111111111', '4111.1111.1111.1111', '4111111111111111ABC', 'x 4111-1111-1111-1111 y']) {
      const out = sanitiseDescriptor(raw)
      assert.ok(!/\d{5,}/.test(out.replace(/[ .-]/g, '')), `${raw} → ${out}`)
      assert.match(out, /••••1111/)
    }
    assert.equal(sanitiseDescriptor('GOOGLE*GOOG 4820917365'), 'GOOGLE*GOOG 4820917365')
  })

  test('the learning budget and floors respect every limit (property test)', async () => {
    const { seeded } = await import('../src/lib/budget/random')
    const rand = seeded('prop')
    for (let i = 0; i < 150; i++) {
      const keys = ['google_ads', 'meta_ads', 'linkedin_ads', 'email'].filter(() => rand() > 0.2)
      if (keys.length < 2) continue
      const lines = keys.map((k) => {
        const cur = Math.round(50_000 + rand() * 900_000)
        const max = rand() < 0.3 ? Math.round(cur * (0.2 + rand())) : null
        return line(k, cur, { maxPence: max })
      })
      const total = lines.reduce((a, l) => a + l.currentPence, 0)
      const shift = rand() < 0.5 ? 0.1 + rand() * 0.4 : null
      let r
      try {
        r = allocate(input(lines, { totalPence: total, maxShift: shift, learningShare: rand() * 0.25 }))
      } catch (e) {
        if (e instanceof AllocationError) continue
        throw e
      }
      assert.equal(r.allocatedPence + r.unallocatedPence, r.totalPence)
      for (const l of r.lines) {
        const inp = lines.find((x) => x.id === l.id)!
        if (inp.maxPence !== null) assert.ok(l.recommendedPence <= inp.maxPence, `${l.key} ${l.recommendedPence} > max ${inp.maxPence}`)
        if (shift !== null && (inp.maxPence === null || inp.maxPence >= inp.currentPence * (1 + shift))) {
          assert.ok(l.recommendedPence <= Math.round(inp.currentPence * (1 + shift)) + 1, `${l.key} past the move limit`)
        }
        const fit = inp.fit!
        assert.ok(
          l.recommendedPence <= Math.max(inp.currentPence, Math.round(1.5 * fit.maxObservedWeeklyPence * 4)) + 1,
          `${l.key} past the evidence cap`,
        )
      }
    }
  })

  test('decimal commas parse as decimals', async () => {
    const { parseAmount } = await import('../src/lib/budget/cards/csv')
    assert.equal(parseAmount('12,50'), 1250)
    assert.equal(parseAmount('0,99'), 99)
    assert.equal(parseAmount('1,234'), 123400)
    assert.equal(parseAmount('1.234,56'), 123456)
  })

  test('on the last day of the period, today is not counted twice', () => {
    const days = dayRange('2026-10-01', '2026-10-30').map((day) => ({ day, spendPence: 10_000 }))
    const p = paceLine({ lineId: 'l', label: 'G', channelKey: 'google_ads', plannedPence: 310_000, periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-31', daily: days })
    assert.equal(p.actualPence, 300_000)
    assert.equal(p.projectedPence, 310_000)
  })

  test('charges in another currency are set aside, not summed as pence', () => {
    const t: ReconcileInput['txs'] = [
      { id: 'a', cardId: 'c', externalId: 'a', postedAt: '2026-10-03T10:00:00Z', amountPence: 50_000, currency: 'USD', originalAmountMinor: null, originalCurrency: null, descriptor: 'GOOGLE*GOOG 1', status: 'settled', platform: 'google_ads', lineId: null },
    ]
    const r = reconcile({ periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-20', lines: [], txs: t, platformDays: [], connectedPlatforms: [], cardCurrency: 'GBP' })
    assert.equal(r.totals.cardPence, 0)
    assert.ok(r.discrepancies.some((d) => /settled in USD/.test(d.title)))
  })

  test('an overrun keeps its fingerprint when a revision copies the line under a new id', () => {
    const days = dayRange('2026-10-01', '2026-10-20').map((day) => ({ platform: 'google_ads', day, spendPence: 20_000, source: 'platform' as const }))
    const fpFor = (lineId: string) =>
      reconcile({ periodStart: '2026-10-01', periodEnd: '2026-10-31', today: '2026-10-21', lines: [{ id: lineId, key: 'google_ads', label: 'G', plannedPence: 100_000 }], txs: [], platformDays: days, connectedPlatforms: ['google_ads'] })
        .discrepancies.find((d) => d.kind === 'line_overrun')!.fingerprint
    assert.equal(fpFor('old-line'), fpFor('new-line'))
  })
})
