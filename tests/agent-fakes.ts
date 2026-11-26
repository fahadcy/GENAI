import type { CrmPort, CrmBusiness, CrmLead, PipelineSnapshot, Outcome, LeadUpsert, SendResult } from '../src/lib/agent/crm/client';
import type { CompaniesHousePort, ChProfile, ChOfficer, ChSearchItem, AdvancedSearch } from '../src/lib/agent/leads/companiesHouse';
import type { Clock } from '../src/lib/agent/types';

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

export function business(over: Partial<CrmBusiness> = {}): CrmBusiness {
  return {
    id: 1, bkey: 'easy_liquidation', name: 'Easy Liquidation', short_name: 'Easy Liq', website: 'easyliquidation.co.uk', phone: '',
    from_name: 'Easy Liquidation', from_email: 'info@easyliquidation.co.uk', email_footer: '',
    stages: [
      { id: 1, key: 'new', name: 'New', is_won: false, is_lost: false },
      { id: 2, key: 'contacted', name: 'Contacted', is_won: false, is_lost: false },
      { id: 3, key: 'proposal', name: 'Proposal', is_won: false, is_lost: false },
      { id: 6, key: 'won', name: 'Won', is_won: true, is_lost: false },
      { id: 7, key: 'lost', name: 'Lost', is_won: false, is_lost: true },
    ],
    channels: ['website', 'google_ads', 'referral', 'agent'],
    outreach: { enabled: true, paused: false, paused_reason: '', daily_cap: 20, max_steps: 2, followup_days: 7, cooldown_days: 365, fee_scope_text: 'from £1,499 plus VAT for a standard CVL' },
    templates: [{ id: 10, name: 'Intro (step 1)', subject: 'A question about {{company_name}}', body: '…', category: 'agent', approved_for_agent: true },
                { id: 11, name: 'Follow-up (step 2)', subject: 'Following up', body: '…', category: 'agent', approved_for_agent: true }],
    ...over,
  };
}

export function lead(over: Partial<CrmLead> = {}): CrmLead {
  return {
    id: 100, business_id: 1, name: 'Sam Owner', company: 'Brick Ltd', org_id: 5, email: 'sam@brick.co.uk', phone: null, has_email: true, has_phone: false,
    stage: 'new', stage_id: 1, stage_entered_at: '2026-11-01 10:00:00', channel: 'agent', priority: 'high', deal_value: 0, lead_score: 80,
    assigned: false, found_by_agent: true, agent_ref: 'ch:09876543', agent_fit_score: 80, created_at: '2026-11-01 10:00:00', updated_at: '2026-11-01 10:00:00',
    last_contacted: null, next_followup: null, ...over,
  };
}

export class FakeCrm implements CrmPort {
  biz = business();
  snapshot: PipelineSnapshot | null = null;
  leads: CrmLead[] = [];
  outcomesList: Outcome[] = [];
  outreachHistory = new Map<number, { step: number; status: string; sent_at: string }[]>();
  tasks: { leadId: number; title: string }[] = [];
  notes: { leadId: number; content: string }[] = [];
  upserts: LeadUpsert[] = [];
  sends: { lead_id: number; template_id: number; signal?: string }[] = [];
  sendReply: (o: any) => SendResult = () => ({ sent: true, outreach_id: 1, step: 1, sent_today: 1, daily_cap: 20 });
  paused: string | null = null;
  calls: string[] = [];

  async whoami() { this.calls.push('whoami'); return { token: { name: 'fake', scopes: ['read', 'write', 'outreach'] }, businesses: [{ id: 1, bkey: 'easy_liquidation', name: 'Easy Liquidation' }] }; }
  async businessProfile() { this.calls.push('business_profile'); return [this.biz]; }
  async pipelineSnapshot() { this.calls.push('pipeline_snapshot'); return this.snapshot ? [this.snapshot] : []; }
  async leadsSearch(q: any) {
    this.calls.push('leads_search');
    return this.leads.filter(l => (!q.stage || l.stage === q.stage) && (!q.agentOnly || l.channel === 'agent'));
  }
  async leadGet(id: number) { this.calls.push('lead_get'); return { lead: this.leads.find(l => l.id === id)!, org: null, agent_outreach: this.outreachHistory.get(id) ?? [] }; }
  async outcomes() { this.calls.push('outcomes'); return this.outcomesList; }
  async suppressionCheck() { return []; }
  async upsertLead(l: LeadUpsert) {
    this.calls.push('lead_upsert'); this.upserts.push(l);
    const id = 1000 + this.upserts.length;
    this.leads.push(lead({ id, company: l.company.name ?? '', agent_ref: l.agent_ref, agent_fit_score: l.fit_score, email: null, has_email: false }));
    return { lead_id: id, created: true };
  }
  async addNote(leadId: number, content: string) { this.notes.push({ leadId, content }); return this.notes.length; }
  async addTask(leadId: number, t: { title: string }) { this.calls.push('task_add'); this.tasks.push({ leadId, title: t.title }); return this.tasks.length; }
  async sendOutreach(o: any) { this.calls.push('outreach_send'); this.sends.push(o); return this.sendReply(o); }
  async pauseOutreach(_b: number, reason: string) { this.paused = reason; }
}

export function profile(num: string, over: Partial<ChProfile> = {}): ChProfile {
  return {
    company_number: num, company_name: `Company ${num} Ltd`, company_status: 'active', type: 'ltd', date_of_creation: '2019-03-01',
    sic_codes: ['41100'], registered_office_address: { postal_code: 'ST4 2RS', locality: 'Stoke-on-Trent' },
    accounts: { overdue: false, next_due: '2027-03-31', last_accounts: { type: 'micro-entity' } },
    confirmation_statement: { overdue: false, next_due: '2027-03-01' }, has_charges: false, has_insolvency_history: false,
    jurisdiction: 'england-wales', ...over,
  };
}

export class FakeCH implements CompaniesHousePort {
  profiles = new Map<string, ChProfile>();
  officersBy = new Map<string, ChOfficer[]>();
  searchItems: ChSearchItem[] = [];
  calls = 0;
  lastSearch: AdvancedSearch | null = null;
  add(p: ChProfile, officers: ChOfficer[] = []) {
    this.profiles.set(p.company_number, p); this.officersBy.set(p.company_number, officers);
    this.searchItems.push({ company_number: p.company_number, company_name: p.company_name, company_status: p.company_status, company_type: p.type, sic_codes: p.sic_codes });
    return this;
  }
  async profile(n: string) { this.calls++; return this.profiles.get(n) ?? null; }
  async officers(n: string) { this.calls++; return this.officersBy.get(n) ?? []; }
  async advancedSearch(q: AdvancedSearch) { this.calls++; this.lastSearch = q; return { items: this.searchItems, hits: this.searchItems.length }; }
}

export function outcome(won: boolean, sic: string, over: Partial<Outcome> = {}): Outcome {
  return { lead_id: Math.floor(Math.random() * 1e6), business_id: 1, outcome: won ? 'won' : 'lost', deal_value: won ? 2000 : 0, channel: 'google_ads',
    created_at: '2026-06-01 10:00:00', decided_at: '2026-07-01 10:00:00', company_number: '01234567', company_type: 'ltd', sic_codes: [sic],
    incorporated_on: '2019-01-01', has_charges: false, postcode_area: 'ST4', agent_ref: null, agent_fit_score: null, ...over };
}
