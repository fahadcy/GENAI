import 'server-only'
import { and, desc, eq, inArray, lt, gte } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  agentConnections,
  agentRuns,
  aiRuns,
  competitorProfiles,
  memberships,
  notifications,
  serpTwinProfiles,
  type AgentConnection,
  type AgentRun,
} from '@/lib/db/schema'
import { env, hasLiveModel } from '@/lib/env'
import { priceOf } from '@/lib/ai/gateway'
import { decryptToken, encryptToken, tokenHint } from '@/lib/crypto-secrets'
import { recordAudit } from '@/lib/workflow/audit'
import { CrmClient, CrmError, type CrmBusiness, type CrmPort } from './crm/client'
import { CompaniesHouseClient } from './leads/companiesHouse'
import { GitHubSite } from './site/github'
import { AnthropicModel, OpenAIModel, type ModelClient } from './agent/models'
import { SimulatedModel } from './agent/simulator'
import { runGoal, type GoalKind, type GrowthAgentDeps } from './index'
import { brainGaps, type BusinessBrain, type Fact, type Service } from './brain'
import { londonDayHour } from './outreach/gate'

/**
 * The growth agent inside Aurea: one connection per workspace, runs stored
 * whole, metered like every other model call, written to the audit trail,
 * and scheduled from the worker.
 *
 * Permission checks live in the server actions; this module assumes the
 * caller is allowed, except that outreach additionally requires the CRM's own
 * switch, which the CRM enforces on every email regardless.
 */

export class AgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentError'
  }
}

export const GOAL_LABEL: Record<GoalKind, string> = {
  daily_brief: 'Daily brief',
  find_leads: 'Find leads',
  outreach: 'Send due emails',
  grow: 'Full growth run',
  content: 'Draft website content',
  ask: 'Question',
}

/* ------------------------------------------------------------ connection */

export async function getConnection(workspaceId: string): Promise<AgentConnection | null> {
  const [row] = await db.select().from(agentConnections).where(eq(agentConnections.workspaceId, workspaceId)).limit(1)
  return row ?? null
}

export type ConnectionView = {
  crmUrl: string | null
  crmTokenHint: string | null
  crmBusinessId: number | null
  crmBusinessName: string | null
  crmScopes: string[]
  githubRepo: string | null
  githubTokenHint: string | null
  schedule: AgentConnection['schedule']
  targets: AgentConnection['targets']
  answers: Record<string, string>
  companiesHouse: boolean
  liveModel: boolean
  model: string
}

/** What the screen may show. Never a token. */
export async function connectionView(workspaceId: string): Promise<ConnectionView | null> {
  const c = await getConnection(workspaceId)
  const e = env()
  const base = { companiesHouse: Boolean(e.COMPANIES_HOUSE_API_KEY), liveModel: hasLiveModel(), model: modelFor().id }
  if (!c) return null
  const hint = (enc: string | null) => {
    if (!enc) return null
    try {
      return tokenHint(decryptToken(enc))
    } catch {
      return 'unreadable: reconnect'
    }
  }
  return {
    crmUrl: c.crmUrl,
    crmTokenHint: hint(c.crmTokenEnc),
    crmBusinessId: c.crmBusinessId,
    crmBusinessName: c.crmBusinessName,
    crmScopes: c.crmScopes,
    githubRepo: c.githubRepo,
    githubTokenHint: hint(c.githubTokenEnc),
    schedule: c.schedule,
    targets: c.targets,
    answers: c.answers,
    ...base,
  }
}

function normaliseCrmUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '').replace(/\/agent_api\.php$/i, '')
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  const parsed = new URL(u)
  const local = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)
  if (parsed.protocol !== 'https:' && !local) throw new AgentError('The CRM address must start with https://')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * Connect (or reconnect) the CRM. The token is tested before it is saved, and
 * the business list comes from the CRM itself, so a wrong token or URL is
 * caught here rather than at 07:40 tomorrow.
 */
