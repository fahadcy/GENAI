/**
 * The business brain: what the agent knows about the business, where each
 * fact came from, and what it still needs to ask.
 *
 * Every fact carries a source. When two sources disagree the more
 * authoritative one wins: owner (a person told us) > crm > website > inferred.
 * The agent never states an inferred fact to a customer; inferred facts only
 * steer its own searches until a person confirms them.
 */
import { z } from 'zod';
import type { CrmBusiness } from './crm/client';
import type { FinderTargets } from './leads/finder';

export type FactSource = 'owner' | 'crm' | 'website' | 'inferred';
const RANK: Record<FactSource, number> = { owner: 3, crm: 2, website: 1, inferred: 0 };
export interface Fact<T> { value: T; source: FactSource; ref?: string; at: string }

export const ServiceSchema = z.object({
  name: z.string().min(2).max(120),
  summary: z.string().max(400).default(''),
  priceFrom: z.number().nonnegative().nullable().default(null),
  feeScope: z.string().max(600).default(''),     // what the price covers: required before any fee appears in marketing
  url: z.string().url().optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export interface BusinessBrain {
  businessId: number;               // the CRM's business id
  name: Fact<string>;
  website: Fact<string> | null;
  phone: Fact<string> | null;
  regulator: Fact<string> | null;   // e.g. "Insolvency Practitioners Association"
  services: Fact<Service[]> | null;
  idealCustomer: Fact<string> | null;
  targets: Fact<FinderTargets> | null;
  capacityPerMonth: Fact<number> | null;
  monthlyGoal: Fact<string> | null;
  competitors: Fact<string[]> | null;   // domains
  voice: Fact<string[]> | null;         // tone rules in plain words
  neverSay: Fact<string[]> | null;      // owner's own banned phrases, on top of the regulatory list
  stages: string[];
  channels: string[];
  updatedAt: string;
}

function pick<T>(cur: Fact<T> | null, next: Fact<T> | null): Fact<T> | null {
  if (!next) return cur;
  if (!cur) return next;
  return RANK[next.source] >= RANK[cur.source] ? next : cur;
}

export function emptyBrain(businessId: number, name: string, now: Date): BusinessBrain {
  const at = now.toISOString();
  return { businessId, name: { value: name, source: 'crm', at }, website: null, phone: null, regulator: null, services: null,
    idealCustomer: null, targets: null, capacityPerMonth: null, monthlyGoal: null, competitors: null, voice: null, neverSay: null,
    stages: [], channels: [], updatedAt: at };
}

/** Merge a partial set of facts in, respecting source rank. */
export function mergeBrain(b: BusinessBrain, patch: Partial<Omit<BusinessBrain, 'businessId' | 'stages' | 'channels' | 'updatedAt'>>, now: Date): BusinessBrain {
  const out: BusinessBrain = { ...b, updatedAt: now.toISOString() };
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, any][]) {
    (out as any)[k] = pick((b as any)[k] ?? null, v ?? null);
  }
  return out;
}

export function brainFromCrm(biz: CrmBusiness, now: Date): BusinessBrain {
  const at = now.toISOString();
  const b = emptyBrain(biz.id, biz.name, now);
  return {
    ...mergeBrain(b, {
      website: biz.website ? { value: biz.website.startsWith('http') ? biz.website : `https://${biz.website}`, source: 'crm', at } : null,
      phone: biz.phone ? { value: biz.phone, source: 'crm', at } : null,
    }, now),
    stages: biz.stages.map(s => s.name), channels: biz.channels,
  };
}

