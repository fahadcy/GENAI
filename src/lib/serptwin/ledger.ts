import type { Intent, SerpTwinInput, SerpTwinSettings } from './types'
import { classifyIntent } from './intent'
import { microsToMoney, queryKey } from './normalise'

/**
 * The query ledger: one row per real search, with its paid life and its
 * organic life side by side. Nothing else in the platform — nor in Google
 * Ads or Search Console — shows these two on one line, and every engine
 * below reads from it.
 */

export interface PaidSide {
  impressions: number
  clicks: number
  cost: number
  conversions: number
  value: number
  keywordIds: string[]
  adGroupIds: string[]
  campaignIds: string[]
}

export interface OrganicSide {
  impressions: number
  clicks: number
  /** Impression-weighted average position; `null` when the site never appeared. */
  position: number | null
  topPage: string | null
}

export interface LedgerEntry {
  key: string
  display: string
  intent: Intent
  intentRule: string
  paid: PaidSide
  organic: OrganicSide
  /** Highest competitor overlap on the keywords that matched this query (0–1). */
  competitorOverlap: number
  topCompetitor: string | null
}

export interface Ledger {
  entries: LedgerEntry[]
  byKey: Map<string, LedgerEntry>
  window: { start: string; end: string; days: number }
  competitorTerms: string[]
}

export function competitorTermsFrom(input: SerpTwinInput): string[] {
  const set = new Set<string>()
  for (const a of input.auction) {
    const stem = a.competitorDomain.replace(/^www\./, '').split('.')[0]
    if (stem && stem.length > 2) set.add(stem.replace(/-/g, ' '))
  }
  return [...set]
}

export function buildLedger(input: SerpTwinInput, settings: SerpTwinSettings): Ledger {
  const competitorTerms = competitorTermsFrom(input)
  const map = new Map<
    string,
    LedgerEntry & {
      _spell: Map<string, number>
      _kw: Set<string>
      _ag: Set<string>
      _cmp: Set<string>
      _posW: number
      _pages: Map<string, number>
    }
  >()
  const dates = new Set<string>()

  const get = (raw: string) => {
    const key = queryKey(raw)
    let e = map.get(key)
    if (!e) {
      const ir = classifyIntent(key, input.brand.terms, competitorTerms)
      e = {
        key,
        display: raw,
        intent: ir.intent,
        intentRule: ir.rule,
        paid: {
          impressions: 0,
          clicks: 0,
          cost: 0,
          conversions: 0,
          value: 0,
          keywordIds: [],
          adGroupIds: [],
          campaignIds: [],
        },
        organic: { impressions: 0, clicks: 0, position: null, topPage: null },
        competitorOverlap: 0,
        topCompetitor: null,
        _spell: new Map(),
        _kw: new Set(),
        _ag: new Set(),
        _cmp: new Set(),
        _posW: 0,
        _pages: new Map(),
      }
      map.set(key, e)
    }
    e._spell.set(raw, (e._spell.get(raw) ?? 0) + 1)
    return e
  }

  for (const r of input.searchTerms) {
    dates.add(r.date)
    const e = get(r.searchTerm)
    e.paid.impressions += r.impressions
    e.paid.clicks += r.clicks
    e.paid.cost += microsToMoney(r.costMicros)
    e.paid.conversions += r.conversions
    e.paid.value +=
      r.conversionValue > 0 ? r.conversionValue : r.conversions * settings.fallbackValuePerConversion
    e._kw.add(r.keywordId)
    e._ag.add(r.adGroupId)
    e._cmp.add(r.campaignId)
  }

  for (const r of input.organic) {
    dates.add(r.date)
    const e = get(r.query)
    e.organic.impressions += r.impressions
    e.organic.clicks += r.clicks
    e._posW += r.position * r.impressions
    e._pages.set(r.page, (e._pages.get(r.page) ?? 0) + r.clicks + r.impressions * 1e-6)
  }

  // Auction overlap per keyword: the strongest competitor on that keyword.
  const kwOverlap = new Map<string, { rate: number; domain: string }>()
  for (const a of input.auction) {
    const cur = kwOverlap.get(a.keywordId)
    if (!cur || a.overlapRate > cur.rate)
      kwOverlap.set(a.keywordId, { rate: a.overlapRate, domain: a.competitorDomain })
  }

  const entries: LedgerEntry[] = []
  for (const e of map.values()) {
    e.display = [...e._spell.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    e.paid.keywordIds = [...e._kw]
    e.paid.adGroupIds = [...e._ag]
    e.paid.campaignIds = [...e._cmp]
    if (e.organic.impressions > 0) {
      e.organic.position = e._posW / e.organic.impressions
      e.organic.topPage = [...e._pages.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    }
    for (const k of e.paid.keywordIds) {
      const o = kwOverlap.get(k)
      if (o && o.rate > e.competitorOverlap) {
        e.competitorOverlap = o.rate
        e.topCompetitor = o.domain
      }
    }
    const { _spell, _kw, _ag, _cmp, _posW, _pages, ...clean } = e
    entries.push(clean)
  }

  const sorted = [...dates].sort()
  const days = sorted.length
  return {
    entries,
    byKey: new Map(entries.map((e) => [e.key, e])),
    window: { start: sorted[0] ?? '', end: sorted[sorted.length - 1] ?? '', days },
    competitorTerms,
  }
}

/** Scale a window total to a 30.4-day month. */
export function monthly(total: number, days: number): number {
  return days > 0 ? (total * 30.4) / days : 0
}
