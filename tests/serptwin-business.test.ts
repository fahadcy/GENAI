/**
 * Engines 5–7: why leads fail, spend against profit and capacity, SEO from
 * real demand. As with the ad engines, the tests check the engines recover
 * what the simulator planted, and that the safety rules hold on every row.
 */
import { describe, expect, it } from './expect'
import { runSerpTwin } from '../src/lib/serptwin'
import { simulate } from '../src/lib/serptwin/simulator'
import { BUSINESS_TRUTH, DEFAULT_BUSINESS } from '../src/lib/serptwin/business-sim'
import {
  classifyLead,
  diagnoseLeads,
  lostCategory,
  NOT_A_PROSPECT,
  workingHoursBetween,
} from '../src/lib/serptwin/engines/leads'
import { planBudgets } from '../src/lib/serptwin/engines/capacity'
import { prioritiseSeo, questionsIn } from '../src/lib/serptwin/engines/demand'
import type { Lead } from '../src/lib/serptwin/types'

const input = simulate()
const report = runSerpTwin(input)
const profile = DEFAULT_BUSINESS

const lead = (over: Partial<Lead>): Lead => ({
  id: 'T1',
  receivedAt: '2026-09-15T10:00:00Z', // Tuesday 11:00 BST
  source: 'ppc',
  adGroupId: 'ag_ma',
  searchTerm: 'marketing automation software',
  landingPage: 'https://www.cygroup.example/pricing',
  message: 'What does the price include?',
  location: { country: 'GB', area: 'M' },
  signals: { secondsToSubmit: 60, phoneValid: true },
  firstResponseAt: '2026-09-15T11:00:00Z',
  contactAttempts: 1,
  outcome: 'lost',
  lostReason: 'Too expensive',
  ...over,
})

describe('classifying one enquiry', () => {
  it('calls it spam on one strong signal or two weak ones, never on one weak one', () => {
    expect(classifyLead(lead({ signals: { honeypotFilled: true } }), profile).category).toBe('spam')
    expect(
      classifyLead(lead({ signals: { secondsToSubmit: 1, disposableEmail: true } }), profile).category,
    ).toBe('spam')
    expect(classifyLead(lead({ signals: { secondsToSubmit: 1 } }), profile).category).not.toBe('spam')
  })

  it('flags a wrong-service enquiry and says what matched', () => {
    const c = classifyLead(
      lead({ searchTerm: 'buy email list uk', message: 'Need an email list of HR directors' }),
      profile,
    )
    expect(c.category).toBe('wrong_service')
    expect(c.matchedPhrase).toBe('email list')
    expect(c.evidence.join(' ')).toMatch(/do not offer/)
  })

  it('flags enquiries from outside the service area', () => {
    expect(classifyLead(lead({ location: { country: 'US' } }), profile).category).toBe('out_of_area')
    expect(classifyLead(lead({ location: { country: 'IE' } }), profile).category).not.toBe('out_of_area')
  })

  it('never treats an unanswered phone as a bad lead', () => {
    const c = classifyLead(lead({ contactAttempts: 4, lostReason: 'No answer after 3 calls' }), profile)
    expect(c.category).toBe('unreachable')
    expect(NOT_A_PROSPECT.has(c.category)).toBe(false)
  })

  it('separates our failure to reply from their loss of interest', () => {
    expect(classifyLead(lead({ firstResponseAt: null, contactAttempts: 0 }), profile).category).toBe(
      'missed_follow_up',
    )
  })

  it('counts working hours, not clock hours: Friday 17:00 to Monday 10:00 is 1.5', () => {
    // 2026-09-18 is a Friday; BST, so 16:00Z is 17:00 local.
    expect(workingHoursBetween('2026-09-18T16:00:00Z', '2026-09-21T09:00:00Z')).toBeCloseTo(1.5, 1)
  })

  it('reads lost reasons in the salesperson’s own words', () => {
    expect(lostCategory('Went with Pipeloop, they were cheaper')).toBe('lost_competitor')
    expect(lostCategory('Onboarding fee put them off')).toBe('lost_price')
    expect(lostCategory('Not now, next quarter')).toBe('lost_timing')
    expect(lostCategory('')).toBe('lost_other')
  })
})

