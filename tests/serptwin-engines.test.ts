import { describe, expect, it } from './expect'
import { simulate, simulatePauseTest, TRUTH } from '../src/lib/serptwin/simulator'
import { buildLedger } from '../src/lib/serptwin/ledger'
import { fitCtrCurve } from '../src/lib/serptwin/ctr'
import { DEFAULT_SETTINGS } from '../src/lib/serptwin/types'
import {
  attainability,
  judgeQueries,
  recapturePrior,
  valueOfPauseTest,
} from '../src/lib/serptwin/engines/overlap'
import { designPauseTest, readPauseTest, switchbackSchedule } from '../src/lib/serptwin/engines/experiment'
import { buildGenome } from '../src/lib/serptwin/engines/genome'
import { proposeRewrites } from '../src/lib/serptwin/engines/transfer'
import { measureDrift, mineNegatives } from '../src/lib/serptwin/engines/drift'
import { titleFits } from '../src/lib/serptwin/pixel'
import { NEEDS_SUBSTANTIATION, NOT_TRANSFERABLE } from '../src/lib/serptwin/claims'

const input = simulate()
const settings = DEFAULT_SETTINGS
const ledger = buildLedger(input, settings)
const curve = fitCtrCurve(input.organic)
const verdicts = judgeQueries(ledger, curve, settings)
const verdict = (q: string) => verdicts.find((v) => v.key === q)!

describe('query ledger', () => {
  it('joins paid and organic on the same search', () => {
    const e = ledger.byKey.get('marketing automation platform')!
    expect(e.paid.clicks).toBeGreaterThan(0)
    expect(e.organic.impressions).toBeGreaterThan(0)
    expect(e.organic.position).toBeGreaterThan(1.5)
    expect(e.organic.position).toBeLessThan(3.2)
  })
  it('covers the whole window', () => {
    expect(ledger.window.days).toBe(56)
    expect(ledger.window.end).toBe('2026-09-27')
  })
})

describe('CTR curve', () => {
  it("recovers the site's planted curve from Search Console rows", () => {
    expect(curve.fitted).toBe(true)
    expect(curve.b).toBeGreaterThan(TRUTH.ctrCurve.b - 0.15)
    expect(curve.b).toBeLessThan(TRUTH.ctrCurve.b + 0.15)
    expect(Math.abs(curve.a - TRUTH.ctrCurve.a)).toBeLessThan(0.06)
  })
})

describe('engine 1 — paid/organic overlap', () => {
  it('matches the published incrementality prior (Chan et al. 2012)', () => {
    expect(recapturePrior(1, 0)).toBeCloseTo(0.5, 6) // ~50% incremental at #1
    expect(recapturePrior(3, 0)).toBeCloseTo(0.18, 2) // ~82% incremental at #2–4
    expect(recapturePrior(6, 0)).toBeLessThan(0.05) // ~96% incremental at #5+
    expect(recapturePrior(1, 0.5)).toBeLessThan(recapturePrior(1, 0))
  })

  it('values a test at zero when no plausible recapture could make pausing pay', () => {
    expect(valueOfPauseTest(100, 10_000, 0.5, 6)).toBeLessThan(0.5) // needs 99% recapture
    expect(valueOfPauseTest(1000, 500, 0.5, 6)).toBeCloseTo(500 + 500 * 0.5, -1) // pays at any recapture
  })

  it('risk-adjusts SEO upside by distance from the top three', () => {
    expect(attainability(3)).toBe(1)
    expect(attainability(7)).toBeCloseTo(0.5, 6)
    expect(attainability(null)).toBeLessThan(attainability(15))
  })

  it('defends a brand term a competitor is bidding on', () => {
    expect(verdict('cy group').verdict).toBe('defend')
    expect(verdict('cy group').reason).toMatch(/pipeloop/)
  })

  it('defends a high-return term even when it ranks #1 with no competitor', () => {
    expect(verdict('cy group pricing').verdict).toBe('defend')
  })

  it("flags existing customers' login clicks as a harvest candidate", () => {
    expect(verdict('cy group login').verdict).toBe('harvest')
  })

  it('classifies bridge and gap searches', () => {
    expect(verdict('marketing automation').verdict).toBe('bridge')
    expect(verdict('enterprise marketing automation platform').verdict).toBe('gap')
  })

  it('never judges off-intent searches — those belong to the drift engine', () => {
    expect(verdict('marketing automation jobs').verdict).toBe('hold')
  })
})

