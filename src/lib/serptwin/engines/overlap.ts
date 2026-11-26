import type { Recommendation, SerpTwinSettings } from '../types'
import type { Ledger, LedgerEntry } from '../ledger'
import { monthly } from '../ledger'
import { PAYABLE_INTENTS } from '../intent'
import { ctrAt, type CtrCurve } from '../ctr'
import { betaExpect } from '../stats'
import { formatMoney, pct, round, stableId } from '../normalise'

/**
 * ENGINE 1 — Paid/organic overlap.
 *
 * The question nobody's reporting answers: of the clicks you are paying for,
 * how many would you have received anyway from your own organic listing?
 *
 * The prior comes from Google's own study of 446 pause events (Chan, Yuan,
 * Koehler & Kumar, "Impact of Ranking of Organic Search Results on the
 * Incrementality of Search Ads", 2012): when the advertiser ranks #1
 * organically, ~50% of ad clicks are incremental; at #2–4, ~82%; at #5+,
 * ~96%. A competitor on the same SERP lowers recapture, because pausing hands
 * them the top slot above your listing.
 *
 * That prior is an average across advertisers, so the engine never acts on
 * it. It prices the *test*: how much a pause experiment is expected to be
 * worth, and how long it must run to tell. The experiment replaces the prior
 * with this account's measured number.
 */

export type Verdict = 'harvest' | 'defend' | 'bridge' | 'gap' | 'hold'

export const VERDICT_LABEL: Record<Verdict, string> = {
  harvest: 'Harvest — test a pause',
  defend: 'Defend — keep paying',
  bridge: 'Bridge — paid covers while SEO climbs',
  gap: 'Gap — paid only, no organic page',
  hold: 'Hold — not enough signal',
}

export interface OverlapModel {
  /** Recapture at organic #1 with no competitor on the SERP. */
  r1: number
  /** Decay of recapture per organic position. */
  k: number
  /** How much a fully-overlapping competitor suppresses recapture. */
  competitorPenalty: number
  /** Beta prior concentration around the prior mean; low = honest uncertainty. */
  priorConcentration: number
  defendOverlap: number
}

export const DEFAULT_OVERLAP_MODEL: OverlapModel = {
  r1: 0.5,
  k: 0.5,
  competitorPenalty: 0.6,
  priorConcentration: 6,
  defendOverlap: 0.35,
}

export interface QueryVerdict {
  key: string
  display: string
  intent: LedgerEntry['intent']
  verdict: Verdict
  position: number | null
  competitorOverlap: number
  topCompetitor: string | null
  /** Prior share of paid clicks organic would recapture if the ad stopped. */
  recapturePrior: number
  /** Recapture at which pausing breaks even. >1 means it never pays. */
  breakEvenRecapture: number
  monthlyCost: number
  monthlyValue: number
  monthlyConversions: number
  /** Expected monthly gain from running the pause test and acting on it. */
  valueOfTest: number
  /** For bridge/gap: monthly value of reaching organic top 3. */
  organicUpside: number
  reason: string
}

/**
 * Probability of actually reaching the top three from where the page sits
 * now. SEO is not guaranteed; an upside that ignores the odds of getting it is
 * a sales figure, not an estimate. Halves every four positions of distance.
 */
export function attainability(position: number | null): number {
  if (position === null || position > 20) return 0.05 // consistent with #20 on the same curve
  return Math.min(1, Math.pow(0.5, Math.max(0, position - 3) / 4))
}

export function recapturePrior(
  position: number,
  competitorOverlap: number,
  m = DEFAULT_OVERLAP_MODEL,
): number {
  const base = m.r1 * Math.exp(-m.k * (Math.max(1, position) - 1))
  return base * (1 - m.competitorPenalty * Math.min(1, Math.max(0, competitorOverlap)))
}

/**
 * Expected monthly gain of running the test then pausing only if it pays:
 * E[max(0, cost − value·(1 − R))] with R ~ Beta around the prior mean.
 * Zero when no plausible recapture makes pausing pay.
 */
export function valueOfPauseTest(cost: number, value: number, prior: number, concentration: number): number {
  const mu = Math.min(0.97, Math.max(0.03, prior))
  const a = mu * concentration
  const b = (1 - mu) * concentration
  return betaExpect((r) => Math.max(0, cost - value * (1 - r)), a, b)
}

