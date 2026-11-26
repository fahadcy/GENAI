/**
 * The growth agent's tools. Each is a thin, typed wrapper over code that
 * does the real work; the tier decides what may happen without a person.
 */
import { z } from 'zod';
import type { ToolDef, Proposal } from './loop';
import type { CrmPort, CrmBusiness, CrmLead } from '../crm/client';
import type { CompaniesHousePort } from '../leads/companiesHouse';
import type { GazetteNotice } from '../leads/gazette';
import { findLeads } from '../leads/finder';
import { trainFitModel, type FitModel, type FitResult } from '../leads/fit';
import { pipelineInsights, type Insight } from '../insights/pipeline';
import { planSends, strongestSignal } from '../outreach/gate';
import { addBlogPost, addKeywordLanding, slugify } from '../site/edits';
import type { GitHubSite } from '../site/github';
import { brainForPrompt, brainGaps, type BusinessBrain } from '../brain';
import type { EvidenceStore } from '../types';

export interface AgentCtx {
  crm: CrmPort;
  ch: CompaniesHousePort | null;
  petitions: () => Promise<GazetteNotice[]>;
  site: GitHubSite | null;
  brain: BusinessBrain;
  store: EvidenceStore;
  now: () => Date;
  /** Per-run memory shared between tools: found leads, trained model, profile. */
  scratch: { found?: Map<string, FitResult>; model?: FitModel | null; profile?: CrmBusiness; insights?: Insight[] };
  limits: { maxNewLeadsPerRun: number; maxTasksPerRun: number; maxEnrich: number };
}

async function profile(ctx: AgentCtx): Promise<CrmBusiness> {
  if (!ctx.scratch.profile) {
    const all = await ctx.crm.businessProfile();
    const b = all.find(x => x.id === ctx.brain.businessId);
    if (!b) throw new Error(`The CRM token cannot see business ${ctx.brain.businessId}`);
    ctx.scratch.profile = b;
  }
  return ctx.scratch.profile;
}

export const getBrain: ToolDef<{}, AgentCtx> = {
  name: 'get_business_profile', tier: 'auto', input: z.object({}),
  description: 'What is known about the business (services, targets, voice) and the questions still to ask the owner.',
  async run(ctx) {
    const gaps = brainGaps(ctx.brain);
    const e = ctx.store.add({ source: 'brain', label: `Business profile for ${ctx.brain.name.value}, ${gaps.length} open questions` });
    return { summary: brainForPrompt(ctx.brain), data: { open_questions: gaps.map(g => g.question) }, evidence: [e] };
  },
};

export const pipelineTool: ToolDef<{ days: number }, AgentCtx> = {
  name: 'pipeline_insights', tier: 'auto', maxCallsPerRun: 1,
  input: z.object({ days: z.number().int().min(30).max(365).default(90).describe('Look-back window in days') }),
  description: 'Read the CRM pipeline and return what needs attention: leads going cold, channel win-rate gaps, lead-flow changes, unassigned leads, overdue tasks.',
  async run(ctx, i) {
    const [snap] = await ctx.crm.pipelineSnapshot({ businessId: ctx.brain.businessId, days: i.days });
    if (!snap) return { summary: 'No pipeline data for this business.' };
    const ins = pipelineInsights(snap, ctx.store, ctx.now(), ctx.brain.name.value);
    ctx.scratch.insights = ins;
    return {
      summary: ins.length ? ins.map(x => `[${x.severity}] ${x.headline}${x.action ? ` → suggested: ${x.action.label}` : ''} (${x.evidence.map(e => e.id).join(', ')})`).join('\n') : 'Nothing in the pipeline needs attention.',
      data: { insights: ins.map(x => ({ kind: x.kind, severity: x.severity, headline: x.headline, action: x.action ?? null, evidence: x.evidence.map(e => e.id) })) },
      evidence: ins.flatMap(x => x.evidence),
    };
  },
};