describe('pause experiments', () => {
  const design = designPauseTest(
    input,
    verdicts.filter((v) => v.verdict === 'harvest'),
    settings,
  )!

  it('balances every weekday across both arms', () => {
    const s = switchbackSchedule(14)
    // Day 0 is a Monday in the atom; each weekday position appears once on, once off.
    for (let d = 0; d < 7; d++) expect(new Set([s[d], s[d + 7]])).toEqual(new Set(['on', 'off']))
    expect(s.filter((a) => a === 'on').length).toBe(7)
  })

  it('designs a testable switchback on the harvest cell', () => {
    expect(design.testable).toBe(true)
    expect(design.totalDays % 14).toBe(0)
    expect(design.totalDays).toBeLessThanOrEqual(settings.maxExperimentDays)
    expect(design.worstCaseCost).toBeGreaterThanOrEqual(0)
    expect(design.expectedSe).toBeLessThan(0.2)
  })

  it.each([11, 22, 33])('recovers the planted recapture rate (seed %i) and decides to pause', (seed) => {
    const days = simulatePauseTest(design, { seed })
    const out = readPauseTest(days, design.breakEvenRecapture)
    expect(out.ci95[0]).toBeLessThan(TRUTH.recapture)
    expect(out.ci95[1]).toBeGreaterThan(TRUTH.recapture)
    expect(out.decision).toBe('pause')
  })

  it('tells you to resume when the ads really are incremental', () => {
    // A high-return cell (break-even 45%) where almost nothing comes back organically.
    const out = readPauseTest(simulatePauseTest(design, { seed: 5, recapture: 0.05 }), 0.45)
    expect(out.decision).toBe('resume')
  })

  it("says 'extend' rather than guess when the truth sits on break-even", () => {
    const out = readPauseTest(simulatePauseTest(design, { seed: 9, recapture: 0.4 }), 0.4)
    expect(out.decision).toBe('extend')
  })

  it('holds back harvest queries that would drown the signal in organic noise', () => {
    for (const d of design.deferred) expect(design.queries.map((q) => q.key)).not.toContain(d.key)
    expect(design.queries.length + design.deferred.length).toBe(
      verdicts.filter((v) => v.verdict === 'harvest').length,
    )
  })
})

describe('engine 2 — claim genome', () => {
  const genome = buildGenome(input, ledger)
  const tx = new Map(genome.byIntent.get('transactional')!.map((e) => [e.claim, e]))

  it('assigns each ad group the intent of the searches it actually serves', () => {
    expect(genome.adGroupIntent.get('ag_brand')).toBe('navigational')
    expect(genome.adGroupIntent.get('ag_email')).toBe('transactional')
    expect(genome.adGroupIntent.get('ag_compare')).toBe('commercial')
  })

  it('finds the strongest planted winner and reports an interval containing the truth', () => {
    const rr = tx.get('risk_reversal')!
    expect(rr.status).toBe('winner')
    const truth = TRUTH.claims.risk_reversal[0] * TRUTH.claims.risk_reversal[1]
    expect(rr.vpiCi95[0]).toBeLessThan(truth)
    expect(rr.vpiCi95[1]).toBeGreaterThan(truth)
  })

  it('sees through clickbait: price wins clicks for comparison shoppers but not value', () => {
    const price = genome.byIntent.get('commercial')!.find((e) => e.claim === 'price')!
    expect(price.ctrLift).toBeGreaterThan(1.03)
    expect(price.cvrLift).toBeLessThan(0.95)
    expect(price.status).not.toBe('winner')
  })

  it('does not let a tiny asset top the table by luck', () => {
    const lucky = {
      ...input,
      assets: [
        ...input.assets,
        {
          adGroupId: 'ag_ma',
          adId: 'x',
          assetId: 'lucky',
          field: 'HEADLINE' as const,
          text: 'Lucky Headline',
          impressions: 30,
          clicks: 12,
          conversions: 6,
        },
      ],
    }
    const g = buildGenome(lucky, buildLedger(lucky, settings))
    const a = g.assets.find((s) => s.asset.assetId === 'lucky')!
    expect(a.ctrLift).toBeLessThan(1.15) // 40% observed CTR on 30 impressions
  })

  // One seed can be lucky. The estimator's real properties are measured over many.
  describe('over 16 independent simulated accounts', () => {
    const runs = Array.from({ length: 16 }, (_, i) => {
      const inp = simulate({ seed: 1000 + i })
      return new Map(
        buildGenome(inp, buildLedger(inp, settings))
          .byIntent.get('transactional')!
          .map((e) => [e.claim, e]),
      )
    })
    const truthVpi = (c: keyof typeof TRUTH.claims) => TRUTH.claims[c][0] * TRUTH.claims[c][1]
    const rate = (f: (m: Map<string, { status: string }>) => boolean) => runs.filter(f).length / runs.length

    it("almost never gets a claim's direction wrong", () => {
      let judged = 0
      let wrong = 0
      for (const m of runs)
        for (const [c, e] of m) {
          const t = truthVpi(c as keyof typeof TRUTH.claims)
          if (Math.abs(t - 1) < 0.05) continue
          judged++
          if ((t > 1 && e.status === 'loser') || (t < 1 && e.status === 'winner')) wrong++
        }
      // Each call is made at 95% confidence one-sided; wrong-direction calls must stay well under 5%.
      expect(wrong / judged).toBeLessThan(0.02)
    })

    it('has the power to find the planted winners and losers', () => {
      expect(rate((m) => m.get('risk_reversal')?.status === 'winner')).toBeGreaterThanOrEqual(0.9)
      expect(rate((m) => m.get('proof')?.status === 'winner')).toBeGreaterThanOrEqual(0.5)
      expect(rate((m) => m.get('feature')?.status === 'loser')).toBeGreaterThanOrEqual(0.5)
    })

    it('keeps false alarms on claims with no effect near the stated error rate', () => {
      expect(rate((m) => m.get('cta')?.status !== 'unclear')).toBeLessThanOrEqual(0.2)
      expect(rate((m) => m.get('specificity')?.status !== 'unclear')).toBeLessThanOrEqual(0.2)
    })
  })
})