export async function connectCrm(args: {
  workspaceId: string
  actorId: string
  crmUrl: string
  crmToken: string
  fetchImpl?: typeof fetch
}): Promise<{ businesses: { id: number; name: string }[]; scopes: string[] }> {
  const url = normaliseCrmUrl(args.crmUrl)
  const token = args.crmToken.trim()
  if (!/^cya_[0-9a-f]{40}$/.test(token)) {
    throw new AgentError('That is not a CRM agent token. Create one in the CRM under Admin → Growth agent → Access tokens; it starts with cya_.')
  }
  let me
  try {
    me = await new CrmClient({ baseUrl: url, token, fetch: args.fetchImpl }).whoami()
  } catch (e) {
    if (e instanceof CrmError && e.status === 401) throw new AgentError('The CRM refused that token. It may have been revoked or mistyped.')
    throw new AgentError(`Could not reach the CRM at ${url}. Check the address, and that agent_api.php is uploaded.`)
  }
  const businesses = (me.businesses ?? []).map((b: { id: number; name: string }) => ({ id: b.id, name: b.name }))
  if (!businesses.length) throw new AgentError('The token works, but it is not allowed any business. Tick a business when creating it in the CRM.')
  const only = businesses.length === 1 ? businesses[0]! : null
  const values = {
    crmUrl: url,
    crmTokenEnc: encryptToken(token),
    crmScopes: me.token?.scopes ?? [],
    crmBusinessId: only?.id ?? null,
    crmBusinessName: only?.name ?? null,
    updatedBy: args.actorId,
    updatedAt: new Date(),
  }
  await db
    .insert(agentConnections)
    .values({ workspaceId: args.workspaceId, ...values })
    .onConflictDoUpdate({ target: agentConnections.workspaceId, set: values })
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'agent.crm_connected',
    subjectType: 'agent_connection',
    subjectId: args.workspaceId,
    summary: `Growth agent connected to the CRM at ${new URL(url).host} (scopes: ${(me.token?.scopes ?? []).join(', ')}).`,
    payload: { host: new URL(url).host, scopes: me.token?.scopes ?? [], businesses: businesses.map((b: { id: number }) => b.id) },
  })
  return { businesses, scopes: me.token?.scopes ?? [] }
}

export async function chooseBusiness(args: { workspaceId: string; actorId: string; businessId: number; fetchImpl?: typeof fetch }) {
  const crm = await crmFor(args.workspaceId, args.fetchImpl)
  const me = await crm.whoami()
  const b = me.businesses.find((x: { id: number }) => x.id === args.businessId)
  if (!b) throw new AgentError('The CRM token cannot see that business.')
  await db
    .update(agentConnections)
    .set({ crmBusinessId: b.id, crmBusinessName: b.name, updatedBy: args.actorId, updatedAt: new Date() })
    .where(eq(agentConnections.workspaceId, args.workspaceId))
  await recordAudit({ workspaceId: args.workspaceId, actorId: args.actorId, action: 'agent.business_chosen', subjectType: 'agent_connection', subjectId: args.workspaceId, summary: `Growth agent works for ${b.name} (CRM business ${b.id}).`, payload: { businessId: b.id } })
}

export async function connectGithub(args: { workspaceId: string; actorId: string; repo: string; token: string; fetchImpl?: typeof fetch }) {
  const repo = args.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  const [owner, name] = repo.split('/')
  if (!owner || !name || repo.split('/').length !== 2) throw new AgentError('Enter the repository as owner/name, e.g. cy-group/easyliquidations.')
  await requireConnection(args.workspaceId)
  const site = new GitHubSite({ owner, repo: name, token: args.token.trim(), fetch: args.fetchImpl })
  try {
    await site.defaultBranch()
    if (!(await site.readFile('lib/blogData.ts'))) throw new AgentError('Connected, but lib/blogData.ts is not in that repository. Is it the website?')
  } catch (e) {
    if (e instanceof AgentError) throw e
    throw new AgentError('GitHub refused: check the repository name and that the token can read it.')
  }
  await db
    .update(agentConnections)
    .set({ githubRepo: repo, githubTokenEnc: encryptToken(args.token.trim()), updatedBy: args.actorId, updatedAt: new Date() })
    .where(eq(agentConnections.workspaceId, args.workspaceId))
  await recordAudit({ workspaceId: args.workspaceId, actorId: args.actorId, action: 'agent.github_connected', subjectType: 'agent_connection', subjectId: args.workspaceId, summary: `Growth agent can open draft pull requests on ${repo}.`, payload: { repo } })
}

