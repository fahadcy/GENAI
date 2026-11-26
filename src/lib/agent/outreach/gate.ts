/**
 * The agent's side of outreach. The CRM makes the final decision and
 * enforces every rule again; this exists so the agent:
 *
 *   - picks only leads that could possibly pass (no wasted refusals),
 *   - writes a personal line that already meets the wording rules,
 *   - knows when a follow-up is due and when the sequence is finished,
 *   - pauses itself if the CRM keeps refusing (something is wrong).
 *
 * The wording rules mirror crm/agent_lib.php AGENT_BANNED_CLAIMS. Keep them
 * in step; a test in each codebase checks the same examples.
 */
import type { CrmBusiness, CrmLead, OutreachSignal } from '../crm/client';

export const BANNED_CLAIMS: [RegExp, string][] = [
  [/\bwrite[\s-]?off\b|\bwipe (out|away|clean)\b|\bdebt[\s-]?free\b|\bclear (all )?(your )?debts?\b/i, 'promises debts disappear'],
  [/\bgovernment\b|\bofficial\b|\bhmrc[\s-]?(approved|backed|scheme)\b|\binsolvency service\b/i, 'implies official backing'],
  [/\bguarantee(d|s)?\b|\b100\s?%|\brisk[\s-]?free\b|\bno risk\b/i, 'guarantees an outcome'],
  [/\bfree liquidation\b|\bliquidat\w* for free\b|\bno cost\b|\bat no cost\b/i, 'says it is free'],
  [/\bavoid (paying|your) (tax|hmrc|creditors)\b|\bwalk away from\b|\bescape (your )?debts?\b/i, 'suggests avoiding creditors'],
  [/\bact now\b|\blast chance\b|\bfinal (notice|warning)\b|\bbailiffs? (are|will)\b|\burgent action required\b/i, 'pressure or fear wording'],
  [/\bcheaper than\b|\bunlike other\b|\bother (firms|practitioners|ips) (charge|will)\b/i, 'compares with other firms'],
];

export function wordingProblems(text: string): string[] {
  const out: string[] = [];
  for (const [re, why] of BANNED_CLAIMS) { const m = text.match(re); if (m) out.push(`"${m[0]}": ${why}`); }
  return out;
}

/** A personal line the CRM will accept: one sentence, no links, fees or placeholders, no banned claims. */
export function checkPersonalLine(line: string): string[] {
  const p: string[] = [];
  const t = line.trim();
  if (!t) return ['empty'];
  if (t.length > 300) p.push('longer than 300 characters');
  if (/https?:\/\/|www\.|£|\{\{/i.test(t)) p.push('contains a link, fee or placeholder');
  if ((t.match(/[.!?](\s|$)/g) ?? []).length > 2) p.push('more than two sentences');
  return [...p, ...wordingProblems(t)];
}

/** The strongest public signal, as the key the CRM turns into its personal line. */
export function strongestSignal(signalKeys: string[]): OutreachSignal {
  for (const k of ['winding_up_petition', 'strike_off_proposed', 'accounts_overdue', 'confirmation_overdue'] as const) if (signalKeys.includes(k)) return k;
  return 'none';
}

/**
 * A factual, calm personal line from the strongest public signal. Used by
 * the simulator and as the fallback when a model's line fails the check.
 * States what is public, never what it implies about the director.
 */
export function factualPersonalLine(companyName: string, signalKeys: string[]): string {
  if (signalKeys.includes('winding_up_petition')) return `I saw the notice about ${companyName} in The Gazette and wanted you to know independent advice is available before the hearing.`;
  if (signalKeys.includes('strike_off_proposed')) return `I noticed Companies House has proposed striking ${companyName} off the register.`;
  if (signalKeys.includes('accounts_overdue')) return `I noticed ${companyName}'s accounts are showing as overdue at Companies House.`;
  if (signalKeys.includes('confirmation_overdue')) return `I noticed ${companyName}'s confirmation statement is showing as overdue at Companies House.`;
  return `I came across ${companyName} on the Companies House register.`;
}

export interface SendPlan { lead: CrmLead; step: number; templateId: number; email: string; why: string }

/**
 * Which of the agent's own leads are due an email, without breaking any rule
 * the agent can see from here. History is the CRM's own outreach record.
 */
export function planSends(
  biz: CrmBusiness, leads: CrmLead[], history: Map<number, { step: number; status: string; sent_at: string }[]>,
  pickTemplate: (step: number) => number | null, now: Date, sentToday: number,
): { plan: SendPlan[]; skipped: { leadId: number; why: string }[] } {
  const o = biz.outreach;
  const skipped: { leadId: number; why: string }[] = [];
  if (!o.enabled || o.paused) return { plan: [], skipped: leads.map(l => ({ leadId: l.id, why: o.paused ? `paused: ${o.paused_reason}` : 'outreach off' })) };
  const first = biz.stages.find(s => !s.is_won && !s.is_lost);
  const { dow, hr } = londonDayHour(now);
  if (dow === 0 || dow === 6 || hr < 8 || hr >= 18) return { plan: [], skipped: leads.map(l => ({ leadId: l.id, why: 'outside sending hours' })) };
  const plan: SendPlan[] = [];
  let budget = Math.max(0, o.daily_cap - sentToday);
  const domains = new Set<string>();
  for (const l of [...leads].sort((a, b) => (b.agent_fit_score ?? 0) - (a.agent_fit_score ?? 0))) {
    if (budget <= 0) { skipped.push({ leadId: l.id, why: 'daily limit' }); continue; }
    if (!l.found_by_agent) { skipped.push({ leadId: l.id, why: 'staff lead' }); continue; }
    if (first && l.stage_id !== first.id) { skipped.push({ leadId: l.id, why: 'moved on by staff' }); continue; }
    if (!l.email) { skipped.push({ leadId: l.id, why: 'no email' }); continue; }
    const dom = l.email.split('@')[1]?.toLowerCase() ?? '';
    if (domains.has(dom)) { skipped.push({ leadId: l.id, why: 'same domain already in this batch' }); continue; }
    const h = (history.get(l.id) ?? []).filter(x => x.status === 'sent');
    if ((history.get(l.id) ?? []).some(x => ['bounced', 'complained', 'unsubscribed'].includes(x.status))) { skipped.push({ leadId: l.id, why: 'bounced, complained or unsubscribed' }); continue; }
    const step = h.length + 1;
    if (step > o.max_steps) { skipped.push({ leadId: l.id, why: 'sequence finished' }); continue; }
    if (h.length) {
      const last = new Date(h[h.length - 1]!.sent_at.replace(' ', 'T'));
      if ((now.getTime() - last.getTime()) / 86_400_000 < o.followup_days) { skipped.push({ leadId: l.id, why: 'follow-up not due' }); continue; }
    }
    const templateId = pickTemplate(step);
    if (!templateId) { skipped.push({ leadId: l.id, why: `no approved template for step ${step}` }); continue; }
    plan.push({ lead: l, step, templateId, email: l.email, why: step === 1 ? 'introduction' : `follow-up ${step - 1}` });
    domains.add(dom);
    budget--;
  }
  return { plan, skipped };
}

/** Day of week (0 = Sunday) and hour in UK time, whatever zone the server runs in. */
export function londonDayHour(d: Date): { dow: number; hr: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const wd = parts.find(p => p.type === 'weekday')?.value ?? 'Mon';
  const hr = Number(parts.find(p => p.type === 'hour')?.value ?? 12);
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hr };
}