describe('engine 3 — paid → organic transfer', () => {
  const genome = buildGenome(input, ledger)
  const rewrites = proposeRewrites(input, ledger, genome)

  it('proposes titles that fit the SERP and keep the keyword that ranks today', () => {
    expect(rewrites.length).toBeGreaterThan(2)
    for (const r of rewrites) {
      expect(titleFits(r.proposed.title)).toBe(true)
      expect(r.proposed.meta.length).toBeLessThanOrEqual(155)
      const head = r.current.title.split(/\s[|–—]\s/)[0]!
      expect(r.proposed.title.startsWith(head)).toBe(true)
      expect(r.proposed.claims).toContain(r.addedClaim.claim)
    }
  })

  it('never transfers urgency, calls to action, or clickbait', () => {
    for (const r of rewrites) {
      expect(NOT_TRANSFERABLE.has(r.addedClaim.claim)).toBe(false)
      expect(r.addedClaim.cvrLift).toBeGreaterThanOrEqual(0.97)
    }
  })

  it('leaves brand and login pages alone', () => {
    expect(rewrites.find((r) => r.url.endsWith('/login'))).toBeUndefined()
    expect(rewrites.find((r) => r.url.endsWith('.example/'))).toBeUndefined()
  })

  it('requires the page to substantiate proof, price and guarantee claims', () => {
    for (const r of rewrites)
      expect(r.substantiate.length > 0).toBe(NEEDS_SUBSTANTIATION.has(r.addedClaim.claim))
  })

  it("honours the workspace's banned terms", () => {
    const first = rewrites[0]!
    const phrase = first.proposed.title.split(/ [|—:] /)[1]!.toLowerCase()
    const strict = { ...input, bannedTerms: [phrase] }
    const again = proposeRewrites(strict, ledger, genome).find((r) => r.url === first.url)!
    expect(again.blocked).toMatch(/banned/)
  })
})

describe('engine 4 — intent drift', () => {
  const drifts = measureDrift(input, ledger, settings)
  const k5 = drifts.find((d) => d.keywordId === TRUTH.driftKeyword)!

  it('flags exactly the keyword that was planted to drift', () => {
    expect(drifts.filter((d) => d.flagged).map((d) => d.keywordId)).toEqual([TRUTH.driftKeyword])
    expect(k5.recent.careers).toBeGreaterThan(k5.baseline.careers + 0.1)
  })

  it('stays quiet on the control run with no drift planted', () => {
    const control = simulate({ drift: false })
    const d = measureDrift(control, buildLedger(control, settings), settings)
    expect(d.filter((x) => x.flagged)).toEqual([])
  })

  it('mines negatives and rejects any that would block a converting search', () => {
    const { accepted, rejected } = mineNegatives(input, ledger, k5, settings)
    const acc = accepted.map((a) => a.text)
    expect(acc).toEqual(expect.arrayContaining(['jobs', 'course', 'salary']))
    expect(acc).not.toContain('software')
    expect(acc).not.toContain('free')
    expect(rejected.map((r) => r.text)).toEqual(expect.arrayContaining(['software', 'free']))

    // The safety property itself: no accepted negative matches any search that ever converted.
    const converters = input.searchTerms
      .filter((r) => r.conversions > 0)
      .map((r) => r.searchTerm.toLowerCase())
    for (const neg of acc) for (const c of converters) expect(c.split(' ')).not.toContain(neg)
  })
})