export async function disconnect(args: { workspaceId: string; actorId: string; what: 'crm' | 'github' }) {
  const set = args.what === 'crm'
    ? { crmTokenEnc: null, crmBusinessId: null, crmBusinessName: null, crmScopes: [] as string[] }
    : { githubRepo: null, githubTokenEnc: null }
  await db.update(agentConnections).set({ ...set, updatedBy: args.actorId, updatedAt: new Date() }).where(eq(agentConnections.workspaceId, args.workspaceId))
  await recordAudit({ workspaceId: args.workspaceId, actorId: args.actorId, action: `agent.${args.what}_disconnected`, subjectType: 'agent_connection', subjectId: args.workspaceId, summary: `Growth agent disconnected from ${args.what === 'crm' ? 'the CRM' : 'GitHub'}.` })
}

export async function saveSettings(args: {
  workspaceId: string
  actorId: string
  schedule?: AgentConnection['schedule']
  targets?: AgentConnection['targets']
  answers?: Record<string, string>
}) {
  const c = await requireConnection(args.workspaceId)
  const set: Partial<AgentConnection> = { updatedBy: args.actorId, updatedAt: new Date() }
  if (args.schedule) set.schedule = args.schedule
  if (args.targets) {
    const sic = [...new Set(args.targets.sicCodes.map((s) => s.trim()).filter((s) => /^\d{5}$/.test(s)))].slice(0, 30)
    const loc = [...new Set(args.targets.locations.map((s) => s.trim()).filter(Boolean))].slice(0, 10)
    const ex = [...new Set(args.targets.excludedSections.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-U]$/.test(s)))]
    set.targets = { sicCodes: sic, locations: loc, excludedSections: ex, incorporatedFrom: args.targets.incorporatedFrom || null }
  }
  if (args.answers) {
    const merged = { ...c.answers }
    for (const [k, v] of Object.entries(args.answers)) {
      if (!ANSWER_KEYS.includes(k as AnswerKey)) continue
      const t = v.trim().slice(0, 1200)
      if (t) merged[k] = t
      else delete merged[k]
    }
    set.answers = merged
  }
  await db.update(agentConnections).set(set).where(eq(agentConnections.workspaceId, args.workspaceId))
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'agent.settings_updated',
    subjectType: 'agent_connection',
    subjectId: args.workspaceId,
    summary: `Growth agent settings changed: ${[args.schedule && 'schedule', args.targets && 'lead targets', args.answers && 'business answers'].filter(Boolean).join(', ')}.`,
    payload: { schedule: args.schedule ?? null, targets: set.targets ?? null, answerKeys: args.answers ? Object.keys(args.answers) : null },
  })
}

async function requireConnection(workspaceId: string): Promise<AgentConnection> {
  const c = await getConnection(workspaceId)
  if (!c?.crmUrl || !c.crmTokenEnc) throw new AgentError('Connect the CRM first.')
  return c
}

async function crmFor(workspaceId: string, fetchImpl?: typeof fetch): Promise<CrmClient> {
  const c = await requireConnection(workspaceId)
  let token: string
  try {
    token = decryptToken(c.crmTokenEnc!)
  } catch {
    throw new AgentError('The saved CRM token can no longer be read (the server secret changed). Connect the CRM again.')
  }
  return new CrmClient({ baseUrl: c.crmUrl!, token, fetch: fetchImpl })
}

/* ------------------------------------------------------------------ model */

/** The agent needs tool calling, so it has its own adapters; keys and models come from the same settings as the gateway. */
export function modelFor(): ModelClient {
  const e = env()
  if (!hasLiveModel()) return new SimulatedModel()
  if (e.AI_PROVIDER === 'anthropic') {
    return new AnthropicModel(e.ANTHROPIC_API_KEY!, e.AGENT_MODEL || (/^claude/.test(e.AI_MODEL_SMART) ? e.AI_MODEL_SMART : 'claude-sonnet-5-5'))
  }
  return new OpenAIModel(e.OPENAI_API_KEY!, e.AGENT_MODEL || e.AI_MODEL_SMART, { baseUrl: e.OPENAI_BASE_URL || undefined })
}

/* ------------------------------------------------------------------ brain */

export const ANSWER_KEYS = ['idealCustomer', 'capacityPerMonth', 'monthlyGoal', 'competitors', 'voice', 'neverSay', 'feeScope', 'services'] as const
export type AnswerKey = (typeof ANSWER_KEYS)[number]

/**
 * The brain from what Aurea already knows: the CRM's business record, the
 * PPC & SEO business setup (services, capacity, areas), the competitor
 * profile, and anything a person has told the agent directly (owner facts,
 * which outrank everything else).
 */
