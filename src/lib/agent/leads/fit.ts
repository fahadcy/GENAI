/**
 * "Is this company a lead for ME?" — two parts, both arithmetic:
 *
 * 1. NEED. Public signs of financial pressure from Companies House and The
 *    Gazette, each worth a fixed number of log-odds. The weights are set by
 *    hand from how insolvency practices describe their pipeline (a petition
 *    outweighs a late confirmation statement); they are in one table so the
 *    team can argue with them.
 *
 * 2. FIT. What has actually converted for this business, learned from the
 *    CRM's won/lost history: win rate by sector, company age and area, each
 *    shrunk towards the overall rate (beta-binomial, k = 10 pseudo-leads) so
 *    three lucky wins don't make a sector "hot". Shown in plain words:
 *    "Construction: 12 of 31 won (39%) vs 21% overall".
 *
 * Score = sigmoid(base + need + fit) × 100. A company with no sign of need is
 * capped at 30: a good-looking sector is not a reason to approach a healthy
 * company about liquidation.
 *
 * Caveat, stated in the UI: CRM outcomes come from people who contacted the
 * business themselves; cold leads convert differently. The learned part is
 * a tilt, not a forecast.
 */
import type { ChOfficer, ChProfile } from './companiesHouse';
import { CH_WEB, CORPORATE_TYPES, sicSection, sectionName } from './companiesHouse';
import type { GazetteNotice } from './gazette';
import type { Outcome } from '../crm/client';
import type { Evidence, EvidenceStore } from '../types';

export interface Signal { key: string; weight: number; label: string; url?: string; values?: Evidence['values'] }

export const SIGNAL_WEIGHTS = {
  winding_up_petition: 2.6,
  strike_off_proposed: 0.9,
  accounts_overdue: 0.8,
  accounts_overdue_long: 0.3,      // extra when > 90 days
  confirmation_overdue: 0.5,
  director_resigned_recently: 0.4,
  charges_registered: 0.3,
  small_company_accounts: 0.2,
  dormant: -1.5,
  large_company_accounts: -0.6,
} as const;
const NEED_KEYS = new Set(['winding_up_petition', 'strike_off_proposed', 'accounts_overdue', 'confirmation_overdue', 'director_resigned_recently']);
const BASE_LOGIT = -2.2;
const NO_NEED_CAP = 30;

const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / 86_400_000);

export function needSignals(p: ChProfile, officers: ChOfficer[], petition: GazetteNotice | null, now: Date): Signal[] {
  const s: Signal[] = [];
  const url = CH_WEB + p.company_number;
  if (petition) {
    s.push({ key: 'winding_up_petition', weight: SIGNAL_WEIGHTS.winding_up_petition, url: petition.url,
      label: `Winding-up petition published in The Gazette on ${petition.published.slice(0, 10)}` + (petition.hearingDate ? `, hearing ${petition.hearingDate}` : ''),
      values: { published: petition.published.slice(0, 10), hearing: petition.hearingDate } });
  }
  if (p.company_status_detail === 'active-proposal-to-strike-off') {
    s.push({ key: 'strike_off_proposed', weight: SIGNAL_WEIGHTS.strike_off_proposed, url, label: 'Companies House has proposed striking the company off the register' });
  }
  if (p.accounts?.overdue && p.accounts.next_due) {
    const d = daysBetween(now, new Date(p.accounts.next_due));
    s.push({ key: 'accounts_overdue', weight: SIGNAL_WEIGHTS.accounts_overdue, url, label: `Accounts overdue by ${d} days (were due ${p.accounts.next_due})`, values: { days_overdue: d } });
    if (d > 90) s.push({ key: 'accounts_overdue_long', weight: SIGNAL_WEIGHTS.accounts_overdue_long, url, label: `Accounts more than 90 days late`, values: { days_overdue: d } });
  }
  if (p.confirmation_statement?.overdue) {
    s.push({ key: 'confirmation_overdue', weight: SIGNAL_WEIGHTS.confirmation_overdue, url, label: `Confirmation statement overdue (was due ${p.confirmation_statement.next_due ?? 'unknown'})` });
  }
  const resigned = officers.filter(o => o.resigned_on && /director/i.test(o.officer_role) && daysBetween(now, new Date(o.resigned_on)) <= 120);
  if (resigned.length) {
    s.push({ key: 'director_resigned_recently', weight: SIGNAL_WEIGHTS.director_resigned_recently, url: url + '/officers',
      label: `${resigned.length} director${resigned.length > 1 ? 's' : ''} resigned in the last 120 days`, values: { resigned: resigned.length } });
  }
  if (p.has_charges) s.push({ key: 'charges_registered', weight: SIGNAL_WEIGHTS.charges_registered, url: url + '/charges', label: 'Has charges registered (secured lending)' });
  const t = (p.accounts?.last_accounts?.type ?? '').toLowerCase();
  if (t === 'dormant') s.push({ key: 'dormant', weight: SIGNAL_WEIGHTS.dormant, url, label: 'Last accounts were dormant: usually a strike-off, not a liquidation' });
  else if (['micro-entity', 'total-exemption-full', 'total-exemption-small', 'small', 'unaudited-abridged', 'audit-exemption-subsidiary'].includes(t)) {
    s.push({ key: 'small_company_accounts', weight: SIGNAL_WEIGHTS.small_company_accounts, url, label: `Small company (${t} accounts), the size a fixed-fee service suits` });
  } else if (['full', 'group', 'medium'].includes(t)) {
    s.push({ key: 'large_company_accounts', weight: SIGNAL_WEIGHTS.large_company_accounts, url, label: `Files ${t} accounts: larger than a fixed-fee case` });
  }
  return s;
}

