import { describe, it, expect } from './expect';
import { needSignals, exclusions, trainFitModel, scoreCompany, commitEvidence } from '../src/lib/agent/leads/fit';
import { parseGazetteFeed } from '../src/lib/agent/leads/gazette';
import { findLeads } from '../src/lib/agent/leads/finder';
import { normCompanyNumber, sicSection } from '../src/lib/agent/leads/companiesHouse';
import { EvidenceStore } from '../src/lib/agent/types';
import { FakeCH, profile, outcome } from './agent-fakes';

const NOW = new Date('2026-11-10T10:30:00Z');

describe('need signals', () => {
  it('reads overdue accounts with days, strike-off, resignations and petition', () => {
    const p = profile('11111111', { company_status_detail: 'active-proposal-to-strike-off', accounts: { overdue: true, next_due: '2026-06-30', last_accounts: { type: 'micro-entity' } }, confirmation_statement: { overdue: true, next_due: '2026-08-01' } });
    const s = needSignals(p, [{ name: 'A', officer_role: 'director', resigned_on: '2026-10-01' }, { name: 'B', officer_role: 'secretary', resigned_on: '2026-10-01' }],
      { noticeId: '1', companyName: 'X', companyNumber: '11111111', published: '2026-11-02', url: 'https://www.thegazette.co.uk/notice/1', hearingDate: '2026-12-03' }, NOW);
    const keys = s.map(x => x.key);
    expect(keys).toEqual(expect.arrayContaining(['winding_up_petition', 'strike_off_proposed', 'accounts_overdue', 'accounts_overdue_long', 'confirmation_overdue', 'director_resigned_recently', 'small_company_accounts']));
    expect(s.find(x => x.key === 'accounts_overdue')!.label).toContain('133 days');
    expect(s.find(x => x.key === 'director_resigned_recently')!.label).toMatch(/^1 director resigned/);   // secretary not counted
  });
  it('dormant companies are pushed down', () => {
    const s = needSignals(profile('2', { accounts: { overdue: true, next_due: '2026-10-01', last_accounts: { type: 'dormant' } } }), [], null, NOW);
    expect(s.find(x => x.key === 'dormant')!.weight).toBeLessThan(0);
  });
});

describe('exclusions', () => {
  const ctx = { knownCompanyNumbers: new Set(['33333333']), suppressed: new Set(['44444444']) };
  it('refuses inactive, in insolvency, non-corporate, known, suppressed', () => {
    expect(exclusions(profile('1', { company_status: 'liquidation', has_insolvency_history: true }), ctx).join()).toMatch(/liquidation/);
    expect(exclusions(profile('1', { type: 'limited-partnership' }), ctx).join()).toMatch(/PECR/);
    expect(exclusions(profile('33333333'), ctx)).toContain('Already in the CRM');
    expect(exclusions(profile('44444444'), ctx)).toContain('On the suppression list');
    expect(exclusions(profile('55555555'), ctx)).toEqual([]);
  });
});

describe('learning from outcomes', () => {
  it('shrinks small samples toward the overall rate', () => {
    const outs = [
      ...Array.from({ length: 12 }, () => outcome(true, '41100')), ...Array.from({ length: 19 }, () => outcome(false, '41100')),   // construction 12/31
      ...Array.from({ length: 8 }, () => outcome(true, '56101')), ...Array.from({ length: 52 }, () => outcome(false, '56101')),    // hospitality 8/60
      outcome(true, '62012'), outcome(true, '62012'),                                                                              // IT 2/2: too few
    ];
    const m = trainFitModel(outs);
    expect(m.trainedOn).toBe(93);
    const f = m.features.get('sector:F')!;
    expect(f.won).toBe(12); expect(f.total).toBe(31); expect(f.lift).toBeGreaterThan(0);
    expect(m.features.get('sector:I')!.lift).toBeLessThan(0);
    expect(m.features.has('sector:J')).toBe(false);
  });
});