/** Things the agent should ask about, most useful first. Each is one plain question. */
export function brainGaps(b: BusinessBrain): { field: keyof BusinessBrain; question: string; why: string }[] {
  const g: { field: keyof BusinessBrain; question: string; why: string }[] = [];
  const confirmed = <T>(f: Fact<T> | null) => !!f && f.source !== 'inferred';
  if (!confirmed(b.services)) g.push({ field: 'services', question: `Which services should I promote for ${b.name.value}, and what does each one cost?`, why: 'Content, ads and outreach all need the offer' });
  else if (b.services!.value.some(s => s.priceFrom !== null && !s.feeScope.trim())) g.push({ field: 'services', question: 'What exactly does each advertised fee cover (and not cover)?', why: 'Any fee in marketing must say what it covers (Insolvency Code of Ethics 2360.6 A1)' });
  if (!confirmed(b.targets)) g.push({ field: 'targets', question: 'Which areas and kinds of company do you want more of? (Sectors, regions, size)', why: 'Lead finding searches Companies House by these' });
  if (!confirmed(b.capacityPerMonth)) g.push({ field: 'capacityPerMonth', question: 'How many new cases a month can the team take on?', why: 'So I don\'t fill the pipeline faster than it can be worked' });
  if (!confirmed(b.idealCustomer)) g.push({ field: 'idealCustomer', question: 'Describe a client you\'d love ten more of.', why: 'Sharpens the fit score and the copy' });
  if (!confirmed(b.competitors)) g.push({ field: 'competitors', question: 'Who do you lose work to? Names or websites.', why: 'Competitor tracking and positioning' });
  if (!confirmed(b.voice)) g.push({ field: 'voice', question: 'How should we sound? (e.g. plain, calm, no jargon)', why: 'Keeps everything I write on brand' });
  if (!confirmed(b.monthlyGoal)) g.push({ field: 'monthlyGoal', question: 'What would a great month look like, in numbers?', why: 'So insights are measured against your goal' });
  return g;
}

/** A compact text form for the model's system prompt. Owner-confirmed facts are marked so the model can tell. */
export function brainForPrompt(b: BusinessBrain): string {
  const line = <T>(label: string, f: Fact<T> | null, fmt: (v: T) => string = v => String(v)) =>
    f ? `- ${label}: ${fmt(f.value)} [${f.source}${f.source === 'inferred' ? ': unconfirmed, do not state to customers' : ''}]` : `- ${label}: unknown`;
  return [
    `Business: ${b.name.value} (CRM business ${b.businessId})`,
    line('Website', b.website), line('Phone', b.phone), line('Regulator', b.regulator),
    line('Services', b.services, v => v.map(s => `${s.name}${s.priceFrom !== null ? ` from £${s.priceFrom.toLocaleString('en-GB')}` : ''}${s.feeScope ? ` (covers: ${s.feeScope})` : ''}`).join('; ')),
    line('Ideal customer', b.idealCustomer), line('Capacity per month', b.capacityPerMonth), line('Monthly goal', b.monthlyGoal),
    line('Competitors', b.competitors, v => v.join(', ')), line('Voice', b.voice, v => v.join('; ')), line('Never say', b.neverSay, v => v.join('; ')),
    `- Pipeline stages: ${b.stages.join(' → ') || 'unknown'}`,
  ].join('\n');
}

/**
 * What the Easy Liquidation website says about itself (read from the site's
 * own source on 9 Nov 2026). Facts are "website" source: a person should
 * confirm them in the first conversation, especially the fee scope.
 */
export function easyLiquidationWebsiteFacts(now: Date): Partial<BusinessBrain> {
  const at = now.toISOString();
  const ref = 'easyliquidation.co.uk (lib/keywordLandings.ts)';
  return {
    website: { value: 'https://easyliquidation.co.uk', source: 'website', ref, at },
    regulator: { value: 'Insolvency Practitioners Association (IPA); R3 member', source: 'website', ref: 'public/IPA.png, public/R3.png', at },
    services: { value: [
      { name: "Creditors' voluntary liquidation (CVL)", summary: 'Closing an insolvent limited company through a licensed practitioner', priceFrom: 1499, feeScope: '', url: 'https://easyliquidation.co.uk/services/creditors-voluntary-liquidation' },
      { name: "Members' voluntary liquidation (MVL)", summary: 'Closing a solvent company and distributing its assets', priceFrom: null, feeScope: '', url: 'https://easyliquidation.co.uk/services/members-voluntary-liquidation' },
      { name: 'Bounce Back Loan advice', summary: 'Companies that cannot repay a Bounce Back Loan', priceFrom: null, feeScope: '', url: 'https://easyliquidation.co.uk/services/bounce-back-loans' },
    ], source: 'website', ref, at },
    idealCustomer: { value: 'Directors of small insolvent UK limited companies under creditor pressure (HMRC arrears, Bounce Back Loans, winding-up petitions)', source: 'inferred', ref, at },
    voice: { value: ['Plain English', 'Calm and reassuring, never alarming', 'Explain what happens to the director personally', 'Free, confidential first conversation'], source: 'website', ref, at },
  };
}