export async function brainPatchFor(workspaceId: string, conn: AgentConnection): Promise<Partial<BusinessBrain>> {
  const at = new Date().toISOString()
  const owner = <T,>(value: T): Fact<T> => ({ value, source: 'owner', at })
  const [comp] = await db.select().from(competitorProfiles).where(eq(competitorProfiles.workspaceId, workspaceId)).limit(1)
  const [serp] = await db.select().from(serpTwinProfiles).where(eq(serpTwinProfiles.workspaceId, workspaceId)).limit(1)
  const patch: Partial<BusinessBrain> = {}

  const services = (serp?.profile as { services?: { name: string; weeklyCapacity: number | null; landingPages?: string[] }[] } | undefined)?.services
  if (services?.length) {
    patch.services = {
      value: services.map((s): Service => ({ name: s.name, summary: '', priceFrom: null, feeScope: conn.answers.feeScope ?? '', url: s.landingPages?.[0] })),
      source: 'owner',
      ref: 'PPC & SEO → Business setup',
      at,
    }
    const weekly = services.reduce((a, s) => a + (s.weeklyCapacity ?? 0), 0)
    if (weekly > 0) patch.capacityPerMonth = { value: Math.round(weekly * 4.33), source: 'owner', ref: 'PPC & SEO → Business setup', at }
  }
  if (comp?.profile) {
    const p = comp.profile
    if (p.domain) patch.website = { value: `https://${p.domain}`, source: p.source === 'manual' ? 'owner' : 'website', ref: 'Competitors → profile', at }
    if (p.businessType) patch.idealCustomer = { value: `Customers of a ${p.businessType}`, source: 'inferred', ref: 'Competitors → profile', at }
  }
  const t = conn.targets
  if (t.sicCodes.length || t.locations.length) patch.targets = owner({ sicCodes: t.sicCodes, locations: t.locations, excludedSections: t.excludedSections, incorporatedFrom: t.incorporatedFrom ?? undefined })

  const a = conn.answers
  if (a.idealCustomer) patch.idealCustomer = owner(a.idealCustomer)
  if (a.capacityPerMonth && Number.isFinite(Number(a.capacityPerMonth))) patch.capacityPerMonth = owner(Number(a.capacityPerMonth))
  if (a.monthlyGoal) patch.monthlyGoal = owner(a.monthlyGoal)
  if (a.competitors) patch.competitors = owner(a.competitors.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))
  if (a.voice) patch.voice = owner(a.voice.split(/\n/).map((s) => s.trim()).filter(Boolean))
  if (a.neverSay) patch.neverSay = owner(a.neverSay.split(/\n/).map((s) => s.trim()).filter(Boolean))
  if (a.services && !patch.services) {
    patch.services = owner(a.services.split(/\n/).map((s) => s.trim()).filter(Boolean).map((name): Service => ({ name, summary: '', priceFrom: null, feeScope: a.feeScope ?? '' })))
  }
  return patch
}

/** The questions the agent still has, for the screen. */
export async function openQuestions(workspaceId: string): Promise<{ field: string; question: string; why: string }[]> {
  const c = await getConnection(workspaceId)
  if (!c?.crmBusinessId) return []
  const { emptyBrain, mergeBrain } = await import('./brain')
  const brain = mergeBrain(emptyBrain(c.crmBusinessId, c.crmBusinessName ?? 'the business', new Date()), await brainPatchFor(workspaceId, c), new Date())
  return brainGaps(brain).map((g) => ({ field: String(g.field), question: g.question, why: g.why }))
}

/* ------------------------------------------------------------------- runs */

const STALE_MS = 30 * 60_000

/** Everything a run needs, built from the workspace's connection. Tests pass their own. */
export async function depsFor(workspaceId: string): Promise<GrowthAgentDeps & { businessId: number }> {
  const c = await requireConnection(workspaceId)
  if (!c.crmBusinessId) throw new AgentError('Choose which CRM business the agent works for.')
  const e = env()
  let site: GitHubSite | null = null
  if (c.githubRepo && c.githubTokenEnc) {
    const [owner, repo] = c.githubRepo.split('/')
    try {
      site = new GitHubSite({ owner: owner!, repo: repo!, token: decryptToken(c.githubTokenEnc) })
    } catch {
      site = null
    }
  }
  return {
    crm: await crmFor(workspaceId),
    ch: e.COMPANIES_HOUSE_API_KEY ? new CompaniesHouseClient(e.COMPANIES_HOUSE_API_KEY) : null,
    site,
    model: modelFor(),
    brainPatch: await brainPatchFor(workspaceId, c),
    businessId: c.crmBusinessId,
  }
}

