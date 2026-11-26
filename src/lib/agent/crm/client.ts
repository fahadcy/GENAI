/**
 * Client for the CRM's agent API (crm/agent_api.php).
 *
 * - Bearer token, never logged.
 * - Writes that must not happen twice (lead_upsert, outreach_send) carry an
 *   Idempotency-Key derived from their content, so a retry after a timeout
 *   replays the CRM's first answer instead of sending a second email.
 * - Retries 429 / 502 / 503 / network errors with backoff; never retries a 4xx
 *   decision (a 422 "not sent" is an answer, not a failure).
 */
import { createHash } from 'node:crypto';

export interface CrmConfig {
  baseUrl: string;            // https://crm.cy-group.co.uk
  token: string;              // cya_…
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CrmError extends Error {
  constructor(message: string, public status: number, public body: unknown) { super(message); }
}

export interface CrmStage { id: number; key: string; name: string; is_won: boolean; is_lost: boolean }
export interface CrmTemplate { id: number; name: string; subject: string; body: string; category: string; approved_for_agent: boolean }
export interface CrmBusiness {
  id: number; bkey: string; name: string; short_name: string; website: string; phone: string;
  from_name: string; from_email: string; email_footer: string;
  stages: CrmStage[]; channels: string[];
  outreach: { enabled: boolean; paused: boolean; paused_reason: string; daily_cap: number; max_steps: number;
              followup_days: number; cooldown_days: number; fee_scope_text: string };
  templates: CrmTemplate[];
}
export interface PipelineSnapshot {
  business_id: number; days: number;
  stages: { key: string; name: string; is_won: boolean; is_lost: boolean; count: number; value: number; stale_14d: number }[];
  by_channel: { channel: string; created: number; won: number; lost: number; won_value: number; win_rate: number | null }[];
  won: { count: number; median_days_to_win: number | null };
  weekly_new_leads: { week_start: string; count: number }[];
  overdue_tasks: number; unassigned_open_leads: number; generated_at: string;
}
export interface CrmLead {
  id: number; business_id: number; name: string; company: string; org_id: number | null;
  email: string | null; phone: string | null; has_email: boolean; has_phone: boolean;
  stage: string; stage_id: number | null; stage_entered_at: string | null; channel: string; priority: string;
  deal_value: number; lead_score: number; assigned: boolean; found_by_agent: boolean;
  agent_ref: string | null; agent_fit_score: number | null; created_at: string; updated_at: string;
  last_contacted: string | null; next_followup: string | null;
}
export interface Outcome {
  lead_id: number; business_id: number; outcome: 'won' | 'lost'; deal_value: number; channel: string;
  created_at: string; decided_at: string; company_number: string | null; company_type: string | null;
  sic_codes: string[]; incorporated_on: string | null; has_charges: boolean | null; postcode_area: string | null;
  agent_ref: string | null; agent_fit_score: number | null;
}
export interface LeadUpsert {
  business_id: number; agent_ref: string;
  company: { number?: string; name?: string };
  contact?: { name?: string; email?: string; phone?: string; job_title?: string };
  fit_score: number; reasons: string[]; evidence_urls?: string[]; source_detail?: string;
}
export type UpsertResult = { lead_id: number | null; created: boolean; reason?: 'already_found' | 'already_in_crm'; owned_by_staff?: boolean; company_verified?: boolean };
export type SendResult =
  | { sent: true; outreach_id: number; step: number; sent_today: number; daily_cap: number }
  | { sent: false; reasons: string[]; retry?: boolean };

export interface CrmPort {
  whoami(): Promise<{ token: { name: string; scopes: string[] }; businesses: { id: number; bkey: string; name: string }[] }>;
  businessProfile(): Promise<CrmBusiness[]>;
  pipelineSnapshot(opts?: { businessId?: number; days?: number }): Promise<PipelineSnapshot[]>;
  leadsSearch(q: { businessId?: number; stage?: string; channel?: string; since?: string; updatedSince?: string; agentOnly?: boolean; q?: string; limit?: number; offset?: number; order?: 'updated' | 'stage_age' }): Promise<CrmLead[]>;
  leadGet(id: number): Promise<{ lead: CrmLead; org: Record<string, unknown> | null; agent_outreach: { step: number; status: string; sent_at: string }[] }>;
  outcomes(opts?: { since?: string; businessId?: number }): Promise<Outcome[]>;
  suppressionCheck(businessId: number, items: { email?: string; company_number?: string }[]): Promise<{ email: string; company_number: string; suppressed: boolean; reason: string | null }[]>;
  upsertLead(l: LeadUpsert): Promise<UpsertResult | { refused: true; error: string }>;
  addNote(leadId: number, content: string): Promise<number>;
  addTask(leadId: number, t: { title: string; description?: string; due_date?: string; priority?: 'low' | 'medium' | 'high' }): Promise<number>;
  sendOutreach(o: { lead_id: number; template_id: number; email?: string; signal?: OutreachSignal }): Promise<SendResult>;
  pauseOutreach(businessId: number, reason: string): Promise<void>;
}

/** Personalisation is a public-signal key; the CRM writes the sentence itself (crm/agent_lib.php AGENT_PERSONAL_LINES). */
export type OutreachSignal = 'winding_up_petition' | 'strike_off_proposed' | 'accounts_overdue' | 'confirmation_overdue' | 'none';

export function idempotencyKey(kind: string, payload: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40)}`;
}

export class CrmClient implements CrmPort {
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private cfg: CrmConfig) {
    if (!/^cya_[0-9a-f]{40}$/.test(cfg.token)) throw new Error('CRM agent token must look like cya_ followed by 40 hex characters');
    if (!/^https:\/\//.test(cfg.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(cfg.baseUrl)) throw new Error('CRM URL must be https');
    this.f = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  /** Low-level call. Returns [status, body]; throws only for transport failure after retries or unexpected errors. */
  async call<T = any>(action: string, body: Record<string, unknown> = {}, idem?: string): Promise<{ status: number; body: T }> {
    const url = this.cfg.baseUrl.replace(/\/$/, '') + '/agent_api.php';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.token}` };
    if (idem) headers['Idempotency-Key'] = idem;
    const max = this.cfg.maxRetries ?? 3;
    let last: unknown;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const r = await this.f(url, { method: 'POST', headers, body: JSON.stringify({ action, ...body }) });
        const text = await r.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: text.slice(0, 200) }; }
        const retryable = r.status === 429 || r.status === 503 || (r.status === 502 && parsed?.retry) || (r.status === 409 && parsed?.retry);
        if (retryable && attempt < max) { await this.sleep(400 * 2 ** attempt); continue; }
        return { status: r.status, body: parsed };
      } catch (e) {
        last = e;
        if (attempt < max) { await this.sleep(400 * 2 ** attempt); continue; }
      }
    }
    throw new CrmError(`CRM unreachable: ${String(last)}`, 0, null);
  }

  private async ok<T>(action: string, body: Record<string, unknown> = {}, idem?: string): Promise<T> {
    const r = await this.call(action, body, idem);
    if (r.status >= 400 || !r.body?.ok) throw new CrmError(`${action}: ${r.body?.error ?? r.status}`, r.status, r.body);
    return r.body as T;
  }

  async whoami() { return this.ok<any>('whoami'); }
  async businessProfile() { return (await this.ok<{ businesses: CrmBusiness[] }>('business_profile')).businesses; }
  async pipelineSnapshot(o: { businessId?: number; days?: number } = {}) {
    return (await this.ok<{ snapshots: PipelineSnapshot[] }>('pipeline_snapshot', { business_id: o.businessId, days: o.days })).snapshots;
  }
  async leadsSearch(q: Parameters<CrmPort['leadsSearch']>[0]) {
    return (await this.ok<{ leads: CrmLead[] }>('leads_search', {
      business_id: q.businessId, stage: q.stage, channel: q.channel, since: q.since, updated_since: q.updatedSince,
      agent_only: q.agentOnly, q: q.q, limit: q.limit, offset: q.offset, order: q.order })).leads;
  }
  async leadGet(id: number) { return this.ok<any>('lead_get', { lead_id: id }); }
  async outcomes(o: { since?: string; businessId?: number } = {}) {
    return (await this.ok<{ outcomes: Outcome[] }>('outcomes', { since: o.since, business_id: o.businessId })).outcomes;
  }
  async suppressionCheck(businessId: number, items: { email?: string; company_number?: string }[]) {
    return (await this.ok<any>('suppression_check', { business_id: businessId, items })).results;
  }
  async upsertLead(l: LeadUpsert): Promise<UpsertResult | { refused: true; error: string }> {
    const r = await this.call('lead_upsert', { ...l }, idempotencyKey('lead', l));
    if (r.status === 422) return { refused: true, error: r.body?.error ?? 'refused' };
    if (r.status >= 400 || !r.body?.ok) throw new CrmError(`lead_upsert: ${r.body?.error ?? r.status}`, r.status, r.body);
    return r.body as UpsertResult;
  }
  async addNote(leadId: number, content: string) { return (await this.ok<any>('note_add', { lead_id: leadId, content })).note_id; }
  async addTask(leadId: number, t: { title: string; description?: string; due_date?: string; priority?: 'low' | 'medium' | 'high' }) {
    return (await this.ok<any>('task_add', { lead_id: leadId, ...t })).task_id;
  }
  async sendOutreach(o: { lead_id: number; template_id: number; email?: string; signal?: OutreachSignal }): Promise<SendResult> {
    // The key includes the day, so tomorrow's legitimate follow-up is not a "replay" of today's.
    const payload = { lead_id: o.lead_id, template_id: o.template_id, email: o.email, vars: { signal: o.signal ?? 'none' } };
    const r = await this.call('outreach_send', payload, idempotencyKey('send', { ...payload, day: new Date().toISOString().slice(0, 10) }));
    if (r.status === 201 && r.body?.ok) return { sent: true, ...r.body };
    if (r.status === 422) return { sent: false, reasons: r.body?.reasons ?? [r.body?.error ?? 'refused'] };
    if (r.status === 502) return { sent: false, reasons: [r.body?.error ?? 'provider error'], retry: true };
    throw new CrmError(`outreach_send: ${r.body?.error ?? r.status}`, r.status, r.body);
  }
  async pauseOutreach(businessId: number, reason: string) { await this.ok('outreach_pause', { business_id: businessId, reason }); }
}
