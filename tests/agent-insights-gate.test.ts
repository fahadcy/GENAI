import { describe, it, expect } from './expect';
import { pipelineInsights, wilson, weeklySeries } from '../src/lib/agent/insights/pipeline';
import { checkPersonalLine, planSends, wordingProblems, factualPersonalLine, londonDayHour } from '../src/lib/agent/outreach/gate';
import { EvidenceStore } from '../src/lib/agent/types';
import { verifyReport } from '../src/lib/agent/agent/loop';
import type { PipelineSnapshot } from '../src/lib/agent/crm/client';
import { business, lead } from './agent-fakes';

const NOW = new Date('2026-11-10T10:30:00Z');   // Tuesday
function snap(over: Partial<PipelineSnapshot> = {}): PipelineSnapshot {
  return {
    business_id: 1, days: 90,
    stages: [
      { key: 'new', name: 'New', is_won: false, is_lost: false, count: 12, value: 0, stale_14d: 0 },
      { key: 'contacted', name: 'Contacted', is_won: false, is_lost: false, count: 9, value: 0, stale_14d: 6 },
      { key: 'proposal', name: 'Proposal', is_won: false, is_lost: false, count: 4, value: 7996, stale_14d: 1 },
      { key: 'won', name: 'Won', is_won: true, is_lost: false, count: 20, value: 0, stale_14d: 0 },
    ],
    by_channel: [], won: { count: 20, median_days_to_win: 11 }, weekly_new_leads: [], overdue_tasks: 0, unassigned_open_leads: 0, generated_at: NOW.toISOString(),
    ...over,
  };
}

describe('pipeline insights', () => {
  it('stale leads per stage, worst first, with evidence', () => {
    const store = new EvidenceStore();
    const ins = pipelineInsights(snap(), store, NOW, 'Easy Liquidation');
    expect(ins[0]).toMatchObject({ kind: 'stale_leads', severity: 'act', headline: '6 leads going cold in Contacted', action: { stage: 'contacted' } });
    expect(ins.find(i => i.kind === 'open_value')!.headline).toBe('£7,996 close to closing');
    expect(store.all().length).toBe(ins.reduce((a, i) => a + i.evidence.length, 0));
  });
  it('flags a channel gap only when intervals separate', () => {
    const small = pipelineInsights(snap({ by_channel: [
      { channel: 'referral', created: 12, won: 6, lost: 4, won_value: 0, win_rate: 0.6 },
      { channel: 'google_ads', created: 12, won: 3, lost: 6, won_value: 0, win_rate: 0.33 }] }), new EvidenceStore(), NOW);
    expect(small.some(i => i.kind === 'channel_gap')).toBe(false);
    const big = pipelineInsights(snap({ by_channel: [
      { channel: 'referral', created: 30, won: 13, lost: 12, won_value: 0, win_rate: 0.52 },
      { channel: 'google_ads', created: 70, won: 6, lost: 44, won_value: 0, win_rate: 0.12 }] }), new EvidenceStore(), NOW);
    const gap = big.find(i => i.kind === 'channel_gap')!;
    expect(gap.headline).toBe('Referral leads win far more often than Google Ads');
    expect(gap.evidence.map(e => e.label).join(' ')).toContain('13 won of 25 decided (52%)');
  });
  it('lead flow down against the 6-week median, zero weeks filled', () => {
    const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
    const counts = [9, 10, 8, 11, 10, 9, 10, 2, 1];
    const rows = weeks.map((w, i) => ({ week_start: w, count: counts[i]! }));
    const series = weeklySeries(rows.filter(r => r.week_start !== '2026-10-05'), NOW);
    expect(series.find(s => s.week === '2026-10-05')!.count).toBe(0);
    const ins = pipelineInsights(snap({ weekly_new_leads: rows }), new EvidenceStore(), NOW);
    const down = ins.find(i => i.kind === 'lead_flow_down')!;
    expect(down.detail).toContain('3 new leads in the last 2 full weeks against a usual 20');
    // Every insight must survive the report check when quoted as-is with its citation.
    const store = new EvidenceStore();
    const all = pipelineInsights(snap({ weekly_new_leads: rows, overdue_tasks: 4, unassigned_open_leads: 2, by_channel: [
      { channel: 'referral', created: 30, won: 13, lost: 12, won_value: 0, win_rate: 0.52 },
      { channel: 'google_ads', created: 70, won: 6, lost: 44, won_value: 0, win_rate: 0.12 }] }), store, NOW, 'Easy Liquidation');
    const text = all.flatMap(i => i.evidence.map(e => `- ${e.label} [${e.id}]`)).join('\n');
    expect(verifyReport(text, store).dropped).toEqual([]);
  });
  it('wilson interval sanity', () => {
    const [lo, hi] = wilson(13, 25);
    expect(lo).toBeGreaterThan(0.35); expect(hi).toBeLessThan(0.69);
  });
});

