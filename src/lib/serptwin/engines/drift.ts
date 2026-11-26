import type { Intent, Recommendation, SerpTwinInput, SerpTwinSettings } from '../types'
import { INTENTS } from '../types'
import type { Ledger } from '../ledger'
import { PAYABLE_INTENTS } from '../intent'
import { jsDivergence, normalise } from '../stats'
import { contentTokens, formatMoney, microsToMoney, pct, queryKey, stableId, tokens } from '../normalise'

/**
 * ENGINE 4 — Intent drift.
 *
 * A broad-match keyword is a contract with Google's matching system, and the
 * contract drifts. "marketing automation" bought for software buyers starts,
 * one quiet week, matching "marketing automation jobs" and "marketing
 * automation course". The search-terms report shows it; nobody reads it.
 *
 * The engine compares each keyword's intent mix in a baseline window with
 * the last `recentDays`, measures the shift (Jensen–Shannon divergence), and
 * when money is moving to intents a buyer campaign should not pay for:
 *   – mines negative keywords from the drifted terms, and checks each one
 *     against every search that ever converted in the account, so a negative
 *     can never block revenue;
 *   – routes informational demand to organic, where a guide can win the same
 *     searches for nothing — the cheaper channel for that intent.
 */

export interface KeywordDrift {
  keywordId: string
  keyword: string
  matchType: string
  campaignId: string
  baselineIntent: Intent
  baseline: Record<Intent, number>
  recent: Record<Intent, number>
  divergence: number
  offIntentShareBaseline: number
  offIntentShareRecent: number
  recentOffIntentCost: number
  emergingTerms: { term: string; intent: Intent; cost: number; clicks: number }[]
  flagged: boolean
}

export interface NegativeCandidate {
  text: string
  matchType: 'PHRASE'
  windowCost: number
  recentMonthlyCost: number
  termsBlocked: number
  examples: string[]
}

export interface RejectedNegative {
  text: string
  wouldBlock: { term: string; conversions: number }[]
}

export const DRIFT_THRESHOLDS = {
  divergence: 0.05,
  offShareRise: 0.08,
  minRecentOffCost: 20,
  minNegativeCost: 10,
}

const toRecord = (v: number[]): Record<Intent, number> =>
  Object.fromEntries(INTENTS.map((k, i) => [k, v[i] ?? 0])) as Record<Intent, number>