describe('scoring', () => {
  it('a petition outranks overdue accounts; no need caps at 30', () => {
    const store = new EvidenceStore();
    const pet = { noticeId: '9', companyName: 'P', companyNumber: '1', published: '2026-11-01', url: 'https://www.thegazette.co.uk/notice/9', hearingDate: null };
    const a = scoreCompany(profile('1'), needSignals(profile('1'), [], pet, NOW), null, NOW);
    const late = profile('2', { accounts: { overdue: true, next_due: '2026-09-30', last_accounts: { type: 'micro-entity' } } });
    const b = scoreCompany(late, needSignals(late, [], null, NOW), null, NOW);
    const healthy = scoreCompany(profile('3'), needSignals(profile('3'), [], null, NOW), null, NOW);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.score).toBeGreaterThanOrEqual(60);          // a petition alone clears the default 55 threshold
    expect(b.score).toBeLessThan(45);                    // late accounts alone are common: cool, not warm
    expect(healthy.score).toBeLessThanOrEqual(30);
    expect(healthy.reasons[0]).toMatch(/No public sign/);
    expect(store.all()).toHaveLength(0);                 // nothing committed until kept
    commitEvidence(a, store);
    expect(a.evidence.length).toBeGreaterThan(0);
    expect(a.evidence[0]!.url).toContain('thegazette');
  });
});

describe('gazette feed', () => {
  it('parses entries, entities, CDATA, company numbers and hearing dates', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>https://www.thegazette.co.uk/notice/4999001</id><title>BRICK &amp; MORTAR LIMITED</title>
        <link rel="alternate" href="https://www.thegazette.co.uk/notice/4999001"/><published>2026-11-02T09:00:00Z</published>
        <content type="html"><![CDATA[<p>In the High Court of Justice. Company Number: 9876543. A Petition to wind up the above-named Company … will be heard at the Royal Courts of Justice on 3 December 2026 at 10:30.</p>]]></content></entry>
      <entry><id>https://www.thegazette.co.uk/notice/4999002</id><title>SCOT CO LTD (SC123456)</title><published>2026-11-03T09:00:00Z</published><content>Petition presented.</content></entry>
      <entry><id>x</id><title></title></entry>
    </feed>`;
    const n = parseGazetteFeed(xml);
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({ noticeId: '4999001', companyName: 'BRICK & MORTAR LIMITED', companyNumber: '09876543', hearingDate: '2026-12-03' });
    expect(n[1]).toMatchObject({ companyName: 'SCOT CO LTD', companyNumber: 'SC123456', url: 'https://www.thegazette.co.uk/notice/4999002' });
  });
});

describe('finder', () => {
  it('petitions first, cheap filter before API calls, bounded enrichment, evidence only for kept', async () => {
    const ch = new FakeCH();
    ch.add(profile('10000001', { accounts: { overdue: true, next_due: '2026-07-01', last_accounts: { type: 'micro-entity' } } }));
    ch.add(profile('10000002'));                                          // healthy → below threshold
    ch.add(profile('10000003', { type: 'limited-partnership' }));         // filtered without a profile call
    ch.add(profile('10000004', { company_status: 'dissolved' }));         // filtered on search status
    ch.add(profile('10000005', { accounts: { overdue: true, next_due: '2026-08-01' } }));
    ch.add(profile('20000001'));                                          // the petitioned company
    const store = new EvidenceStore();
    const r = await findLeads({ ch, targets: { sicCodes: ['41100'] }, model: null, knownCompanyNumbers: new Set(['10000005']), suppressed: new Set(), store, now: NOW, minScore: 25,
      petitions: [{ noticeId: '7', companyName: 'Company 20000001 Ltd', companyNumber: '20000001', published: '2026-11-01', url: 'https://www.thegazette.co.uk/notice/7', hearingDate: null }] });
    expect(r.leads.map(l => l.companyNumber)).toEqual(['20000001', '10000001']);
    expect(r.stats.excluded).toMatchObject({ 'Already in the CRM': 1, 'Not a corporate body (PECR)': 1, 'Not active': 1 });
    expect(r.stats.belowThreshold).toBe(1);
    expect(r.stats.apiCalls).toBe(1 + 3 * 2);                              // 1 search + 3 enriched × (profile + officers)
    expect(store.all().every(e => e.label.includes('20000001') || e.label.includes('10000001'))).toBe(true);
  });
  it('respects maxEnrich', async () => {
    const ch = new FakeCH();
    for (let i = 0; i < 30; i++) ch.add(profile(String(30000000 + i)));
    const r = await findLeads({ ch, targets: { locations: ['Stoke'] }, model: null, knownCompanyNumbers: new Set(), suppressed: new Set(), store: new EvidenceStore(), now: NOW, maxEnrich: 5 });
    expect(r.stats.enriched).toBe(5);
    expect(ch.calls).toBe(1 + 10);
  });
});

describe('helpers', () => {
  it('normalises company numbers and maps SIC sections', () => {
    expect(normCompanyNumber(' 987654 ')).toBe('00987654');
    expect(normCompanyNumber('sc123456')).toBe('SC123456');
    expect(sicSection('41100')!.name).toBe('Construction');
    expect(sicSection('56101')!.letter).toBe('I');
  });
});