export async function startRun(args: {
  workspaceId: string
  goal: GoalKind
  actorId: string | null
  trigger: 'manual' | 'schedule' | 'chat'
  question?: string
  /** Tests inject fakes here. */
  deps?: GrowthAgentDeps & { businessId: number }
  /** The scheduler's clock, so "once a day" is judged on the same clock that started the run. */
  at?: Date
}): Promise<AgentRun> {
  // Crash recovery: a run that never finished is not "still running" forever.
  await db
    .update(agentRuns)
    .set({ status: 'failed', error: 'Did not finish (the server stopped mid-run).', finishedAt: new Date() })
    .where(and(eq(agentRuns.workspaceId, args.workspaceId), eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, new Date(Date.now() - STALE_MS))))
  const [busy] = await db
    .select({ id: agentRuns.id, goal: agentRuns.goal })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, args.workspaceId), eq(agentRuns.status, 'running')))
    .limit(1)
  if (busy) throw new AgentError(`The agent is already working on "${GOAL_LABEL[busy.goal as GoalKind] ?? busy.goal}". Try again when it finishes.`)

  const deps = args.deps ?? (await depsFor(args.workspaceId))
  const [row] = await db
    .insert(agentRuns)
    .values({ workspaceId: args.workspaceId, goal: args.goal, question: args.question?.slice(0, 2000) ?? null, trigger: args.trigger, startedBy: args.actorId, model: deps.model?.id ?? 'simulator', simulated: deps.model?.simulated ?? true, ...(args.at ? { startedAt: args.at } : {}) })
    .returning()

  const started = Date.now()
  try {
    const r = await runGoal(args.goal, deps.businessId, deps, undefined, args.question)
    const [done] = await db
      .update(agentRuns)
      .set({
        status: r.stoppedBecause === 'model_error' ? 'failed' : 'done',
        report: r.report,
        dropped: r.dropped,
        steps: r.steps.map((s) => ({ n: s.n, tool: s.tool, tier: s.tier, ok: s.ok, summary: s.summary, evidenceIds: s.evidenceIds, ms: s.ms })),
        proposals: r.proposals,
        evidence: r.evidence.map((e) => ({ id: e.id, source: e.source, label: e.label, url: e.url, observedAt: e.observedAt })),
        usage: r.usage,
        stoppedBecause: r.stoppedBecause,
        error: r.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, row!.id))
      .returning()
    await db.insert(aiRuns).values({
      workspaceId: args.workspaceId,
      agent: `growth.${args.goal}`,
      provider: r.simulated ? 'simulator' : env().AI_PROVIDER,
      model: r.model.slice(0, 64),
      promptTokens: r.usage.input,
      completionTokens: r.usage.output,
      costUsd: (r.simulated ? 0 : priceOf(r.model, r.usage.input, r.usage.output)).toFixed(6),
      latencyMs: Date.now() - started,
      ok: r.stoppedBecause !== 'model_error',
      error: r.error ?? null,
      subjectType: 'agent_run',
      subjectId: row!.id,
      userId: args.actorId,
    })
    const created = r.proposals.filter((p) => p.status === 'created' || p.status === 'sent' || p.status === 'draft')
    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      actorType: args.actorId ? 'user' : 'system',
      action: 'agent.run_completed',
      subjectType: 'agent_run',
      subjectId: row!.id,
      summary: `Growth agent ${GOAL_LABEL[args.goal].toLowerCase()} (${args.trigger}${r.simulated ? ', simulated' : ''}): ${r.steps.length} steps, ${created.length} things created${r.dropped.length ? `, ${r.dropped.length} unsupported sentences removed` : ''}.`,
      payload: {
        goal: args.goal,
        trigger: args.trigger,
        model: r.model,
        stoppedBecause: r.stoppedBecause,
        tools: r.steps.map((s) => s.tool),
        proposals: r.proposals.map((p) => ({ kind: p.kind, status: p.status, ref: p.ref ?? null })),
      },
    })
    if (args.trigger === 'schedule' && (created.length || /\[act\]/.test(r.steps.map((s) => s.summary).join('\n')))) {
      await notifyRun(args.workspaceId, done!, created.length)
    }
    return done!
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const [failed] = await db
      .update(agentRuns)
      .set({ status: 'failed', error: message.slice(0, 500), finishedAt: new Date() })
      .where(eq(agentRuns.id, row!.id))
      .returning()
    await recordAudit({ workspaceId: args.workspaceId, actorId: args.actorId, actorType: args.actorId ? 'user' : 'system', action: 'agent.run_failed', subjectType: 'agent_run', subjectId: row!.id, summary: `Growth agent ${GOAL_LABEL[args.goal].toLowerCase()} failed: ${message.slice(0, 200)}`, payload: { goal: args.goal } })
    return failed!
  }
}