describe('engine 5 — why leads fail', () => {
  const d = diagnoseLeads(input, 56)!

  it('finds the ad group that attracts people wanting what you do not sell', () => {
    const rec = report.recommendations.find(
      (r) => r.id.startsWith('ld-wrong-') && r.title.startsWith('Managed campaigns'),
    )!
    expect(rec.confidence).toBe('measured')
    const neg = rec.actions.find((a) => a.kind === 'add_negative_keywords')!
    const words = (neg.payload.negatives as { text: string }[]).map((n) => n.text)
    expect(words).toEqual(expect.arrayContaining(['list', 'database']))
    expect(words).not.toContain('buy')
    // Safety: no proposed negative appears in any search that brought a real prospect.
    const good = d.classified
      .filter((c) => !NOT_A_PROSPECT.has(c.category) && c.lead.searchTerm)
      .map((c) => c.lead.searchTerm!.toLowerCase().split(' '))
    for (const w of words) for (const g of good) expect(g).not.toContain(w)
  })

  it('shows that late replies lose sales', () => {
    expect(d.winRateAnswered!).toBeGreaterThan((d.winRateMissed ?? 0) * 3)
    expect(report.recommendations.some((r) => r.id === 'ld-followup')).toBe(true)
  })

  it('catches the bot traffic hitting the form directly', () => {
    const rec = report.recommendations.find((r) => r.id.startsWith('ld-spam-'))!
    expect(rec.title).toMatch(/Direct/)
    expect(rec.summary).not.toMatch(/Google counts/)
  })

  it('sends Google only verified outcomes, and never an unknown as a bad one', () => {
    const byId = new Map(d.classified.map((c) => [c.lead.id, c]))
    expect(d.offlineRows.length).toBeGreaterThan(50)
    for (const row of d.offlineRows) {
      const c = byId.get(row.leadId)!
      expect(c.lead.gclid).toBe(row.gclid)
      expect(NOT_A_PROSPECT.has(c.category)).toBe(false)
      expect(['unreachable', 'open']).not.toContain(c.category)
      if (row.conversionName === 'Customer') expect(c.category).toBe('won')
    }
  })

  it(`plants most spam in ${BUSINESS_TRUTH.spamAdGroup} and the direct form, and finds it there`, () => {
    const unit = d.units.find((u) => u.key === 'src:direct')!
    expect((unit.counts.spam ?? 0) / unit.enquiries).toBeGreaterThan(0.8)
  })
})

describe('engine 6 — spend against profit and capacity', () => {
  const plans = report.budgets!
  const plan = (id: string) => plans.find((p) => p.serviceId === id)!

  it('eases off the service that is fully booked', () => {
    expect(plan(BUSINESS_TRUTH.fullyBookedService).decision).toBe('reduce')
    expect(plan(BUSINESS_TRUTH.fullyBookedService).reason).toMatch(/Fully booked/)
  })

  it('tests more on the profitable service with room', () => {
    expect(plan(BUSINESS_TRUTH.growService).decision).toBe('increase')
  })

  it('never moves a budget by more than the weekly limit', () => {
    for (const p of plans) {
      const change = Math.abs(p.proposedWeeklySpend - p.weeklySpend) / Math.max(1, p.weeklySpend)
      expect(change).toBeLessThanOrEqual(profile.maxWeeklyBudgetChange + 1e-9)
    }
  })

  it('responds to the business setup: book the managed team out and it eases off there too', () => {
    const changed = structuredClone(input)
    changed.business!.services.find((s) => s.id === 'managed')!.bookedThisWeek = 3
    const d = diagnoseLeads(changed, 56)!
    expect(planBudgets(changed, d, 56).find((p) => p.serviceId === 'managed')!.decision).toBe('reduce')
  })

  it('holds rather than moves money when few outcomes are known yet', () => {
    const thin = structuredClone(input)
    let kept = 0
    for (const l of thin.leads!) {
      if (l.adGroupId !== 'ag_managed') continue
      if (kept++ >= 3) {
        l.outcome = 'open'
        l.lostReason = null
      }
    }
    const d = diagnoseLeads(thin, 56)!
    const p = planBudgets(thin, d, 56).find((x) => x.serviceId === 'managed')!
    expect(p.decision).toBe('hold')
    expect(p.reason).toMatch(/Not enough/)
  })

  it('keeps brand out of service budgets', () => {
    for (const s of profile.services) expect(s.adGroupIds).not.toContain('ag_brand')
  })
})

describe('engine 7 — SEO from real demand', () => {
  const seo = report.seo!

  it('puts the planted pricing question on the platform page in this week’s three', () => {
    const top = seo.slice(0, 3)
    expect(top.some((a) => a.serviceId === BUSINESS_TRUTH.pricingTopicService && a.topic === 'pricing')).toBe(
      true,
    )
  })

  it('does not let one service take all three slots', () => {
    const top = seo.slice(0, 3)
    for (const s of new Set(top.map((a) => a.serviceId)))
      expect(top.filter((a) => a.serviceId === s).length).toBeLessThanOrEqual(2)
  })

  it('never quotes contact details in a draft', () => {
    expect(questionsIn('Call me on 07700 900123 or jo@firm.co.uk. What does it cost?').join(' ')).not.toMatch(
      /07700|jo@/,
    )
    for (const a of seo) for (const q of a.quotes) expect(q).not.toMatch(/@|\d{5,}/)
  })

  it('does not count "not now, next quarter" as a problem a page could fix', () => {
    for (const a of seo) expect(a.quotes).not.toContain('Lost: “Not now, looking again next quarter”')
  })

  it('marks every SEO recommendation as a hypothesis with its measurement plan', () => {
    for (const r of report.recommendations.filter((x) => x.engine === 'demand')) {
      expect(r.confidence).toBe('hypothesis')
      expect(r.assumptions.join(' ')).toMatch(/before and after/)
    }
  })
})

describe('over five simulated businesses', () => {
  const runs = [101, 202, 303, 404, 505].map((seed) => runSerpTwin(simulate({ seed })))
  it('finds the wrong-service ad group and the booked-out service every time', () => {
    for (const r of runs) {
      expect(
        r.recommendations.some(
          (x) => x.id.startsWith('ld-wrong-') && x.title.startsWith('Managed campaigns'),
        ),
      ).toBe(true)
      expect(r.budgets!.find((p) => p.serviceId === 'implementation')!.decision).toBe('reduce')
    }
  })
})
