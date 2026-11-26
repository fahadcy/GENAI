/**
 * Insights from the CRM pipeline. Detection is arithmetic; the model only
 * words the result. Every insight cites the numbers that produced it, and
 * is shown only when it clears a bar that random noise usually wouldn't:
 *
 * - channel win rates are compared with Wilson 90% intervals, and only when
 *   each side has at least 8 decided leads;
 * - a change in lead flow compares the last two full weeks with the median
 *   of the six before, and needs at least 6 weeks of history.
 */
import type { PipelineSnapshot } from '../crm/client';
import type { Evidence, EvidenceStore } from '../types';

export type Severity = 'act' | 'watch' | 'good';
export interface Insight {
  kind: 'stale_leads' | 'channel_gap' | 'lead_flow_down' | 'lead_flow_up' | 'unassigned' | 'overdue_tasks' | 'open_value';
  severity: Severity;
  headline: string;
  detail: string;
  evidence: Evidence[];
  action?: { kind: 'tasks_for_stale' | 'assign_owners' | 'review_budget' | 'clear_overdue'; label: string; stage?: string };
  businessId: number;
}

export function wilson(won: number, n: number, z = 1.645): [number, number] {
  if (n === 0) return [0, 1];
  const p = won / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const CHANNEL: Record<string, string> = {
  website: 'Website form', phone: 'Inbound call', email: 'Email enquiry', whatsapp: 'WhatsApp', google_ads: 'Google Ads',
  facebook: 'Facebook / Meta', linkedin: 'LinkedIn', referral: 'Referral', walk_in: 'Walk-in', intent_widget: 'Intent tracker',
  agent: 'Growth agent', other: 'Other', unknown: 'Unknown',
};
export const channelName = (c: string) => CHANNEL[c] ?? c.replace(/_/g, ' ');

/** Monday (UTC) of the ISO week containing d. */
function monday(d: string): string {
  const x = new Date(d + 'T00:00:00Z');
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

/** Fill missing weeks with zero, oldest first, up to (not including) the current week. */
export function weeklySeries(rows: PipelineSnapshot['weekly_new_leads'], now: Date, weeks = 12): { week: string; count: number }[] {
  const byWeek = new Map<string, number>();
  for (const r of rows) byWeek.set(monday(r.week_start), (byWeek.get(monday(r.week_start)) ?? 0) + r.count);
  const thisMonday = monday(now.toISOString().slice(0, 10));
  const out: { week: string; count: number }[] = [];
  for (let i = weeks; i >= 1; i--) {
    const d = new Date(thisMonday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7 * i);
    const w = d.toISOString().slice(0, 10);
    out.push({ week: w, count: byWeek.get(w) ?? 0 });
  }
  return out;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function pipelineInsights(snap: PipelineSnapshot, store: EvidenceStore, now: Date, businessName = 'the business'): Insight[] {
  const out: Insight[] = [];
  const b = snap.business_id;

  // Stale leads, per open stage
  for (const s of snap.stages) {
    if (s.is_won || s.is_lost || s.stale_14d === 0) continue;
    const e = store.add({ source: 'crm', label: `${businessName}: ${s.stale_14d} of ${s.count} leads in ${s.name} have sat there 14+ days with no follow-up booked`, values: { stale: s.stale_14d, count: s.count } });
    out.push({ kind: 'stale_leads', severity: s.stale_14d >= 5 ? 'act' : 'watch', businessId: b,
      headline: `${s.stale_14d} lead${s.stale_14d > 1 ? 's' : ''} going cold in ${s.name}`,
      detail: e.label, evidence: [e], action: { kind: 'tasks_for_stale', label: `Add a follow-up task to each`, stage: s.key } });
  }

  // Channel win-rate gaps
  const decided = snap.by_channel.filter(c => c.won + c.lost >= 8);
  if (decided.length >= 2) {
    const withCi = decided.map(c => ({ ...c, n: c.won + c.lost, rate: c.won / (c.won + c.lost), ci: wilson(c.won, c.won + c.lost) }));
    const best = [...withCi].sort((x, y) => y.rate - x.rate)[0]!;
    const worst = [...withCi].sort((x, y) => x.rate - y.rate)[0]!;
    if (best !== worst && best.ci[0] > worst.ci[1]) {
      const e1 = store.add({ source: 'crm', label: `${channelName(best.channel)}: ${best.won} won of ${best.n} decided (${pct(best.rate)}) in the last ${snap.days} days`, values: { won: best.won, decided: best.n, rate: best.rate } });
      const e2 = store.add({ source: 'crm', label: `${channelName(worst.channel)}: ${worst.won} won of ${worst.n} decided (${pct(worst.rate)}) in the last ${snap.days} days`, values: { won: worst.won, decided: worst.n, rate: worst.rate } });
      out.push({ kind: 'channel_gap', severity: 'watch', businessId: b,
        headline: `${channelName(best.channel)} leads win far more often than ${channelName(worst.channel)}`,
        detail: `${e1.label}; ${e2.label}. The gap is larger than chance would usually produce at these numbers.`,
        evidence: [e1, e2], action: { kind: 'review_budget', label: 'Review the split in the Budget Allocator' } });
    }
  }

  // Lead flow
  const series = weeklySeries(snap.weekly_new_leads, now);
  const hist = series.slice(-8, -2).map(w => w.count);
  if (series.filter(w => w.count > 0).length >= 6 && hist.length === 6) {
    const recent = series.slice(-2).reduce((a, w) => a + w.count, 0);
    const base = median(hist) * 2;
    if (base >= 4) {
      const ratio = recent / base;
      const e = store.add({ source: 'crm', label: `${businessName}: ${recent} new leads in the last 2 full weeks against a usual ${base} for 2 weeks (from the median week of the 6 before)`, values: { recent, usual: base, ratio } });
      if (ratio < 0.7) out.push({ kind: 'lead_flow_down', severity: 'act', businessId: b, headline: `New leads down to ${pct(ratio)} of normal`, detail: e.label, evidence: [e] });
      else if (ratio > 1.4) out.push({ kind: 'lead_flow_up', severity: 'good', businessId: b, headline: `New leads up to ${pct(ratio)} of normal`, detail: e.label, evidence: [e] });
    }
  }

  if (snap.unassigned_open_leads > 0) {
    const e = store.add({ source: 'crm', label: `${businessName}: ${snap.unassigned_open_leads} open leads have no owner`, values: { unassigned: snap.unassigned_open_leads } });
    out.push({ kind: 'unassigned', severity: snap.unassigned_open_leads >= 5 ? 'act' : 'watch', businessId: b, headline: e.label.replace(`${businessName}: `, ''), detail: e.label, evidence: [e], action: { kind: 'assign_owners', label: 'Assign owners in the CRM' } });
  }
  if (snap.overdue_tasks > 0) {
    const e = store.add({ source: 'crm', label: `${businessName}: ${snap.overdue_tasks} tasks are overdue`, values: { overdue: snap.overdue_tasks } });
    out.push({ kind: 'overdue_tasks', severity: snap.overdue_tasks >= 10 ? 'act' : 'watch', businessId: b, headline: e.label.replace(`${businessName}: `, ''), detail: e.label, evidence: [e], action: { kind: 'clear_overdue', label: 'Work through overdue tasks' } });
  }
  const late = snap.stages.filter(s => !s.is_won && !s.is_lost && /proposal|negotiat/i.test(s.key + s.name));
  const lateValue = late.reduce((a, s) => a + s.value, 0), lateCount = late.reduce((a, s) => a + s.count, 0);
  if (lateCount > 0 && lateValue > 0) {
    const e = store.add({ source: 'crm', label: `${businessName}: £${Math.round(lateValue).toLocaleString('en-GB')} across ${lateCount} leads at proposal or negotiation`, values: { value: Math.round(lateValue), count: lateCount } });
    out.push({ kind: 'open_value', severity: 'good', businessId: b, headline: `£${Math.round(lateValue).toLocaleString('en-GB')} close to closing`, detail: e.label, evidence: [e] });
  }

  const rank: Record<Severity, number> = { act: 0, watch: 1, good: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}
