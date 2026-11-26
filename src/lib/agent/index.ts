/**
 * @genai/agent — the growth agent.
 *
 * createGrowthAgent() wires the CRM, Companies House, The Gazette, the
 * website repository and a model from environment variables. Everything is
 * optional except the CRM: missing pieces make their tools explain what to
 * connect, rather than fail.
 *
 *   GENAI_AGENT_CRM_URL      https://crm.cy-group.co.uk
 *   GENAI_AGENT_CRM_TOKEN    cya_…        (CRM → Admin → Growth agent → Access tokens)
 *   GENAI_AGENT_BUSINESS_ID  CRM business id this agent works for
 *   CH_API_KEY               Companies House REST key (free)
 *   GITHUB_SITE_REPO         owner/repo of the website
 *   GITHUB_SITE_TOKEN        fine-grained token: that repo only, Contents + Pull requests read/write
 *   ANTHROPIC_API_KEY        or OPENAI_API_KEY; neither → simulator
 *   GENAI_AGENT_MODEL        model id (default claude-sonnet-5-5 for Anthropic; required for OpenAI)
 */
import { CrmClient, type CrmPort } from './crm/client';
import { CompaniesHouseClient, type CompaniesHousePort } from './leads/companiesHouse';
import { fetchPetitions, type GazetteNotice } from './leads/gazette';
import { GitHubSite } from './site/github';
import { AnthropicModel, OpenAIModel, type ModelClient } from './agent/models';
import { SimulatedModel } from './agent/simulator';
import { ALL_TOOLS, type AgentCtx } from './agent/tools';
import { runAgent, type RunPolicy, type RunResult, type StepRecord } from './agent/loop';
import { brainFromCrm, mergeBrain, type BusinessBrain } from './brain';
import { EvidenceStore, systemClock, type Clock } from './types';

export * from './types';
export * from './brain';
export * from './crm/client';
export * from './leads/companiesHouse';
export * from './leads/gazette';
export * from './leads/fit';
export * from './leads/finder';
export * from './insights/pipeline';
export * from './outreach/gate';
export * from './site/edits';
export * from './site/github';
export * from './agent/models';
export * from './agent/loop';
export * from './agent/simulator';
export * from './agent/tools';

export type GoalKind = 'daily_brief' | 'find_leads' | 'outreach' | 'grow' | 'content' | 'ask';

export const GOALS: Record<GoalKind, { goal: string; tools: string[]; policy?: Partial<RunPolicy> }> = {
  daily_brief: { goal: 'Give me today\'s brief: what in the pipeline needs attention, and set up follow-ups for leads going cold.', tools: ['get_business_profile', 'pipeline_insights', 'add_followup_tasks'] },
  find_leads: { goal: 'Find companies that are good leads for us right now and add the strongest to the CRM.', tools: ['get_business_profile', 'find_leads', 'add_leads_to_crm'] },
  outreach: { goal: 'Send the introductions and follow-ups that are due, within the rules.', tools: ['send_outreach'] },
  grow: { goal: 'Run the full growth routine: brief, new leads, outreach.', tools: ['get_business_profile', 'pipeline_insights', 'add_followup_tasks', 'find_leads', 'add_leads_to_crm', 'send_outreach'], policy: { maxSteps: 14 } },
  content: { goal: 'Draft one useful blog post or landing page for our best keyword gap, as a pull request.', tools: ['get_business_profile', 'draft_blog_post', 'draft_landing_page'] },
  // A person's question. Read-only tools: answering never changes anything.
  ask: { goal: '', tools: ['get_business_profile', 'pipeline_insights', 'find_leads'], policy: { maxSteps: 6 } },
};

export interface GrowthAgentDeps {
  crm: CrmPort; ch?: CompaniesHousePort | null; site?: GitHubSite | null; model?: ModelClient;
  petitions?: () => Promise<GazetteNotice[]>; clock?: Clock; brainPatch?: Partial<BusinessBrain>;
  limits?: Partial<AgentCtx['limits']>;
}

export function modelFromEnv(env: Record<string, string | undefined> = process.env): ModelClient {
  if (env.ANTHROPIC_API_KEY) return new AnthropicModel(env.ANTHROPIC_API_KEY, env.GENAI_AGENT_MODEL || 'claude-sonnet-5-5');
  if (env.OPENAI_API_KEY) return new OpenAIModel(env.OPENAI_API_KEY, env.GENAI_AGENT_MODEL ?? '', { baseUrl: env.OPENAI_BASE_URL });
  return new SimulatedModel();
}

export function depsFromEnv(env: Record<string, string | undefined> = process.env): GrowthAgentDeps {
  if (!env.GENAI_AGENT_CRM_URL || !env.GENAI_AGENT_CRM_TOKEN) throw new Error('Set GENAI_AGENT_CRM_URL and GENAI_AGENT_CRM_TOKEN');
  const [owner, repo] = (env.GITHUB_SITE_REPO ?? '').split('/');
  return {
    crm: new CrmClient({ baseUrl: env.GENAI_AGENT_CRM_URL, token: env.GENAI_AGENT_CRM_TOKEN }),
    ch: env.CH_API_KEY ? new CompaniesHouseClient(env.CH_API_KEY) : null,
    site: owner && repo && env.GITHUB_SITE_TOKEN ? new GitHubSite({ owner, repo, token: env.GITHUB_SITE_TOKEN }) : null,
    model: modelFromEnv(env),
  };
}

/** One run of one goal for one business. Returns the full, storable run record. */
export async function runGoal(kind: GoalKind, businessId: number, deps: GrowthAgentDeps, onStep?: (s: StepRecord) => void, question?: string): Promise<RunResult> {
  const clock = deps.clock ?? systemClock;
  const store = new EvidenceStore(clock);
  const profiles = await deps.crm.businessProfile();
  const biz = profiles.find(b => b.id === businessId);
  if (!biz) throw new Error(`The CRM token cannot see business ${businessId}`);
  let brain = brainFromCrm(biz, clock.now());
  if (deps.brainPatch) brain = mergeBrain(brain, deps.brainPatch, clock.now());
  const ctx: AgentCtx = {
    crm: deps.crm, ch: deps.ch ?? null, site: deps.site ?? null, brain, store, now: () => clock.now(),
    petitions: deps.petitions ?? (() => fetchPetitions()),
    scratch: { profile: biz },
    limits: { maxNewLeadsPerRun: 15, maxTasksPerRun: 10, maxEnrich: 60, ...deps.limits },
  };
  const g = GOALS[kind];
  const goal = kind === 'ask' ? (question ?? '').trim().slice(0, 2000) || 'What needs my attention?' : g.goal;
  return runAgent({ model: deps.model ?? new SimulatedModel(), tools: ALL_TOOLS, ctx, goal, goalKind: kind, brain, store, clock,
    policy: { ...g.policy, allowedTools: g.tools }, onStep });
}
