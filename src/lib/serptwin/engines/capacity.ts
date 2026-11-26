import type { Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import type { LeadDiagnosis } from './leads'
import { NOT_A_PROSPECT } from './leads'
import { formatMoney, microsToMoney, pct, stableId } from '../normalise'
import { normInv } from '../stats'

/**
 * ENGINE 6 — Spend matched to profit and to what the team can deliver.
 *
 * Automated bidding moves money toward yesterday's cheapest enquiries. It
 * cannot know that installations are booked solid for three weeks while
 * repairs have slots tomorrow, or that one service earns four times another.
 * This engine combines four things per service — ad spend, real outcomes
 * from engine 5, profit per customer, and capacity this week — and proposes
 * a weekly budget move within a hard limit, for a person to approve.
 *
 * Small samples are the main danger: three good enquiries are not a trend.
 * Close rates are shrunk toward the business-wide rate, profit per pound is
 * reported with an interval, and a service with too little evidence is held
 * rather than moved.
 */

export type BudgetDecision = 'increase' | 'reduce' | 'hold'

export interface ServicePlan {
  serviceId: string
  name: string
  weeklySpend: number
  prospectsPerWeek: number
  decided: number
  won: number
  closeRate: number
  closeRateInterval: [number, number]
  marginPerCustomer: number
  /** Profit from new customers per £1 of ad spend, with a 90% interval. */
  profitPerPound: number | null
  profitPerPoundInterval: [number, number] | null
  weeklyCapacity: number | null
  bookedThisWeek: number
  spareCapacity: number | null
  expectedCustomersPerWeek: number
  decision: BudgetDecision
  proposedWeeklySpend: number
  reason: string
}

const PRIOR_STRENGTH = 8
const MIN_DECIDED = 6

export function planBudgets(input: SerpTwinInput, d: LeadDiagnosis, days: number): ServicePlan[] {
  const profile = input.business!
  const weeks = Math.max(1, days / 7)
  const max = profile.maxWeeklyBudgetChange

  const agCost = new Map<string, number>()
  for (const r of input.searchTerms)
    agCost.set(r.adGroupId, (agCost.get(r.adGroupId) ?? 0) + microsToMoney(r.costMicros))

  const decidedAll = d.classified.filter(
    (c) => !NOT_A_PROSPECT.has(c.category) && c.category !== 'open' && c.category !== 'unreachable',
  )
  const p0 = decidedAll.length
    ? decidedAll.filter((c) => c.category === 'won').length / decidedAll.length
    : 0.2

  const plans: ServicePlan[] = profile.services.map((s) => {
    const spend = s.adGroupIds.reduce((a, g) => a + (agCost.get(g) ?? 0), 0)
    const weeklySpend = spend / weeks
    // Only enquiries from this service's own ad groups: the same ad groups the spend is counted on.
    const mine = d.classified.filter(
      (c) =>
        c.lead.source === 'ppc' &&
        !!c.lead.adGroupId &&
        s.adGroupIds.includes(c.lead.adGroupId) &&
        !NOT_A_PROSPECT.has(c.category),
    )
    const decided = mine.filter((c) => c.category !== 'open' && c.category !== 'unreachable')
    const won = decided.filter((c) => c.category === 'won').length
    const a = won + PRIOR_STRENGTH * p0
    const b = decided.length - won + PRIOR_STRENGTH * (1 - p0)
    const mean = a / (a + b)
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)))
    const z = normInv(0.95)
    const ci: [number, number] = [Math.max(0, mean - z * sd), Math.min(1, mean + z * sd)]
    const prospectsPerWeek = mine.length / weeks
    const custPerWeek = prospectsPerWeek * mean
    const ppp = weeklySpend > 0 ? (custPerWeek * s.marginPerCustomer) / weeklySpend : null
    const pppCi: [number, number] | null =
      weeklySpend > 0
        ? [
            (prospectsPerWeek * ci[0] * s.marginPerCustomer) / weeklySpend,
            (prospectsPerWeek * ci[1] * s.marginPerCustomer) / weeklySpend,
          ]
        : null
    const spare = s.weeklyCapacity === null ? null : s.weeklyCapacity - s.bookedThisWeek

    let decision: BudgetDecision = 'hold'
    let change = 0
    let reason: string
    if (weeklySpend <= 0) {
      reason = 'No paid search spend on this service.'
    } else if (spare !== null && spare <= 0) {
      decision = 'reduce'
      change = -max
      reason = `Fully booked this week (${s.bookedThisWeek} of ${s.weeklyCapacity}). New enquiries would wait, and waiting loses them.`
    } else if (pppCi && pppCi[1] < 1) {
      decision = 'reduce'
      change = -max
      reason = `Loses money even at the optimistic end: at most ${formatMoney(pppCi[1])} profit per £1 of spend.`
    } else if (decided.length < MIN_DECIDED) {
      reason = `Only ${decided.length} enquiries with a known outcome. Not enough to move money on.`
    } else if (pppCi && pppCi[0] > 1.2 && (spare === null || spare > custPerWeek)) {
      decision = 'increase'
      const room = spare === null ? max : Math.min(max, spare / Math.max(custPerWeek, 0.01) - 1)
      change = Math.max(0.05, room)
      reason = `Profitable even at the cautious end (${formatMoney(pppCi[0])} per £1) with room for ${spare === null ? 'more customers' : `${spare} more customers this week`}.`
    } else {
      reason =
        ppp !== null
          ? `Returns ${formatMoney(ppp)} per £1, but not clearly enough to move money either way.`
          : 'No change.'
    }

    return {
      serviceId: s.id,
      name: s.name,
      weeklySpend,
      prospectsPerWeek,
      decided: decided.length,
      won,
      closeRate: mean,
      closeRateInterval: ci,
      marginPerCustomer: s.marginPerCustomer,
      profitPerPound: ppp,
      profitPerPoundInterval: pppCi,
      weeklyCapacity: s.weeklyCapacity,
      bookedThisWeek: s.bookedThisWeek,
      spareCapacity: spare,
      expectedCustomersPerWeek: custPerWeek,
      decision,
      proposedWeeklySpend: weeklySpend * (1 + change),
      reason,
    }
  })

  // Each move stays inside its own weekly limit. Reductions are listed first so the plan reads as
  // "move money from here to there"; the net change is reported, never hidden.
  return plans
}

