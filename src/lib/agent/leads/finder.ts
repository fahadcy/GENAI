/**
 * Find companies that are leads for this business, best first.
 *
 *   candidates  ← Gazette petitions (strongest signal) + Companies House
 *                 advanced search over the business's target sectors/areas
 *   cheap filter← search results already say status and type: drop the
 *                 inactive and non-corporate before spending API calls
 *   enrich      ← full profile + officers (2 calls per company, rate-limited)
 *   exclude     ← hard no's (already in CRM, suppressed, in insolvency…)
 *   score       ← need signals + what has converted before
 *
 * Bounded by maxEnrich so a run costs a known number of API calls.
 */
import type { CompaniesHousePort, ChSearchItem, ChProfile } from './companiesHouse';
import { CORPORATE_TYPES, normCompanyNumber } from './companiesHouse';
import type { GazetteNotice } from './gazette';
import { commitEvidence, exclusions, needSignals, scoreCompany, type FitModel, type FitResult } from './fit';
import type { EvidenceStore } from '../types';

export interface FinderTargets {
  sicCodes?: string[];            // 5-digit SIC codes to search
  locations?: string[];           // free text, as Companies House's location filter
  incorporatedFrom?: string;      // YYYY-MM-DD
  incorporatedTo?: string;
  excludedSections?: string[];    // SIC section letters the business won't take
}
export interface FinderInput {
  ch: CompaniesHousePort;
  petitions?: GazetteNotice[];
  targets: FinderTargets;
  model: FitModel | null;
  knownCompanyNumbers: Set<string>;
  suppressed: Set<string>;
  store: EvidenceStore;
  now: Date;
  maxEnrich?: number;             // default 60 companies → ≤120 API calls
  minScore?: number;              // default 45 (warm)
  limit?: number;                 // default 25
}
export interface FinderResult {
  leads: FitResult[];
  stats: { candidates: number; enriched: number; excluded: Record<string, number>; belowThreshold: number; apiCalls: number };
}

export async function findLeads(i: FinderInput): Promise<FinderResult> {
  const maxEnrich = i.maxEnrich ?? 60;
  const stats: FinderResult['stats'] = { candidates: 0, enriched: 0, excluded: {}, belowThreshold: 0, apiCalls: 0 };
  const bump = (why: string) => { stats.excluded[why] = (stats.excluded[why] ?? 0) + 1; };

  // 1. Candidates, petitions first (they jump the queue).
  const queue: { number: string; petition: GazetteNotice | null; item?: ChSearchItem }[] = [];
  const seen = new Set<string>();
  const petitionsByNumber = new Map<string, GazetteNotice>();
  for (const n of i.petitions ?? []) {
    if (!n.companyNumber) continue;
    const num = normCompanyNumber(n.companyNumber);
    petitionsByNumber.set(num, n);
    if (!seen.has(num)) { seen.add(num); queue.push({ number: num, petition: n }); }
  }
  const t = i.targets;
  const searches = (t.locations?.length ? t.locations : [undefined]).map(location => ({ location }));
  if (t.sicCodes?.length || t.locations?.length) {
    for (const s of searches) {
      if (queue.length >= maxEnrich * 3) break;
      const r = await i.ch.advancedSearch({ sicCodes: t.sicCodes, location: s.location, incorporatedFrom: t.incorporatedFrom, incorporatedTo: t.incorporatedTo, size: 200 });
      stats.apiCalls++;
      for (const it of r.items) {
        const num = normCompanyNumber(it.company_number);
        if (seen.has(num)) continue;
        seen.add(num);
        queue.push({ number: num, petition: petitionsByNumber.get(num) ?? null, item: it });
      }
    }
  }
  stats.candidates = queue.length;

  // 2. Cheap filter on what the search already told us.
  const toEnrich = queue.filter(c => {
    if (i.knownCompanyNumbers.has(c.number)) { bump('Already in the CRM'); return false; }
    if (i.suppressed.has(c.number)) { bump('On the suppression list'); return false; }
    if (c.item && c.item.company_status !== 'active') { bump('Not active'); return false; }
    if (c.item && !CORPORATE_TYPES.has(c.item.company_type)) { bump('Not a corporate body (PECR)'); return false; }
    return true;
  }).slice(0, maxEnrich);

  // 3–5. Enrich, exclude, score.
  const scored: FitResult[] = [];
  for (const c of toEnrich) {
    const p: ChProfile | null = await i.ch.profile(c.number); stats.apiCalls++;
    if (!p) { bump('Not found at Companies House'); continue; }
    const ex = exclusions(p, { knownCompanyNumbers: i.knownCompanyNumbers, suppressed: i.suppressed, excludedSections: new Set(t.excludedSections ?? []) });
    if (ex.length) { bump(ex[0]!); continue; }
    const officers = await i.ch.officers(c.number); stats.apiCalls++;
    stats.enriched++;
    const r = scoreCompany(p, needSignals(p, officers, c.petition, i.now), i.model, i.now);
    if (r.score < (i.minScore ?? 45)) { stats.belowThreshold++; continue; }
    scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score || a.companyName.localeCompare(b.companyName));
  return { leads: scored.slice(0, i.limit ?? 25).map(r => commitEvidence(r, i.store)), stats };
}