/** Hard no's. Any of these and the company is not offered at all. */
export function exclusions(p: ChProfile, ctx: { knownCompanyNumbers: Set<string>; suppressed: Set<string>; excludedSections?: Set<string> }): string[] {
  const why: string[] = [];
  if (p.company_status !== 'active') why.push(`Status is ${p.company_status}`);
  if (p.has_insolvency_history && p.company_status !== 'active') why.push('Already in an insolvency process');
  if (!CORPORATE_TYPES.has(p.type)) why.push(`Company type ${p.type} is not a corporate body (PECR)`);
  if (p.jurisdiction && p.jurisdiction === 'northern-ireland') why.push('Northern Ireland: different insolvency regime');
  if (ctx.knownCompanyNumbers.has(p.company_number)) why.push('Already in the CRM');
  if (ctx.suppressed.has(p.company_number)) why.push('On the suppression list');
  const secs = (p.sic_codes ?? []).map(c => sicSection(c)?.letter).filter(Boolean) as string[];
  if (ctx.excludedSections && secs.length && secs.every(l => ctx.excludedSections!.has(l))) why.push('Sector excluded by the business');
  return why;
}

// ── Learning from outcomes ─────────────────────────────────────────────
export interface FitModel {
  overall: { won: number; total: number; rate: number };
  features: Map<string, { won: number; total: number; lift: number; label: string }>;
  trainedOn: number;
}

const ageBand = (incorporated: string | null | undefined, at: Date): string | null => {
  if (!incorporated) return null;
  const y = (at.getTime() - new Date(incorporated).getTime()) / (365.25 * 86_400_000);
  return y < 2 ? 'age:<2' : y < 5 ? 'age:2-5' : y < 10 ? 'age:5-10' : 'age:10+';
};
const AGE_LABEL: Record<string, string> = { 'age:<2': 'under 2 years old', 'age:2-5': '2–5 years old', 'age:5-10': '5–10 years old', 'age:10+': 'over 10 years old' };
const area = (pc: string | null | undefined) => pc ? 'area:' + pc.toUpperCase().match(/^[A-Z]{1,2}/)?.[0] : null;

function featuresOf(x: { sic_codes?: string[]; incorporated_on?: string | null; postcode_area?: string | null }, at: Date): string[] {
  const f = new Set<string>();
  for (const s of x.sic_codes ?? []) { const sec = sicSection(s); if (sec) f.add('sector:' + sec.letter); }
  const a = ageBand(x.incorporated_on, at); if (a) f.add(a);
  const r = area(x.postcode_area); if (r && r !== 'area:undefined') f.add(r);
  return [...f];
}

