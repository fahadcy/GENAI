import { describe, expect, it } from './expect'
import {
  betaExpect,
  daysPerArm,
  jsDivergence,
  lgamma,
  normCdf,
  normInv,
  shrink,
  solve,
} from '../src/lib/serptwin/stats'
import { classifyIntent } from '../src/lib/serptwin/intent'
import { extractClaims } from '../src/lib/serptwin/claims'
import { SERP_LIMITS, textWidthPx, titleFits, trimToFit } from '../src/lib/serptwin/pixel'
import { formatMoney, queryKey, stableId, titleCase } from '../src/lib/serptwin/normalise'

describe('statistics', () => {
  it('normInv inverts normCdf across the range', () => {
    for (const p of [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) expect(normCdf(normInv(p))).toBeCloseTo(p, 6)
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5)
  })

  it('Jensen–Shannon is 0 for identical, 1 bit for disjoint, and symmetric', () => {
    expect(jsDivergence([1, 2, 3], [2, 4, 6])).toBeCloseTo(0, 12)
    expect(jsDivergence([1, 0], [0, 1])).toBeCloseTo(1, 12)
    expect(jsDivergence([0.7, 0.3], [0.2, 0.8])).toBeCloseTo(jsDivergence([0.2, 0.8], [0.7, 0.3]), 12)
  })

  it('shrinkage pulls small samples to the prior and leaves large ones alone', () => {
    expect(shrink(5, 30, 0.05, 2000).mean).toBeLessThan(0.06) // 16.7% observed on 30 impressions
    expect(shrink(16_700, 100_000, 0.05, 2000).mean).toBeGreaterThan(0.16)
  })

  it('sample size grows with noise and shrinks with effect', () => {
    expect(daysPerArm(100, 90, 1)).toBeLessThan(daysPerArm(100, 95, 1))
    expect(daysPerArm(100, 90, 2)).toBeGreaterThan(daysPerArm(100, 90, 1))
    expect(daysPerArm(100, 100)).toBe(Infinity)
  })

  it('lgamma and the Beta expectation agree with closed forms', () => {
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 10)
    expect(betaExpect((x) => x, 3, 7)).toBeCloseTo(0.3, 3) // mean of Beta(3,7)
  })

  it('solve returns the solution and the inverse', () => {
    const { x, inv } = solve(
      [
        [4, 1],
        [2, 3],
      ],
      [1, 2],
    )
    expect(x[0]).toBeCloseTo(0.1, 10)
    expect(x[1]).toBeCloseTo(0.6, 10)
    expect(inv[0]![0]).toBeCloseTo(0.3, 10)
  })
})

describe('intent classification', () => {
  const brand = ['cy group']
  const competitors = ['pipeloop']
  it.each([
    ['marketing automation jobs', 'careers'],
    ['cy group jobs', 'careers'], // careers wins over brand
    ['free marketing automation software', 'free_seeker'],
    ['free trial marketing automation', 'transactional'], // a trial is a buyer
    ['cy group login', 'navigational'],
    ['pipeloop alternative', 'commercial'], // a competitor's name is a comparison, not navigation to us
    ['best marketing automation tools', 'commercial'],
    ['email marketing best practices', 'informational'],
    ['how to set up lead scoring', 'informational'],
    ['marketing automation software pricing', 'transactional'],
  ])('%s → %s', (q, intent) => {
    expect(classifyIntent(q, brand, competitors).intent).toBe(intent)
  })
})

describe('claims', () => {
  it.each([
    ['Free 14-Day Trial', ['risk_reversal', 'specificity']],
    ['Cancel Anytime, No Contract', ['risk_reversal']],
    ['Trusted by 1,200+ Teams', ['proof', 'specificity']],
    ['Plans From £49/Month', ['price', 'specificity']],
    ['Limited Offer — Ends Friday', ['urgency']],
  ])('%s', (text, claims) => {
    expect(extractClaims(text)).toEqual(expect.arrayContaining(claims))
  })

  it("does not read B2B as a number or 'review and publish' as social proof", () => {
    expect(extractClaims('Built for B2B Marketing Teams')).not.toContain('specificity')
    expect(extractClaims('Generate, review and publish from one platform.')).not.toContain('proof')
  })
})

describe('SERP pixel widths', () => {
  it('measures by rendered width, not characters', () => {
    expect(textWidthPx('W'.repeat(30), 20)).toBeGreaterThan(textWidthPx('i'.repeat(30), 20) * 4)
    expect(titleFits('i'.repeat(60))).toBe(true)
    expect(titleFits('W'.repeat(60))).toBe(false)
  })

  it('trims on word boundaries and never leaves a dangling separator', () => {
    const t = trimToFit(
      'Marketing Automation Software for Growing B2B Teams | Trusted by Thousands of Marketers Worldwide',
      titleFits,
    )
    expect(titleFits(t)).toBe(true)
    expect(t).not.toMatch(/[|—–-]\.?$/)
    expect(textWidthPx(t, SERP_LIMITS.titleFontPx)).toBeLessThanOrEqual(SERP_LIMITS.titlePx)
  })
})

describe('normalisation', () => {
  it('folds paid and organic spellings to one key', () => {
    expect(queryKey('  Marketing   Automation, UK! ')).toBe(queryKey('marketing automation uk'))
  })
  it('title-cases with acronyms and small words', () => {
    expect(titleCase('ai tools for b2b teams')).toBe('AI Tools for B2B Teams')
  })
  it('formats money and ids deterministically', () => {
    expect(formatMoney(1234.5)).toBe('£1,235')
    expect(formatMoney(-12)).toBe('−£12')
    expect(stableId('a', 'b')).toBe(stableId('a', 'b'))
    expect(stableId('a', 'b')).not.toBe(stableId('b', 'a'))
  })
})