export function judgeQueries(
  ledger: Ledger,
  curve: CtrCurve,
  settings: SerpTwinSettings,
  model = DEFAULT_OVERLAP_MODEL,
): QueryVerdict[] {
  const days = ledger.window.days
  const out: QueryVerdict[] = []

  for (const e of ledger.entries) {
    if (e.paid.clicks === 0) continue
    const pos = e.organic.position
    const mCost = monthly(e.paid.cost, days)
    const mValue = monthly(e.paid.value, days)
    const mConv = monthly(e.paid.conversions, days)
    const r = pos === null ? 0 : recapturePrior(pos, e.competitorOverlap, model)
    const breakEven = mValue > 0 ? 1 - mCost / mValue : 0
    const valuePerClick = e.paid.clicks > 0 ? e.paid.value / e.paid.clicks : 0

    const base = {
      key: e.key,
      display: e.display,
      intent: e.intent,
      position: pos === null ? null : round(pos, 1),
      competitorOverlap: e.competitorOverlap,
      topCompetitor: e.topCompetitor,
      recapturePrior: r,
      breakEvenRecapture: breakEven,
      monthlyCost: mCost,
      monthlyValue: mValue,
      monthlyConversions: mConv,
      valueOfTest: 0,
      organicUpside: 0,
    }

    if (e.paid.clicks < settings.minQueryClicks || !PAYABLE_INTENTS.has(e.intent)) {
      out.push({
        ...base,
        verdict: 'hold',
        reason: !PAYABLE_INTENTS.has(e.intent)
          ? `${e.intent} intent — routed to the drift engine`
          : `${e.paid.clicks} paid clicks in the window; judged at ${settings.minQueryClicks}`,
      })
      continue
    }

    if (pos === null || pos > 20) {
      const volume = monthly(Math.max(e.paid.impressions, e.organic.impressions), days)
      const upside = volume * ctrAt(curve, 3) * valuePerClick * attainability(pos)
      out.push({
        ...base,
        verdict: e.paid.conversions > 0 ? 'gap' : 'hold',
        organicUpside: e.paid.conversions > 0 ? upside : 0,
        reason:
          pos === null
            ? 'The site never appears organically for this search'
            : `Organic position ${pos.toFixed(1)} — off page two`,
      })
      continue
    }

    if (pos <= 3.5) {
      if (e.competitorOverlap >= model.defendOverlap) {
        out.push({
          ...base,
          verdict: 'defend',
          reason: `${e.topCompetitor ?? 'A competitor'} shows on ${pct(e.competitorOverlap)} of these auctions — pausing hands them the slot above your listing`,
        })
        continue
      }
      const vot = valueOfPauseTest(mCost, mValue, r, model.priorConcentration)
      if (breakEven < 0.95 && vot >= 1) {
        out.push({
          ...base,
          verdict: 'harvest',
          valueOfTest: vot,
          reason: `Organic #${pos.toFixed(1)}, no strong competitor. Pausing pays if ≥${pct(Math.max(0, breakEven))} of clicks come back organically`,
        })
      } else {
        out.push({
          ...base,
          verdict: 'defend',
          reason: `Paid returns ${(mValue / Math.max(mCost, 0.01)).toFixed(1)}× cost — would need ${pct(Math.min(1, breakEven))} recapture to justify a pause`,
        })
      }
      continue
    }

    const orgImpr = monthly(e.organic.impressions, days)
    const upside =
      orgImpr * Math.max(0, ctrAt(curve, 3) - ctrAt(curve, pos)) * valuePerClick * attainability(pos)
    out.push({
      ...base,
      verdict: 'bridge',
      organicUpside: upside,
      reason: `Organic #${pos.toFixed(1)}: close enough to lift, too low to rely on`,
    })
  }

  return out.sort((a, b) => b.monthlyCost - a.monthlyCost)
}

// ───────────────────────────── Recommendations