describe('wording rules (same examples as the CRM tests)', () => {
  it.each([
    ['We can write off your debts', true], ['Government scheme for directors', true], ['Guaranteed result', true],
    ['Free liquidation for your company', true], ['Act now before bailiffs arrive', true], ['Cheaper than other firms', true],
    ['Would a confidential call with a licensed practitioner help?', false],
  ])('%s → flagged %s', (t, flagged) => { expect(wordingProblems(t).length > 0).toBe(flagged); });
  it('personal line rules', () => {
    expect(checkPersonalLine('I noticed the accounts are overdue at Companies House.')).toEqual([]);
    expect(checkPersonalLine('See https://x.co')).not.toEqual([]);
    expect(checkPersonalLine('Only £1,499!')).not.toEqual([]);
    expect(checkPersonalLine('A. B. C. D.')).toContain('more than two sentences');
    for (const k of [['winding_up_petition'], ['strike_off_proposed'], ['accounts_overdue'], []]) expect(checkPersonalLine(factualPersonalLine('Brick Ltd', k))).toEqual([]);
  });
});

describe('send planning', () => {
  const pick = (s: number) => (s === 1 ? 10 : s === 2 ? 11 : null);
  it('UK hours whatever the server zone', () => {
    expect(londonDayHour(new Date('2026-07-01T07:30:00Z'))).toEqual({ dow: 3, hr: 8 });   // BST
    expect(londonDayHour(new Date('2026-12-01T07:30:00Z'))).toEqual({ dow: 2, hr: 7 });   // GMT
  });
  it('outside hours or switched off → nothing', () => {
    expect(planSends(business(), [lead()], new Map(), pick, new Date('2026-11-14T10:00:00Z'), 0).plan).toEqual([]);   // Saturday
    expect(planSends(business({ outreach: { ...business().outreach, enabled: false } }), [lead()], new Map(), pick, NOW, 0).plan).toEqual([]);
  });
  it('intro, follow-up spacing, finished sequence, staff leads, domain, cap', () => {
    const leads = [
      lead({ id: 1, email: 'a@one.co.uk', agent_fit_score: 90 }),
      lead({ id: 2, email: 'b@two.co.uk', agent_fit_score: 85 }),
      lead({ id: 3, email: 'c@three.co.uk', agent_fit_score: 80 }),
      lead({ id: 4, email: 'd@four.co.uk', channel: 'website', found_by_agent: false }),
      lead({ id: 5, email: 'e@one.co.uk', agent_fit_score: 70 }),
      lead({ id: 6, email: 'f@six.co.uk', stage_id: 2 }),
      lead({ id: 7, email: 'g@seven.co.uk', agent_fit_score: 60 }),
    ];
    const h = new Map([
      [2, [{ step: 1, status: 'sent', sent_at: '2026-11-01 10:00:00' }]],                                                   // follow-up due
      [3, [{ step: 1, status: 'sent', sent_at: '2026-11-08 10:00:00' }]],                                                   // too soon
      [7, [{ step: 1, status: 'sent', sent_at: '2026-10-01 10:00:00' }, { step: 2, status: 'sent', sent_at: '2026-10-10 10:00:00' }]],  // finished
    ]);
    const r = planSends(business(), leads, h, pick, NOW, 0);
    expect(r.plan.map(p => [p.lead.id, p.step, p.templateId])).toEqual([[1, 1, 10], [2, 2, 11]]);
    const why = Object.fromEntries(r.skipped.map(s => [s.leadId, s.why]));
    expect(why).toMatchObject({ 3: 'follow-up not due', 4: 'staff lead', 5: 'same domain already in this batch', 6: 'moved on by staff', 7: 'sequence finished' });
    expect(planSends(business(), leads, h, pick, NOW, 19).plan).toHaveLength(1);   // 1 left of 20
  });
  it('a complaint ends the sequence', () => {
    const r = planSends(business(), [lead({ id: 1 })], new Map([[1, [{ step: 1, status: 'complained', sent_at: '2026-10-01 10:00:00' }]]]), pick, NOW, 0);
    expect(r.plan).toEqual([]);
  });
});