export function measureDrift(
  input: SerpTwinInput,
  ledger: Ledger,
  settings: SerpTwinSettings,
): KeywordDrift[] {
  const end = ledger.window.end
  if (!end) return []
  const recentStart = shiftDate(end, -(settings.recentDays - 1))
  const out: KeywordDrift[] = []

  for (const kw of input.keywords) {
    const rows = input.searchTerms.filter((r) => r.keywordId === kw.keywordId)
    if (rows.length === 0) continue
    const base = INTENTS.map(() => 0)
    const rec = INTENTS.map(() => 0)
    const baseCost = INTENTS.map(() => 0)
    const recCost = INTENTS.map(() => 0)
    const seenBefore = new Set<string>()
    const emerging = new Map<string, { intent: Intent; cost: number; clicks: number }>()

    for (const r of rows) {
      const k = queryKey(r.searchTerm)
      const intent = ledger.byKey.get(k)?.intent ?? 'commercial'
      const i = INTENTS.indexOf(intent)
      if (r.date < recentStart) {
        base[i]! += r.impressions
        baseCost[i]! += microsToMoney(r.costMicros)
        seenBefore.add(k)
      } else {
        rec[i]! += r.impressions
        recCost[i]! += microsToMoney(r.costMicros)
      }
    }
    for (const r of rows) {
      const k = queryKey(r.searchTerm)
      if (r.date < recentStart || seenBefore.has(k)) continue
      const e = emerging.get(k) ?? { intent: ledger.byKey.get(k)?.intent ?? 'commercial', cost: 0, clicks: 0 }
      e.cost += microsToMoney(r.costMicros)
      e.clicks += r.clicks
      emerging.set(k, e)
    }

    const baseIntent = INTENTS[base.indexOf(Math.max(...base))]!
    const off = (v: number[]) => {
      const t = v.reduce((a, b) => a + b, 0)
      return t > 0 ? INTENTS.reduce((s, it, i) => s + (PAYABLE_INTENTS.has(it) ? 0 : v[i]!), 0) / t : 0
    }
    const offBase = off(baseCost)
    const offRecent = off(recCost)
    const recentOffCost = INTENTS.reduce((s, it, i) => s + (PAYABLE_INTENTS.has(it) ? 0 : recCost[i]!), 0)
    const div = base.some((x) => x > 0) && rec.some((x) => x > 0) ? jsDivergence(base, rec) : 0

    out.push({
      keywordId: kw.keywordId,
      keyword: kw.text,
      matchType: kw.matchType,
      campaignId: kw.campaignId,
      baselineIntent: baseIntent,
      baseline: toRecord(normalise(base)),
      recent: toRecord(normalise(rec)),
      divergence: div,
      offIntentShareBaseline: offBase,
      offIntentShareRecent: offRecent,
      recentOffIntentCost: recentOffCost,
      emergingTerms: [...emerging.entries()]
        .map(([term, e]) => ({ term, ...e }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 12),
      flagged:
        div >= DRIFT_THRESHOLDS.divergence &&
        offRecent - offBase >= DRIFT_THRESHOLDS.offShareRise &&
        recentOffCost >= DRIFT_THRESHOLDS.minRecentOffCost,
    })
  }
  return out.sort((a, b) => b.recentOffIntentCost - a.recentOffIntentCost)
}

/**
 * Mine phrase negatives from drifted terms, then prove each is safe:
 * a negative that would have blocked any converting search is rejected and
 * the blocked searches are shown.
 */
export function mineNegatives(
  input: SerpTwinInput,
  ledger: Ledger,
  drift: KeywordDrift,
  settings: SerpTwinSettings,
): { accepted: NegativeCandidate[]; rejected: RejectedNegative[] } {
  const recentStart = shiftDate(ledger.window.end, -(settings.recentDays - 1))
  const kwTokens = new Set(tokens(drift.keyword))
  const campaignRows = input.searchTerms.filter((r) => r.campaignId === drift.campaignId)

  const driftedTerms = new Set(
    input.searchTerms
      .filter((r) => r.keywordId === drift.keywordId && r.date >= recentStart)
      .map((r) => queryKey(r.searchTerm))
      .filter((k) => !PAYABLE_INTENTS.has(ledger.byKey.get(k)?.intent ?? 'commercial')),
  )

  const candidates = new Set<string>()
  for (const t of driftedTerms)
    for (const tok of contentTokens(t)) if (!kwTokens.has(tok)) candidates.add(tok)

  // Every search that ever converted, anywhere in the account.
  const converters = new Map<string, number>()
  for (const r of input.searchTerms)
    if (r.conversions > 0)
      converters.set(queryKey(r.searchTerm), (converters.get(queryKey(r.searchTerm)) ?? 0) + r.conversions)

  const accepted: NegativeCandidate[] = []
  const rejected: RejectedNegative[] = []
  for (const tok of candidates) {
    const re = new RegExp(`(^|\\s)${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
    const matched = campaignRows.filter((r) => re.test(queryKey(r.searchTerm)))
    const cost = matched.reduce((s, r) => s + microsToMoney(r.costMicros), 0)
    if (cost < DRIFT_THRESHOLDS.minNegativeCost) continue
    const blocks = [...converters.entries()]
      .filter(([t]) => re.test(t))
      .map(([term, conversions]) => ({ term, conversions }))
    if (blocks.length > 0) {
      rejected.push({
        text: tok,
        wouldBlock: blocks.sort((a, b) => b.conversions - a.conversions).slice(0, 3),
      })
      continue
    }
    const recentCost = matched
      .filter((r) => r.date >= recentStart)
      .reduce((s, r) => s + microsToMoney(r.costMicros), 0)
    const terms = [...new Set(matched.map((r) => queryKey(r.searchTerm)))]
    accepted.push({
      text: tok,
      matchType: 'PHRASE',
      windowCost: cost,
      recentMonthlyCost: (recentCost * 30.4) / settings.recentDays,
      termsBlocked: terms.length,
      examples: terms.slice(0, 3),
    })
  }
  return { accepted: accepted.sort((a, b) => b.windowCost - a.windowCost), rejected }
}

export function driftRecommendations(
  input: SerpTwinInput,
  ledger: Ledger,
  drifts: KeywordDrift[],
  settings: SerpTwinSettings,
): Recommendation[] {
  const money = (n: number) => formatMoney(n, settings.currency)
  const recs: Recommendation[] = []

  for (const d of drifts.filter((x) => x.flagged)) {
    const { accepted, rejected } = mineNegatives(input, ledger, d, settings)
    if (accepted.length === 0 && rejected.length === 0) continue
    // Monthly waste: recent spend on terms any accepted negative would block, de-duplicated.
    const recentStart = shiftDate(ledger.window.end, -(settings.recentDays - 1))
    const res = accepted.map((a) => new RegExp(`(^|\\s)${a.text}(\\s|$)`))
    const blockedRecent = input.searchTerms
      .filter(
        (r) =>
          r.campaignId === d.campaignId &&
          r.date >= recentStart &&
          res.some((re) => re.test(queryKey(r.searchTerm))),
      )
      .reduce((s, r) => s + microsToMoney(r.costMicros), 0)
    const monthlySaving = (blockedRecent * 30.4) / settings.recentDays

    const info = ledger.entries
      .filter(
        (e) =>
          e.intent === 'informational' &&
          e.paid.keywordIds.includes(d.keywordId) &&
          (e.organic.position === null || e.organic.position > 10),
      )
      .sort((a, b) => b.paid.impressions - a.paid.impressions)

    const shifted = INTENTS.filter((i) => !PAYABLE_INTENTS.has(i) && d.recent[i] - d.baseline[i] > 0.03).map(
      (i) => `${i.replace('_', ' ')} ${pct(d.baseline[i])} → ${pct(d.recent[i])}`,
    )

    const actions: Recommendation['actions'] = []
    if (accepted.length) {
      const negatives = accepted.map((a) => ({
        text: a.text,
        matchType: a.matchType,
        campaignId: d.campaignId,
      }))
      actions.push({
        kind: 'add_negative_keywords',
        description: `Add ${accepted.length} phrase negatives to the campaign: ${accepted.map((a) => `“${a.text}”`).join(', ')}`,
        payload: { campaignId: d.campaignId, negatives },
        undo: { kind: 'remove_negative_keywords', campaignId: d.campaignId, negatives },
        requiresApproval: true,
      })
    }
    if (info.length) {
      actions.push({
        kind: 'create_content_brief',
        description: `Brief a guide for “${info[0]!.display}” — serve this demand organically instead of in the auction`,
        payload: {
          targetQuery: info[0]!.display,
          supporting: info.slice(1, 6).map((e) => e.display),
          intent: 'informational',
          reason: 'drift',
        },
        undo: null,
        requiresApproval: false,
      })
    }

    recs.push({
      id: `dr-${stableId(d.keywordId)}`,
      engine: 'drift',
      title: `“${d.keyword}” (${d.matchType.toLowerCase()}) has drifted away from buyers`,
      summary: `Over the last ${settings.recentDays} days this keyword's matched searches shifted (JS divergence ${d.divergence.toFixed(2)}): ${shifted.join('; ') || 'intent mix changed'}. Spend on searches a buyer campaign should not pay for went from ${pct(d.offIntentShareBaseline)} to ${pct(d.offIntentShareRecent)}. ${accepted.length} negatives would stop ${money(monthlySaving)}/month, each checked against every search that ever converted.${rejected.length ? ` ${rejected.length} tempting negative${rejected.length > 1 ? 's were' : ' was'} rejected because it would block revenue.` : ''}`,
      monthlyImpact: monthlySaving,
      confidence: 'measured',
      evidence: [
        { label: 'Baseline intent', value: d.baselineIntent },
        { label: 'JS divergence', value: d.divergence.toFixed(3) },
        {
          label: 'Off-intent spend share',
          value: `${pct(d.offIntentShareBaseline)} → ${pct(d.offIntentShareRecent)}`,
        },
        ...d.emergingTerms.slice(0, 3).map((t) => ({
          label: `New: “${t.term}”`,
          value: `${t.intent}, ${money(t.cost)}, ${t.clicks} clicks`,
        })),
        ...accepted.slice(0, 8).map((a) => ({
          label: `Negative “${a.text}”`,
          value: `blocks ${a.termsBlocked} search${a.termsBlocked === 1 ? '' : 'es'}, ${money(a.recentMonthlyCost)}/mo, 0 conversions`,
        })),
        ...rejected.slice(0, 3).map((r) => ({
          label: `Rejected “${r.text}”`,
          value: `would block ${r.wouldBlock.map((w) => `“${w.term}” (${w.conversions} conv)`).join(', ')}`,
        })),
      ],
      actions,
      assumptions: [
        'Saving is projected from the last two weeks of measured spend on the blocked searches, which recorded zero conversions.',
        'Phrase negatives are single words so they catch spelling variants the search-terms report has not shown yet.',
      ],
    })
  }
  return recs
}

export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