export function trainFitModel(outcomes: Outcome[], k = 10, minN = 3): FitModel {
  const usable = outcomes.filter(o => o.company_number || o.sic_codes.length);
  const won = usable.filter(o => o.outcome === 'won').length;
  const total = usable.length;
  const rate = total ? won / total : 0.2;
  const counts = new Map<string, { won: number; total: number }>();
  for (const o of usable) {
    for (const f of featuresOf(o, new Date(o.decided_at))) {
      const c = counts.get(f) ?? { won: 0, total: 0 };
      c.total++; if (o.outcome === 'won') c.won++;
      counts.set(f, c);
    }
  }
  const features = new Map<string, { won: number; total: number; lift: number; label: string }>();
  const p0 = Math.min(0.95, Math.max(0.05, rate));
  for (const [f, c] of counts) {
    if (c.total < minN) continue;
    const shrunk = (c.won + p0 * k) / (c.total + k);
    const logit = (p: number) => Math.log(p / (1 - p));
    const lift = logit(shrunk) - logit(p0);
    const [kind, val] = f.split(':') as [string, string];
    const label = kind === 'sector' ? sectionName(val) : kind === 'age' ? `Companies ${AGE_LABEL[f]}` : `Postcode area ${val}`;
    features.set(f, { ...c, lift, label });
  }
  return { overall: { won, total, rate }, features, trainedOn: total };
}

// ── Scoring ────────────────────────────────────────────────────────────
export interface FitResult {
  companyNumber: string; companyName: string;
  score: number; band: 'hot' | 'warm' | 'cool';
  reasons: string[];               // plain sentences, best first
  evidence: Evidence[];            // filled by commitEvidence(); empty until then
  evidenceDrafts: Omit<Evidence, 'id' | 'observedAt'>[];
  signals: Signal[];
  learned: { feature: string; lift: number; label: string; won: number; total: number }[];
  hasNeed: boolean;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function scoreCompany(p: ChProfile, signals: Signal[], model: FitModel | null, now: Date): FitResult {
  const learned: FitResult['learned'] = [];
  let fit = 0;
  if (model && model.trainedOn >= 10) {
    const feats = featuresOf({ sic_codes: p.sic_codes, incorporated_on: p.date_of_creation, postcode_area: p.registered_office_address?.postal_code }, now);
    for (const f of feats) {
      const m = model.features.get(f);
      if (!m) continue;
      learned.push({ feature: f, lift: m.lift, label: m.label, won: m.won, total: m.total });
      fit += m.lift;
    }
  }
  const need = signals.reduce((a, s) => a + s.weight, 0);
  const hasNeed = signals.some(s => NEED_KEYS.has(s.key));
  let score = Math.round(100 * sigmoid(BASE_LOGIT + need + 0.7 * fit));
  if (!hasNeed) score = Math.min(score, NO_NEED_CAP);
  const band = score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cool';

  const drafts: FitResult['evidenceDrafts'] = [];
  const reasons: string[] = [];
  for (const s of [...signals].sort((a, b) => b.weight - a.weight)) {
    drafts.push({ source: s.key === 'winding_up_petition' ? 'gazette' : 'companies_house', label: `${p.company_name}: ${s.label}`, url: s.url, values: s.values });
    if (s.weight > 0) reasons.push(s.label);
  }
  for (const l of learned.sort((a, b) => b.lift - a.lift)) {
    const label = `${l.label}: ${l.won} of ${l.total} won (${pct(l.won / l.total)}) vs ${pct(model!.overall.rate)} overall`;
    drafts.push({ source: 'crm', label, values: { won: l.won, total: l.total, rate: l.won / l.total, overall: model!.overall.rate } });
    if (Math.abs(l.lift) >= 0.15) reasons.push(`${l.lift > 0 ? 'Converts well for you' : 'Converts poorly for you'}: ${label}`);
  }
  if (!hasNeed) reasons.unshift('No public sign of financial pressure, so kept low');
  drafts.push({ source: 'computed', label: `${p.company_name}: fit score ${score}/100 (${band})`, url: CH_WEB + p.company_number, values: { score } });
  return { companyNumber: p.company_number, companyName: p.company_name, score, band, reasons, evidence: [], evidenceDrafts: drafts, signals, learned, hasNeed };
}

/** Put a kept result's evidence into the store, so the agent can cite it. */
export function commitEvidence(r: FitResult, store: EvidenceStore): FitResult {
  if (!r.evidence.length) r.evidence = r.evidenceDrafts.map(d => store.add(d));
  return r;
}