export const staleTasksTool: ToolDef<{ stage: string; reason: string }, AgentCtx> = {
  name: 'add_followup_tasks', tier: 'propose', maxCallsPerRun: 2,
  input: z.object({ stage: z.string().min(2).max(50).describe('Stage key from pipeline_insights, e.g. "contacted"'), reason: z.string().min(5).max(200) }),
  description: 'Add a follow-up task to each lead that has sat in a stage for 14+ days with no follow-up booked. Tasks go to the lead\'s owner.',
  async run(ctx, i) {
    const cutoff = new Date(ctx.now().getTime() - 14 * 86_400_000);
    const leads = (await ctx.crm.leadsSearch({ businessId: ctx.brain.businessId, stage: i.stage, limit: 200, order: 'stage_age' }))
      .filter(l => l.stage_entered_at && new Date(l.stage_entered_at.replace(' ', 'T')) < cutoff && (!l.next_followup || new Date(l.next_followup.replace(' ', 'T')) < ctx.now()))
      .slice(0, ctx.limits.maxTasksPerRun);
    const proposals: Proposal[] = [];
    for (const l of leads) {
      const days = Math.floor((ctx.now().getTime() - new Date(l.stage_entered_at!.replace(' ', 'T')).getTime()) / 86_400_000);
      await ctx.crm.addTask(l.id, { title: `Follow up: ${l.company || l.name || 'lead ' + l.id} (${days} days in ${i.stage})`, description: i.reason, priority: days > 30 ? 'high' : 'medium' });
      proposals.push({ kind: 'task', title: `Follow up ${l.company || l.name || l.id}`, ref: `lead:${l.id}`, status: 'created' });
    }
    const e = ctx.store.add({ source: 'crm', label: `Added ${proposals.length} follow-up tasks for leads stuck in ${i.stage}`, values: { tasks: proposals.length } });
    return { summary: e.label, evidence: [e], proposals };
  },
};

