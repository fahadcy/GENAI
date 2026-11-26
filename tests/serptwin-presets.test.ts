/** The Easy Liquidation account: real site facts, simulated numbers, sensible findings. */
import { describe, expect, it } from './expect'
import { runSerpTwin } from '../src/lib/serptwin'
import { simulate } from '../src/lib/serptwin/simulator'
import { extractClaims } from '../src/lib/serptwin/claims'

const input = simulate({ preset: 'easy-liquidation' })
const r = runSerpTwin(input)

describe('Easy Liquidation preset', () => {
  it('says what is real and what is simulated', () => {
    expect(r.simulated).toBe(true)
    expect(r.dataNote!).toMatch(/simulated/)
  })

  it('finds the shared title across the site and names pages from their H1', () => {
    const dup = r.recommendations.find((x) => x.id.startsWith('tr-dup-'))!
    const titles = dup.actions.map((a) => a.payload.title as string)
    expect(titles).toContain('Do I Need to Liquidate My Company? | Easy Liquidation')
    expect(dup.actions.every((a) => a.requiresApproval)).toBe(true)
    // The home page keeps its title and no page gets an invented one.
    expect(dup.actions.some((a) => new URL(a.payload.url as string).pathname === '/')).toBe(false)
  })

  it('does not suggest pages for things the firm does not offer', () => {
    for (const x of r.recommendations.filter((x) => x.title.startsWith('No organic page')))
      expect(x.title).not.toMatch(/personal debt|iva|debt management/)
  })

  it('flags the broad business-debt ad group for wrong-service enquiries', () => {
    expect(r.recommendations.some((x) => x.id.startsWith('ld-wrong-') && /Business debt/.test(x.title))).toBe(true)
  })

  it('eases off the fully booked winding-up service and tests more MVL', () => {
    expect(r.budgets!.find((p) => p.serviceId === 'winding_up')!.decision).toBe('reduce')
    expect(r.budgets!.find((p) => p.serviceId === 'mvl')!.decision).toBe('increase')
  })

  it('reads insolvency claims', () => {
    expect(extractClaims('Free Confidential Consultation')).toContain('risk_reversal')
    expect(extractClaims('IPA & R3 Members')).toContain('authority')
    expect(extractClaims("30+ Years' Experience")).toContain('authority')
    expect(extractClaims('ipad cases')).not.toContain('authority')
  })

  it('keeps every ad headline within 30 characters', () => {
    for (const a of input.assets.filter((x) => x.field === 'HEADLINE')) expect(a.text.length).toBeLessThanOrEqual(30)
  })
})