async function notifyRun(workspaceId: string, run: AgentRun, created: number) {
  const people = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['owner', 'admin', 'strategist'])))
  if (!people.length) return
  const first = (run.report ?? '').split('\n').find((l) => l.startsWith('- '))?.replace(/^- /, '').replace(/\s*\[E\d+\]/g, '') ?? null
  await db.insert(notifications).values(
    people.map((p) => ({
      workspaceId,
      userId: p.userId,
      type: 'agent.run',
      title: `Growth agent: ${GOAL_LABEL[run.goal as GoalKind].toLowerCase()}${created ? `, ${created} new` : ''}`,
      body: first,
      href: `/agent/runs/${run.id}`,
    })),
  )
}

export async function listRuns(workspaceId: string, limit = 20): Promise<AgentRun[]> {
  return db.select().from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId)).orderBy(desc(agentRuns.startedAt)).limit(limit)
}

export async function getRun(workspaceId: string, id: string): Promise<AgentRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [r] = await db.select().from(agentRuns).where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.id, id))).limit(1)
  return r ?? null
}

/** The CRM's view of outreach for this business, for the screen. Null when the CRM can't be reached. */
export async function crmBusiness(workspaceId: string): Promise<CrmBusiness | null> {
  try {
    const c = await getConnection(workspaceId)
    if (!c?.crmBusinessId) return null
    const crm: CrmPort = await crmFor(workspaceId)
    return (await crm.businessProfile()).find((b) => b.id === c.crmBusinessId) ?? null
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- schedule */

/**
 * Called by the worker and the cron route. UK time, weekdays only:
 *   07:40  daily brief
 *   09:10  find leads (Mondays and Thursdays)
 *   09:40  send due emails (only if switched on here AND in the CRM)
 * Each at most once a day. Returns what it started.
 */
export async function agentTick(workspaceId: string, now = new Date(), deps?: GrowthAgentDeps & { businessId: number }): Promise<string[]> {
  const c = await getConnection(workspaceId)
  if (!c?.crmTokenEnc || !c.crmBusinessId) return []
  const { dow, hr } = londonDayHour(now)
  const min = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', minute: 'numeric' }).format(now))
  if (dow === 0 || dow === 6) return []
  const at = (h: number, m: number) => hr > h || (hr === h && min >= m)
  const dayStart = new Date(now.getTime() - (hr * 60 + min) * 60_000 - 60_000)
  const ranToday = async (goal: GoalKind) =>
    (await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.goal, goal), eq(agentRuns.trigger, 'schedule'), gte(agentRuns.startedAt, dayStart))).limit(1)).length > 0

  const due: GoalKind[] = []
  if (c.schedule.dailyBrief && at(7, 40) && hr < 12 && !(await ranToday('daily_brief'))) due.push('daily_brief')
  if (c.schedule.findLeads && (dow === 1 || dow === 4) && at(9, 10) && hr < 16 && !(await ranToday('find_leads'))) due.push('find_leads')
  if (c.schedule.outreach && c.crmScopes.includes('outreach') && at(9, 40) && hr < 16 && !(await ranToday('outreach'))) due.push('outreach')

  const started: string[] = []
  for (const goal of due) {
    try {
      const r = await startRun({ workspaceId, goal, actorId: null, trigger: 'schedule', deps, at: now })
      started.push(`${goal}:${r.status}`)
    } catch (e) {
      started.push(`${goal}:skipped (${e instanceof Error ? e.message : 'error'})`)
      break
    }
  }
  return started
}

/** The businesses the saved CRM token may use, for the chooser. */
export async function crmBusinesses(workspaceId: string): Promise<{ id: number; name: string }[]> {
  try {
    const me = await (await crmFor(workspaceId)).whoami()
    return me.businesses.map((b: { id: number; name: string }) => ({ id: b.id, name: b.name }))
  } catch {
    return []
  }
}