export function capacityRecommendation(
  input: SerpTwinInput,
  plans: ServicePlan[],
  settings: SerpTwinSettings,
): Recommendation | null {
  const moves = plans.filter((p) => p.decision !== 'hold')
  if (moves.length === 0) return null
  const money = (n: number) => formatMoney(n, settings.currency)
  const profile = input.business!
  const campaignsOf = (serviceId: string) => {
    const s = profile.services.find((x) => x.id === serviceId)!
    return [
      ...new Set(input.adGroups.filter((g) => s.adGroupIds.includes(g.adGroupId)).map((g) => g.campaignId)),
    ]
  }
  // Weekly profit change: a cut on a booked-out service saves its spend (those customers could not
  // be served soon anyway); a cut on a loss-maker saves spend minus the profit it made; an increase
  // earns at the cautious end of its interval.
  const weekly = moves.reduce((s, p) => {
    const delta = p.proposedWeeklySpend - p.weeklySpend
    if (p.decision === 'reduce' && p.spareCapacity !== null && p.spareCapacity <= 0) return s - delta
    const rate = p.decision === 'increase' ? (p.profitPerPoundInterval?.[0] ?? 0) : (p.profitPerPound ?? 0)
    return s + delta * (rate - 1)
  }, 0)
  const net = moves.reduce((s, p) => s + p.proposedWeeklySpend - p.weeklySpend, 0)
  const reduce = moves.filter((p) => p.decision === 'reduce')
  const inc = moves.filter((p) => p.decision === 'increase')
  return {
    id: `cp-${stableId(...moves.map((m) => `${m.serviceId}:${m.decision}`))}`,
    engine: 'capacity',
    title: `This week: ${[
      ...reduce.map((p) => `ease off ${p.name}`),
      ...inc.map((p) => `test more on ${p.name}`),
    ].join(', ')}`,
    summary:
      `${reduce.map((p) => `${p.name}: ${p.reason}`).join(' ')} ${inc.map((p) => `${p.name}: ${p.reason}`).join(' ')} Each move is limited to ${pct(profile.maxWeeklyBudgetChange)} a week; net change ${net >= 0 ? '+' : '−'}${money(Math.abs(net))} a week. Look again next week with the new outcomes.`.trim(),
    monthlyImpact: Math.max(0, weekly * 4.33),
    confidence: 'estimated',
    evidence: plans.flatMap((p) => [
      {
        label: `${p.name}`,
        value: `${money(p.weeklySpend)}/wk → ${money(p.proposedWeeklySpend)}/wk · ${p.decided} outcomes, close rate ${pct(p.closeRate)} (${pct(p.closeRateInterval[0])}–${pct(p.closeRateInterval[1])})`,
      },
      {
        label: `${p.name}: profit per £1 · capacity`,
        value: `${p.profitPerPound === null ? '—' : `${money(p.profitPerPound)} (${money(p.profitPerPoundInterval![0])}–${money(p.profitPerPoundInterval![1])})`} · ${
          p.weeklyCapacity === null ? 'no limit' : `${p.bookedThisWeek}/${p.weeklyCapacity} booked`
        }`,
      },
    ]),
    actions: moves.map((p) => ({
      kind: 'adjust_budget' as const,
      description: `${p.decision === 'reduce' ? 'Reduce' : 'Increase'} ${p.name} spend from about ${money(p.weeklySpend)} to ${money(p.proposedWeeklySpend)} a week`,
      payload: {
        serviceId: p.serviceId,
        campaignIds: campaignsOf(p.serviceId),
        weeklyFrom: Math.round(p.weeklySpend),
        weeklyTo: Math.round(p.proposedWeeklySpend),
        dailyTo: Math.round((p.proposedWeeklySpend / 7) * 100) / 100,
      },
      undo: {
        serviceId: p.serviceId,
        campaignIds: campaignsOf(p.serviceId),
        dailyTo: Math.round((p.weeklySpend / 7) * 100) / 100,
      },
      requiresApproval: true,
    })),
    assumptions: [
      'Close rates are shrunk toward the business-wide rate, so a service with few outcomes is not judged on luck.',
      'Extra spend is assumed to return at most what current spend returns; in practice it usually returns less.',
      'Capacity and profit per customer come from Business setup. Update them weekly; the plan is only as good as they are.',
      'Brand campaigns should not be listed under a service: you cannot buy more searches for your own name.',
    ],
  }
}