export function overlapRecommendations(
  verdicts: QueryVerdict[],
  settings: SerpTwinSettings,
  notOffered: string[] = [],
): Recommendation[] {
  const money = (n: number) => formatMoney(n, settings.currency)
  const recs: Recommendation[] = []
  // A search for something the business does not sell needs a negative, not a page.
  const offered = (q: string) =>
    !notOffered.some((n) => new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q.toLowerCase()))

  // Harvest → handled by the experiment designer (needs daily series), see experiment.ts.

  const gaps = verdicts.filter((v) => v.verdict === 'gap' && offered(v.display)).sort((a, b) => b.organicUpside - a.organicUpside)
  for (const g of gaps.slice(0, 6)) {
    recs.push({
      id: `ov-gap-${stableId(g.key)}`,
      engine: 'overlap',
      title: `No organic page for “${g.display}”`,
      summary: `You pay ${money(g.monthlyCost)}/month for this search and it converts, but the site does not rank for it at all. A page reaching the top three would earn an estimated ${money(g.organicUpside)}/month in organic value.`,
      monthlyImpact: g.organicUpside,
      confidence: 'estimated',
      evidence: [
        { label: 'Paid spend', value: `${money(g.monthlyCost)}/mo` },
        { label: 'Paid conversions', value: `${g.monthlyConversions.toFixed(1)}/mo` },
        { label: 'Organic position', value: g.position === null ? 'not ranking' : g.position.toFixed(1) },
        { label: 'Intent', value: g.intent },
      ],
      actions: [
        {
          kind: 'create_content_brief',
          description: `Draft a page brief targeting “${g.display}” in Content Studio`,
          payload: { targetQuery: g.display, intent: g.intent, reason: 'gap' },
          undo: null,
          requiresApproval: false,
        },
        {
          kind: 'keep_paid_coverage',
          description: 'Keep paid coverage until the page ranks — this is the rent SEO will stop paying',
          payload: { query: g.key },
          undo: null,
          requiresApproval: false,
        },
      ],
      assumptions: [
        'Search volume is taken from paid impressions, a floor on the true volume.',
        'Organic value per click is assumed equal to paid value per click for the same search.',
        "Top-three CTR is read from this site's own fitted CTR curve.",
        `Risk-adjusted: a new page is given a ${pct(attainability(null))} chance of reaching the top three.`,
      ],
    })
  }

  const bridgeList = verdicts
    .filter((v) => v.verdict === 'bridge')
    .sort((a, b) => b.organicUpside - a.organicUpside)
  for (const b of bridgeList.slice(0, 6)) {
    if (b.organicUpside < 10) continue
    recs.push({
      id: `ov-bridge-${stableId(b.key)}`,
      engine: 'overlap',
      title: `Lift “${b.display}” from organic #${b.position?.toFixed(0)} into the top three`,
      summary: `Paid is holding the line (${money(b.monthlyCost)}/month) while the page sits at #${b.position?.toFixed(1)}. Reaching the top three is worth an estimated ${money(b.organicUpside)}/month, and once there the paid spend becomes a pause-test candidate.`,
      monthlyImpact: b.organicUpside,
      confidence: 'estimated',
      evidence: [
        { label: 'Organic position', value: b.position!.toFixed(1) },
        { label: 'Paid spend', value: `${money(b.monthlyCost)}/mo` },
        { label: 'Competitor overlap', value: pct(b.competitorOverlap) },
      ],
      actions: [
        {
          kind: 'create_content_brief',
          description: `Optimisation brief for the ranking page, targeting “${b.display}”`,
          payload: { targetQuery: b.display, intent: b.intent, reason: 'bridge' },
          undo: null,
          requiresApproval: false,
        },
      ],
      assumptions: [
        "Top-three CTR from the site's fitted curve.",
        'Value per organic click equals value per paid click.',
        `Risk-adjusted: ${pct(attainability(b.position))} chance of reaching the top three from #${b.position?.toFixed(0)} (halves every four positions).`,
      ],
    })
  }

  const defends = verdicts.filter((v) => v.verdict === 'defend')
  if (defends.length) {
    const spend = defends.reduce((s, d) => s + d.monthlyCost, 0)
    const value = defends.reduce((s, d) => s + d.monthlyValue, 0)
    recs.push({
      id: 'ov-defend',
      engine: 'overlap',
      title: `${defends.length} searches where you rank well and should keep paying anyway`,
      summary: `Ranking well is not a reason to stop bidding on these. Either a competitor would take the slot above you, or the ads return so much that no realistic organic recapture justifies a pause. ${money(spend)}/month protecting ${money(value)}/month.`,
      monthlyImpact: 0,
      confidence: 'estimated',
      evidence: defends.slice(0, 5).map((d) => ({ label: d.display, value: d.reason })),
      actions: [
        {
          kind: 'keep_paid_coverage',
          description: 'No change — recorded so the next review does not re-litigate it',
          payload: { queries: defends.map((d) => d.key) },
          undo: null,
          requiresApproval: false,
        },
      ],
      assumptions: ['Competitor overlap is read from auction insights on the matching keywords.'],
    })
  }

  return recs
}
