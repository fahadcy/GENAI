import { describe, expect, it } from './expect'
import { runSerpTwin } from '../src/lib/serptwin'
import { simulate } from '../src/lib/serptwin/simulator'

const input = simulate()
const report = runSerpTwin(input)

describe('SERP Twin report', () => {
  it('is deterministic — same input, byte-identical report', () => {
    expect(JSON.stringify(runSerpTwin(simulate()))).toBe(JSON.stringify(report))
  })

  it('carries the simulated flag through to the report', () => {
    expect(report.simulated).toBe(true)
  })

  it('produces findings from all seven engines', () => {
    const engines = new Set(report.recommendations.map((r) => r.engine))
    expect([...engines].sort()).toEqual([
      'capacity',
      'demand',
      'drift',
      'genome',
      'leads',
      'overlap',
      'transfer',
    ])
  })

  it('gives every recommendation a unique, stable id', () => {
    const ids = report.recommendations.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ranks by confidence-weighted impact', () => {
    const w = { measured: 1, estimated: 0.7, hypothesis: 0.4 } as const
    const scores = report.recommendations.map((r) => r.monthlyImpact * w[r.confidence])
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!)
  })

  it('puts every action that touches money or a live page behind approval, with its undo captured', () => {
    const mutating = report.recommendations
      .flatMap((r) => r.actions)
      .filter(
        (a) =>
          a.kind !== 'create_content_brief' && a.kind !== 'keep_paid_coverage' && a.kind !== 'fix_follow_up',
      )
    expect(mutating.length).toBeGreaterThan(3)
    for (const a of mutating) {
      expect(a.requiresApproval).toBe(true)
      expect(a.undo).not.toBeNull()
    }
  })

  it('states its evidence and assumptions on every recommendation', () => {
    for (const r of report.recommendations) {
      expect(r.evidence.length).toBeGreaterThan(0)
      expect(r.assumptions.length).toBeGreaterThan(0)
      expect(Number.isFinite(r.monthlyImpact)).toBe(true)
    }
  })

  it('proposes Google-valid headlines only', () => {
    for (const a of report.recommendations.flatMap((r) => r.actions)) {
      const text =
        (a.payload as { addText?: string; text?: string }).addText ??
        (a.kind === 'pin_headline' ? (a.payload as { text: string }).text : undefined)
      if (text) expect(text.length).toBeLessThanOrEqual(30)
    }
  })

  it('runs an eight-week account in well under a second', () => {
    const t = performance.now()
    runSerpTwin(input)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