export const findLeadsTool: ToolDef<{ limit: number; minScore: number }, AgentCtx> = {
  name: 'find_leads', tier: 'auto', maxCallsPerRun: 1,
  input: z.object({ limit: z.number().int().min(1).max(25).default(10), minScore: z.number().int().min(30).max(95).default(55) }),
  description: 'Search Companies House and The Gazette for companies that fit this business, scored on public signs of need and on what has converted before. Read-only: nothing is added to the CRM.',
  async run(ctx, i) {
    if (!ctx.ch) return { summary: 'Companies House is not connected (no CH_API_KEY), so I cannot search for new companies.' };
    const targets = ctx.brain.targets?.value ?? {};
    if (ctx.scratch.model === undefined) {
      const since = new Date(ctx.now().getTime() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
      ctx.scratch.model = trainFitModel(await ctx.crm.outcomes({ since, businessId: ctx.brain.businessId }));
    }
    const known = new Set<string>();
    for (const l of await ctx.crm.leadsSearch({ businessId: ctx.brain.businessId, agentOnly: true, limit: 200 })) if (l.agent_ref?.startsWith('ch:')) known.add(l.agent_ref.slice(3));
    let petitions: GazetteNotice[] = [];
    try { petitions = await ctx.petitions(); } catch { /* Gazette down: carry on with Companies House alone */ }
    const r = await findLeads({ ch: ctx.ch, petitions, targets, model: ctx.scratch.model, knownCompanyNumbers: known, suppressed: new Set(), store: ctx.store, now: ctx.now(), maxEnrich: ctx.limits.maxEnrich, minScore: i.minScore, limit: i.limit });
    ctx.scratch.found = new Map(r.leads.map(l => [l.companyNumber, l]));
    const m = ctx.scratch.model;
    const stat = ctx.store.add({ source: 'computed', label: `Checked ${r.stats.candidates} candidate companies, enriched ${r.stats.enriched}, ${r.leads.length} scored ${i.minScore}+`, values: { candidates: r.stats.candidates, enriched: r.stats.enriched, kept: r.leads.length, api_calls: r.stats.apiCalls } });
    const modelNote = m && m.trainedOn >= 10 ? ctx.store.add({ source: 'crm', label: `Fit learned from ${m.trainedOn} won/lost leads (${Math.round(m.overall.rate * 100)}% won overall)`, values: { trained_on: m.trainedOn, rate: m.overall.rate } }) : null;
    return {
      summary: r.leads.map(l => `${l.companyName} (${l.companyNumber}) fit ${l.score} ${l.band}: ${l.reasons.slice(0, 3).join('; ')} [${l.evidence.map(e => e.id).join(', ')}]`).join('\n') || 'No company cleared the threshold.',
      data: { leads: r.leads.map(l => ({ company_number: l.companyNumber, name: l.companyName, score: l.score, band: l.band, reasons: l.reasons.slice(0, 4) })), excluded: r.stats.excluded },
      evidence: [stat, ...(modelNote ? [modelNote] : []), ...r.leads.flatMap(l => l.evidence)],
    };
  },
};

export const addLeadsTool: ToolDef<{ company_numbers: string[] }, AgentCtx> = {
  name: 'add_leads_to_crm', tier: 'propose', maxCallsPerRun: 1,
  input: z.object({ company_numbers: z.array(z.string().min(6).max(10)).min(1).max(25).describe('Company numbers returned by find_leads in this run') }),
  description: 'Add companies found by find_leads to the CRM as unassigned "Growth Agent" leads in the first stage, with the reasons and evidence in a note. Only companies found in this run can be added.',
  async run(ctx, i) {
    const found = ctx.scratch.found;
    if (!found?.size) return { summary: 'Run find_leads first; only companies it returned can be added.' };
    const proposals: Proposal[] = [];
    const lines: string[] = [];
    for (const num of i.company_numbers.slice(0, ctx.limits.maxNewLeadsPerRun)) {
      const f = found.get(num.toUpperCase().padStart(8, '0')) ?? found.get(num);
      if (!f) { lines.push(`${num}: not found in this run, skipped`); continue; }
      const r = await ctx.crm.upsertLead({
        business_id: ctx.brain.businessId, agent_ref: `ch:${f.companyNumber}`,
        company: { number: f.companyNumber, name: f.companyName }, fit_score: f.score,
        reasons: f.reasons.slice(0, 8), evidence_urls: [...new Set(f.evidence.map(e => e.url).filter((u): u is string => !!u))].slice(0, 6),
        source_detail: 'Companies House / Gazette',
      });
      if ('refused' in r) { lines.push(`${f.companyName}: refused by the CRM (${r.error})`); proposals.push({ kind: 'lead', title: f.companyName, status: 'refused' }); continue; }
      lines.push(`${f.companyName}: ${r.created ? 'added' : r.reason === 'already_in_crm' ? 'already in the CRM' : 'already found earlier'}${r.lead_id ? ` (lead ${r.lead_id})` : ''}`);
      if (r.created) proposals.push({ kind: 'lead', title: f.companyName, ref: `lead:${r.lead_id}`, status: 'created' });
    }
    const added = proposals.filter(p => p.status === 'created').length;
    const e = ctx.store.add({ source: 'crm', label: `Added ${added} new leads to the CRM`, values: { added } });
    return { summary: lines.join('\n'), evidence: [e], proposals };
  },
};

export const outreachTool: ToolDef<{}, AgentCtx> = {
  name: 'send_outreach', tier: 'gated', maxCallsPerRun: 1,
  input: z.object({}),
  description: 'Email the agent\'s own leads that are due an introduction or follow-up, using templates an admin approved, within the CRM\'s daily limit and rules. The wording is fixed by the template; the CRM adds one factual sentence about the public signal. The CRM checks every email again and may refuse.',
  async run(ctx) {
    const biz = await profile(ctx);
    if (!biz.outreach.enabled) return { summary: `Outreach is switched off for ${biz.name}. An admin can switch it on in the CRM (Admin → Growth agent).` };
    if (biz.outreach.paused) return { summary: `Outreach is paused for ${biz.name}: ${biz.outreach.paused_reason}. Only an admin can resume it.` };
    const approved = biz.templates.filter(t => t.approved_for_agent);
    if (!approved.length) return { summary: 'No email template is approved for the agent yet.' };
    // A template is for step N if its name or category says "step N" (not "step 12"), or "intro"/"follow" for steps 1/2.
    // With exactly one approved template and no labels, it is the introduction. Otherwise no guess.
    const pick = (step: number) => {
      const re = new RegExp(`\\bstep\\s*${step}\\b|${step === 1 ? '\\bintro' : step === 2 ? '\\bfollow' : '(?!)'}`, 'i');
      const t = approved.find(x => re.test(`${x.name} ${x.category}`)) ?? (step === 1 && approved.length === 1 ? approved[0] : undefined);
      return t?.id ?? null;
    };
    const leads: CrmLead[] = await ctx.crm.leadsSearch({ businessId: biz.id, agentOnly: true, limit: 200 });
    const history = new Map<number, { step: number; status: string; sent_at: string }[]>();
    for (const l of leads.filter(x => x.email).slice(0, 80)) history.set(l.id, (await ctx.crm.leadGet(l.id)).agent_outreach ?? []);
    const { plan, skipped } = planSends(biz, leads, history, pick, ctx.now(), 0);
    const proposals: Proposal[] = [];
    const results: string[] = [];
    let unexpected = 0;
    for (const p of plan) {
      const sigs = ctx.scratch.found?.get(p.lead.agent_ref?.slice(3) ?? '')?.signals.map(s => s.key) ?? signalsFromReasons(p.lead);
      const r = await ctx.crm.sendOutreach({ lead_id: p.lead.id, template_id: p.templateId, email: p.email, signal: strongestSignal(sigs) });
      if (r.sent) { proposals.push({ kind: 'email', title: `${p.why} to ${p.lead.company}`, ref: `lead:${p.lead.id}`, status: 'sent' }); results.push(`${p.lead.company}: sent (${p.why})`); unexpected = 0; }
      else {
        results.push(`${p.lead.company}: not sent: ${r.reasons.join('; ')}`);
        proposals.push({ kind: 'email', title: `${p.why} to ${p.lead.company}`, ref: `lead:${p.lead.id}`, status: 'refused' });
        if (r.reasons.some(x => /daily limit|outside sending hours|switched off|paused/i.test(x))) break;
        if (++unexpected >= 3) { await ctx.crm.pauseOutreach(biz.id, 'Three refusals in a row the agent did not expect; a person should look'); results.push('Paused outreach after three unexpected refusals.'); break; }
      }
    }
    const sent = proposals.filter(p => p.status === 'sent').length;
    const e = ctx.store.add({ source: 'crm', label: `Outreach: ${sent} sent, ${proposals.length - sent} refused by the CRM, ${skipped.length} not due or not eligible`, values: { sent, refused: proposals.length - sent, skipped: skipped.length } });
    return { summary: [e.label, ...results].join('\n'), evidence: [e], proposals };
  },
};

const BlogInput = z.object({
  title: z.string().min(20).max(90), excerpt: z.string().min(60).max(200),
  html: z.string().min(800).max(60_000).describe('Article body as HTML: h2, h3, p, ul, ol, li, strong, em, a only'),
  keyword: z.string().min(3).max(60).optional(),
});
export const blogTool: ToolDef<z.infer<typeof BlogInput>, AgentCtx> = {
  name: 'draft_blog_post', tier: 'propose', maxCallsPerRun: 1, input: BlogInput,
  description: 'Open a DRAFT pull request adding a blog post to the website. A person reviews and merges it; nothing goes live from here. Refused if the wording or SEO checks fail.',
  async run(ctx, i) {
    if (!ctx.site) return { summary: 'The website repository is not connected (GITHUB_SITE_REPO / GITHUB_SITE_TOKEN).' };
    const sha = await ctx.site.headSha();
    const src = await ctx.site.readFile('lib/blogData.ts', sha);
    if (!src) return { summary: 'lib/blogData.ts not found in the website repository.' };
    const r = addBlogPost(src, i, await ctx.site.publicFiles(sha));
    if (r.problems.length) return { summary: `Not drafted. Fix first:\n- ${r.problems.join('\n- ')}`, data: { warnings: r.warnings } };
    const slug = slugify(i.title);
    const pr = await ctx.site.openPullRequest({ branch: `aurea/blog-${slug}`.slice(0, 80), title: `Blog: ${i.title}`, message: `Add blog post: ${i.title}`, files: r.changes, expectedBaseSha: sha,
      body: `Drafted by the Aurea growth agent.\n\nWill appear at ${r.url} once merged.\n\n${r.warnings.length ? `**Check before merging:**\n${r.warnings.map(w => `- ${w}`).join('\n')}\n\n` : ''}Review the Vercel preview, then merge to publish. Close the PR to discard.` });
    const e = ctx.store.add({ source: 'website', label: `Draft pull request #${pr.number} adds the post "${i.title}"`, url: pr.url });
    return { summary: `${e.label}. ${r.warnings.length} things to check.`, evidence: [e], proposals: [{ kind: 'pull_request', title: `Blog: ${i.title}`, url: pr.url, status: 'draft' }] };
  },
};

const LandingInput = z.object({
  keyword: z.string().min(3).max(60), title: z.string().min(20).max(70), description: z.string().min(70).max(170),
  h1: z.string().min(10).max(90), intro: z.string().min(80).max(500),
  points: z.array(z.string().min(5).max(120)).min(2).max(6), paragraphs: z.array(z.string().min(80).max(900)).min(2).max(6),
  faqs: z.array(z.object({ question: z.string().min(10).max(150), answer: z.string().min(40).max(600) })).min(3).max(8),
});
export const landingTool: ToolDef<z.infer<typeof LandingInput>, AgentCtx> = {
  name: 'draft_landing_page', tier: 'propose', maxCallsPerRun: 1, input: LandingInput,
  description: 'Open a DRAFT pull request adding an SEO landing page for one search keyword (page, route and sitemap entry). A person reviews and merges it.',
  async run(ctx, i) {
    if (!ctx.site) return { summary: 'The website repository is not connected.' };
    const sha = await ctx.site.headSha();
    const [landings, sitemap, routes] = await Promise.all([ctx.site.readFile('lib/keywordLandings.ts', sha), ctx.site.readFile('app/sitemap.ts', sha), ctx.site.appRoutes(sha)]);
    if (!landings || !sitemap) return { summary: 'lib/keywordLandings.ts or app/sitemap.ts not found.' };
    const r = addKeywordLanding({ landings, sitemap, existingRoutes: routes }, i);
    if (r.problems.length) return { summary: `Not drafted. Fix first:\n- ${r.problems.join('\n- ')}`, data: { warnings: r.warnings } };
    const slug = slugify(i.keyword);
    const pr = await ctx.site.openPullRequest({ branch: `aurea/landing-${slug}`.slice(0, 80), title: `Landing page: ${i.keyword}`, message: `Add landing page for "${i.keyword}"`, files: r.changes, expectedBaseSha: sha,
      body: `Drafted by the Aurea growth agent.\n\nNew page: ${r.url}\n\n${r.warnings.length ? `**Check before merging:**\n${r.warnings.map(w => `- ${w}`).join('\n')}\n\n` : ''}Review the preview, then merge to publish.` });
    const e = ctx.store.add({ source: 'website', label: `Draft pull request #${pr.number} adds a landing page for "${i.keyword}"`, url: pr.url });
    return { summary: e.label, evidence: [e], proposals: [{ kind: 'pull_request', title: `Landing: ${i.keyword}`, url: pr.url, status: 'draft' }] };
  },
};

/**
 * A lead found in an earlier run has no signals in memory; its CRM note holds
 * the reasons as text. Rather than parse prose, use the neutral line.
 */
function signalsFromReasons(_l: CrmLead): string[] { return []; }

export const ALL_TOOLS = [getBrain, pipelineTool, staleTasksTool, findLeadsTool, addLeadsTool, outreachTool, blogTool, landingTool];
