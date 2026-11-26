import 'server-only'
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { CONNECTOR_BY_PROVIDER } from '@/lib/connectors/registry'
import {
  aiRuns,
  approvalChains,
  approvalRequests,
  auditEvents,
  blackoutWindows,
  brandProfiles,
  connectors,
  frequencyCaps,
  invitations,
  legalRules,
  memberships,
  sessions,
  subscriptions,
  usageCounters,
  users,
  workspaces,
  type ApprovalChain,
  type BrandProfile,
  type LegalRule,
  type Role,
  type Subscription,
} from '@/lib/db/schema'

/**
 * Read models for the Settings area.
 *
 * Every figure a Settings screen prints is counted here against live rows. The
 * governance screens in particular have to be trustworthy: if the Brand page
 * claims a rule has fired 14 times, that number is a count of real findings on
 * real assets, not an estimate.
 */

/* ------------------------------------------------------------- overview */

export type GovernanceSummary = {
  members: number
  pendingInvites: number
  connectorsConnected: number
  connectorsConfigured: number
  connectorsUnhealthy: number
  activeChains: number
  chainSteps: number
  legalRulesActive: number
  legalRulesTotal: number
  brandProfiles: number
  bannedTerms: number
  disclaimers: number
  auditEvents: number
  firstEventAt: Date | null
  lastEventAt: Date | null
  assetsScored: number
  assetsPassed: number
  blackouts: number
  frequencyCaps: number
  pendingApprovals: number
}

export async function governanceSummary(workspaceId: string): Promise<GovernanceSummary> {
  // One round trip: the overview is a header, not a report, and should never
  // cost eleven queries to render.
  const rows = (await db.execute(sql`
    select
      (select count(*) from memberships where workspace_id = ${workspaceId})::int as members,
      (select count(*) from invitations where workspace_id = ${workspaceId} and accepted_at is null and expires_at > now())::int as pending_invites,
      (select count(*) from connectors where workspace_id = ${workspaceId} and status = 'connected')::int as connectors_connected,
      (select count(*) from connectors where workspace_id = ${workspaceId})::int as connectors_configured,
      (select count(*) from connectors where workspace_id = ${workspaceId} and status in ('degraded','error'))::int as connectors_unhealthy,
      (select count(*) from approval_chains where workspace_id = ${workspaceId} and active)::int as active_chains,
      (select coalesce(sum(jsonb_array_length(steps)), 0) from approval_chains where workspace_id = ${workspaceId} and active)::int as chain_steps,
      (select count(*) from legal_rules where workspace_id = ${workspaceId} and active)::int as legal_rules_active,
      (select count(*) from legal_rules where workspace_id = ${workspaceId})::int as legal_rules_total,
      (select count(*) from brand_profiles where workspace_id = ${workspaceId})::int as brand_profiles,
      (select coalesce(sum(jsonb_array_length(banned_terms)), 0) from brand_profiles where workspace_id = ${workspaceId})::int as banned_terms,
      (select coalesce(sum(jsonb_array_length(required_disclaimers)), 0) from brand_profiles where workspace_id = ${workspaceId})::int as disclaimers,
      (select count(*) from audit_events where workspace_id = ${workspaceId})::int as audit_events,
      (select min(created_at) from audit_events where workspace_id = ${workspaceId}) as first_event_at,
      (select max(created_at) from audit_events where workspace_id = ${workspaceId}) as last_event_at,
      (select count(*) from assets where workspace_id = ${workspaceId} and score_detail is not null)::int as assets_scored,
      (select count(*) from assets where workspace_id = ${workspaceId} and (score_detail ->> 'passed')::boolean)::int as assets_passed,
      (select count(*) from blackout_windows where workspace_id = ${workspaceId})::int as blackouts,
      (select count(*) from frequency_caps where workspace_id = ${workspaceId})::int as frequency_caps,
      (select count(*) from approval_requests where workspace_id = ${workspaceId} and status = 'pending')::int as pending_approvals
  `)) as unknown as Record<string, string | number | Date | null>[]

  const r = rows[0] ?? {}
  const n = (k: string) => Number(r[k] ?? 0)
  const d = (k: string) => (r[k] ? new Date(r[k] as string | Date) : null)

  return {
    members: n('members'),
    pendingInvites: n('pending_invites'),
    connectorsConnected: n('connectors_connected'),
    connectorsConfigured: n('connectors_configured'),
    connectorsUnhealthy: n('connectors_unhealthy'),
    activeChains: n('active_chains'),
    chainSteps: n('chain_steps'),
    legalRulesActive: n('legal_rules_active'),
    legalRulesTotal: n('legal_rules_total'),
    brandProfiles: n('brand_profiles'),
    bannedTerms: n('banned_terms'),
    disclaimers: n('disclaimers'),
    auditEvents: n('audit_events'),
    firstEventAt: d('first_event_at'),
    lastEventAt: d('last_event_at'),
    assetsScored: n('assets_scored'),
    assetsPassed: n('assets_passed'),
    blackouts: n('blackouts'),
    frequencyCaps: n('frequency_caps'),
    pendingApprovals: n('pending_approvals'),
  }
}

/* ---------------------------------------------------------------- brand */

export async function brandGovernance(
  workspaceId: string,
): Promise<{ profiles: BrandProfile[]; rules: LegalRule[] }> {
  const [profiles, rules] = await Promise.all([
    db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.workspaceId, workspaceId))
      .orderBy(desc(brandProfiles.isDefault), asc(brandProfiles.name)),
    db
      .select()
      .from(legalRules)
      .where(eq(legalRules.workspaceId, workspaceId))
      .orderBy(asc(legalRules.createdAt)),
  ])
  return { profiles, rules }
}

export type BrandImpact = {
  scored: number
  passed: number
  avgComposite: number | null
  avgBrand: number | null
  avgCompliance: number | null
  edited: number
  /** How often each rule actually caught something — the case for keeping it. */
  findings: { rule: string; severity: string; hits: number }[]
}

export async function brandImpact(workspaceId: string): Promise<BrandImpact> {
  const [totals, findings] = await Promise.all([
    db.execute(sql`
      select
        count(*)::int as scored,
        count(*) filter (where (score_detail ->> 'passed')::boolean)::int as passed,
        count(*) filter (where edited_by_human)::int as edited,
        avg(composite_score)::float as avg_composite,
        avg(brand_score)::float as avg_brand,
        avg(compliance_score)::float as avg_compliance
      from assets
      where workspace_id = ${workspaceId} and score_detail is not null
    `),
    // Findings are stored inside each asset's score payload, so the only honest
    // way to say "this rule caught 14 things" is to unnest them.
    db.execute(sql`
      select
        f ->> 'ruleName' as rule,
        coalesce(f ->> 'severity', 'low') as severity,
        count(*)::int as hits
      from assets a
      cross join lateral jsonb_array_elements(a.score_detail -> 'compliance' -> 'findings') f
      where a.workspace_id = ${workspaceId} and a.score_detail is not null
      group by 1, 2
      order by hits desc
      limit 8
    `),
  ])

  const t = ((totals as unknown as Record<string, number | null>[])[0] ?? {}) as Record<string, number | null>
  const f = findings as unknown as { rule: string; severity: string; hits: number }[]

  return {
    scored: Number(t.scored ?? 0),
    passed: Number(t.passed ?? 0),
    edited: Number(t.edited ?? 0),
    avgComposite: t.avg_composite === null || t.avg_composite === undefined ? null : Number(t.avg_composite),
    avgBrand: t.avg_brand === null || t.avg_brand === undefined ? null : Number(t.avg_brand),
    avgCompliance:
      t.avg_compliance === null || t.avg_compliance === undefined ? null : Number(t.avg_compliance),
    findings: f.map((x) => ({ rule: x.rule ?? 'Unnamed rule', severity: x.severity, hits: Number(x.hits) })),
  }
}

/* ------------------------------------------------------------ approvals */

export type ChainRow = {
  chain: ApprovalChain
  requests: number
  pending: number
  avgResolutionMs: number | null
  /** Steps whose role nobody in the workspace holds — a chain that would stall. */
  unstaffedSteps: string[]
}

export async function chainOverview(workspaceId: string): Promise<{
  chains: ChainRow[]
  roleHeadcount: Record<string, number>
}> {
  const [chains, headcount] = await Promise.all([
    db
      .select({
        chain: approvalChains,
        /* Table-qualified by hand: inside a select-list fragment Drizzle emits a
           bare "id", which a correlated subquery resolves against its own FROM. */
        requests: sql<number>`(select count(*) from approval_requests r where r.chain_id = approval_chains.id)::int`,
        pending: sql<number>`(select count(*) from approval_requests r where r.chain_id = approval_chains.id and r.status = 'pending')::int`,
        avgResolutionMs: sql<number | null>`(select avg(r.resolution_ms) from approval_requests r where r.chain_id = approval_chains.id and r.status = 'approved')::float`,
      })
      .from(approvalChains)
      .where(eq(approvalChains.workspaceId, workspaceId))
      .orderBy(desc(approvalChains.priority), asc(approvalChains.name)),
    db
      .select({ role: memberships.role, n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspaceId))
      .groupBy(memberships.role),
  ])

  const roleHeadcount: Record<string, number> = {}
  for (const h of headcount) roleHeadcount[h.role] = Number(h.n)

  return {
    roleHeadcount,
    chains: chains.map((c) => ({
      chain: c.chain,
      requests: Number(c.requests ?? 0),
      pending: Number(c.pending ?? 0),
      avgResolutionMs: c.avgResolutionMs === null ? null : Number(c.avgResolutionMs),
      unstaffedSteps: c.chain.steps
        .filter((s) => !(s.approverIds?.length ?? 0) && !roleHeadcount[s.role])
        .map((s) => s.name),
    })),
  }
}

export async function schedulingGuards(workspaceId: string) {
  const [windows, caps] = await Promise.all([
    db
      .select()
      .from(blackoutWindows)
      .where(eq(blackoutWindows.workspaceId, workspaceId))
      .orderBy(asc(blackoutWindows.startsAt)),
    db
      .select()
      .from(frequencyCaps)
      .where(eq(frequencyCaps.workspaceId, workspaceId))
      .orderBy(asc(frequencyCaps.channel)),
  ])
  return { windows, caps }
}

/** Recent approval throughput, so chain edits can be judged against outcomes. */
export async function approvalThroughput(workspaceId: string) {
  const rows = (await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'approved')::int as approved,
      count(*) filter (where status = 'rejected')::int as rejected,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'pending' and due_at < now())::int as overdue,
      avg(resolution_ms) filter (where status = 'approved')::float as avg_ms
    from approval_requests
    where workspace_id = ${workspaceId}
  `)) as unknown as Record<string, number | null>[]
  const r = rows[0] ?? {}
  return {
    total: Number(r.total ?? 0),
    approved: Number(r.approved ?? 0),
    rejected: Number(r.rejected ?? 0),
    pending: Number(r.pending ?? 0),
    overdue: Number(r.overdue ?? 0),
    avgMs: r.avg_ms === null || r.avg_ms === undefined ? null : Number(r.avg_ms),
  }
}

/* -------------------------------------------------------------- members */

export type MemberRow = {
  membershipId: string
  userId: string
  name: string
  email: string
  jobTitle: string | null
  avatarHue: number
  role: Role
  joinedAt: Date
  lastLoginAt: Date | null
  assetsCreated: number
  decisions: number
  auditEvents: number
}

export async function memberDirectory(workspaceId: string): Promise<MemberRow[]> {
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      jobTitle: users.jobTitle,
      avatarHue: users.avatarHue,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      lastLoginAt: users.lastLoginAt,
      /* users.id spelled out — see the note in chainOverview. */
      assetsCreated: sql<number>`(select count(*) from assets a where a.workspace_id = ${workspaceId} and a.created_by = users.id)::int`,
      decisions: sql<number>`(select count(*) from approval_decisions d join approval_requests r on r.id = d.request_id where r.workspace_id = ${workspaceId} and d.user_id = users.id)::int`,
      auditEvents: sql<number>`(select count(*) from audit_events e where e.workspace_id = ${workspaceId} and e.actor_id = users.id)::int`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(users.name))

  return rows.map((r) => ({
    ...r,
    assetsCreated: Number(r.assetsCreated ?? 0),
    decisions: Number(r.decisions ?? 0),
    auditEvents: Number(r.auditEvents ?? 0),
  }))
}

export type InvitationRow = {
  id: string
  email: string
  role: Role
  invitedByName: string | null
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
}

export async function pendingInvitations(workspaceId: string): Promise<InvitationRow[]> {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedByName: users.name,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(eq(invitations.workspaceId, workspaceId))
    .orderBy(desc(invitations.createdAt))
}

/* ----------------------------------------------------------- connectors */

export type ConnectorRow = {
  id: string
  provider: string
  category: string
  displayName: string
  status: string
  scopes: string[]
  lastSyncAt: Date | null
  lastError: string | null
  createdAt: Date
  /** Sends actually carried by this connector's channels. */
  publishedItems: number
}

export async function connectorDirectory(workspaceId: string): Promise<ConnectorRow[]> {
  const rows = await db
    .select({
      id: connectors.id,
      provider: connectors.provider,
      category: connectors.category,
      displayName: connectors.displayName,
      status: connectors.status,
      scopes: connectors.scopes,
      lastSyncAt: connectors.lastSyncAt,
      lastError: connectors.lastError,
      createdAt: connectors.createdAt,
    })
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId))
    .orderBy(asc(connectors.displayName))

  // Publish volume is keyed by channel, so attribute it per connector in one
  // grouped query rather than a subselect per row.
  const volume = (await db.execute(sql`
    select channel, count(*)::int as n
    from schedule_items
    where workspace_id = ${workspaceId} and status = 'published'
    group by channel
  `)) as unknown as { channel: string; n: number }[]

  const byChannel = new Map(volume.map((v) => [v.channel, Number(v.n)]))

  return rows.map((r) => ({
    ...r,
    publishedItems: (CONNECTOR_BY_PROVIDER.get(r.provider)?.channels ?? []).reduce(
      (a, c) => a + (byChannel.get(c) ?? 0),
      0,
    ),
  }))
}

/* ---------------------------------------------------------------- audit */

export type AuditFilters = {
  action?: string
  actorId?: string
  subjectType?: string
  q?: string
  page?: number
}

export type AuditRow = {
  id: string
  seq: number
  action: string
  actorType: string
  actorName: string | null
  actorHue: number | null
  subjectType: string
  subjectId: string | null
  summary: string
  payload: Record<string, unknown>
  hash: string
  prevHash: string | null
  createdAt: Date
}

export const AUDIT_PAGE_SIZE = 30

export async function auditFeed(
  workspaceId: string,
  filters: AuditFilters,
): Promise<{ rows: AuditRow[]; total: number; page: number; pages: number }> {
  const page = Math.max(1, filters.page ?? 1)

  const clauses = [eq(auditEvents.workspaceId, workspaceId)]
  if (filters.action) clauses.push(eq(auditEvents.action, filters.action))
  if (filters.actorId) clauses.push(eq(auditEvents.actorId, filters.actorId))
  if (filters.subjectType) clauses.push(eq(auditEvents.subjectType, filters.subjectType))
  if (filters.q?.trim()) {
    const term = `%${filters.q.trim()}%`
    // Matching the summary and the action keeps free text useful without
    // exposing the payload, which can contain long generated copy.
    const fuzzy = or(ilike(auditEvents.summary, term), ilike(auditEvents.action, term))
    if (fuzzy) clauses.push(fuzzy)
  }
  const where = and(...clauses)

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: auditEvents.id,
        seq: auditEvents.seq,
        action: auditEvents.action,
        actorType: auditEvents.actorType,
        actorName: users.name,
        actorHue: users.avatarHue,
        subjectType: auditEvents.subjectType,
        subjectId: auditEvents.subjectId,
        summary: auditEvents.summary,
        payload: auditEvents.payload,
        hash: auditEvents.hash,
        prevHash: auditEvents.prevHash,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(where)
      .orderBy(desc(auditEvents.seq))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where),
  ])

  const total = Number(totals[0]?.n ?? 0)
  return {
    rows: rows.map((r) => ({ ...r, seq: Number(r.seq) })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
  }
}

export async function auditFacets(workspaceId: string) {
  const [actions, actors, subjects] = await Promise.all([
    db
      .select({ action: auditEvents.action, n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId))
      .groupBy(auditEvents.action)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ id: users.id, name: users.name, n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .innerJoin(users, eq(users.id, auditEvents.actorId))
      .where(eq(auditEvents.workspaceId, workspaceId))
      .groupBy(users.id, users.name)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ subjectType: auditEvents.subjectType, n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId))
      .groupBy(auditEvents.subjectType)
      .orderBy(desc(sql`count(*)`)),
  ])
  return {
    actions: actions.map((a) => ({ ...a, n: Number(a.n) })),
    actors: actors.map((a) => ({ ...a, n: Number(a.n) })),
    subjects: subjects.map((s) => ({ ...s, n: Number(s.n) })),
  }
}

/* -------------------------------------------------------------- billing */

export type BillingOverview = {
  subscription: Subscription | null
  seatsUsed: number
  pendingInvites: number
  /** Metered usage for the current calendar month, counted from source tables. */
  usage: {
    assetsGenerated: number
    assetsPublished: number
    contacts: number
    segments: number
    campaigns: number
    aiRuns: number
  }
  counters: { metric: string; value: number; period: string }[]
  ai: {
    runs: number
    costUsd: number
    tokens: number
    cacheHits: number
    failures: number
    avgLatencyMs: number | null
    simulatedRuns: number
  }
  aiByAgent: { agent: string; provider: string; model: string; runs: number; costUsd: number; tokens: number }[]
  aiByMonth: { period: string; runs: number; costUsd: number }[]
}

export async function billingOverview(workspaceId: string): Promise<BillingOverview> {
  const monthStart = sql`date_trunc('month', now())`

  const [subRow, seats, invites, usageRows, aiTotals, byAgent, byMonth, counters] = await Promise.all([
    db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          sql`${invitations.acceptedAt} is null and ${invitations.expiresAt} > now()`,
        ),
      ),
    db.execute(sql`
      select
        (select count(*) from assets where workspace_id = ${workspaceId} and created_at >= ${monthStart})::int as assets_generated,
        (select count(*) from schedule_items where workspace_id = ${workspaceId} and status = 'published' and published_at >= ${monthStart})::int as assets_published,
        (select count(*) from contacts where workspace_id = ${workspaceId})::int as contacts,
        (select count(*) from segments where workspace_id = ${workspaceId})::int as segments,
        (select count(*) from campaigns where workspace_id = ${workspaceId} and status not in ('archived'))::int as campaigns,
        (select count(*) from ai_runs where workspace_id = ${workspaceId} and created_at >= ${monthStart})::int as ai_runs
    `),
    db.execute(sql`
      select
        count(*)::int as runs,
        coalesce(sum(cost_usd), 0)::float as cost_usd,
        coalesce(sum(prompt_tokens + completion_tokens), 0)::int as tokens,
        count(*) filter (where cache_hit)::int as cache_hits,
        count(*) filter (where not ok)::int as failures,
        avg(latency_ms)::float as avg_latency,
        count(*) filter (where provider = 'simulator')::int as simulated
      from ai_runs
      where workspace_id = ${workspaceId}
    `),
    db
      .select({
        agent: aiRuns.agent,
        provider: aiRuns.provider,
        model: aiRuns.model,
        runs: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${aiRuns.costUsd}), 0)::float`,
        tokens: sql<number>`coalesce(sum(${aiRuns.promptTokens} + ${aiRuns.completionTokens}), 0)::int`,
      })
      .from(aiRuns)
      .where(eq(aiRuns.workspaceId, workspaceId))
      .groupBy(aiRuns.agent, aiRuns.provider, aiRuns.model)
      .orderBy(desc(sql`count(*)`)),
    db.execute(sql`
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as period,
             count(*)::int as runs,
             coalesce(sum(cost_usd), 0)::float as cost_usd
      from ai_runs
      where workspace_id = ${workspaceId}
      group by 1
      order by 1 desc
      limit 6
    `),
    db
      .select({ metric: usageCounters.metric, value: usageCounters.value, period: usageCounters.period })
      .from(usageCounters)
      .where(eq(usageCounters.workspaceId, workspaceId))
      .orderBy(desc(usageCounters.period)),
  ])

  const u = ((usageRows as unknown as Record<string, number>[])[0] ?? {}) as Record<string, number>
  const a = ((aiTotals as unknown as Record<string, number | null>[])[0] ?? {}) as Record<string, number | null>

  return {
    subscription: subRow[0] ?? null,
    seatsUsed: Number(seats[0]?.n ?? 0),
    pendingInvites: Number(invites[0]?.n ?? 0),
    usage: {
      assetsGenerated: Number(u.assets_generated ?? 0),
      assetsPublished: Number(u.assets_published ?? 0),
      contacts: Number(u.contacts ?? 0),
      segments: Number(u.segments ?? 0),
      campaigns: Number(u.campaigns ?? 0),
      aiRuns: Number(u.ai_runs ?? 0),
    },
    counters: counters.map((c) => ({ metric: c.metric, value: Number(c.value), period: c.period })),
    ai: {
      runs: Number(a.runs ?? 0),
      costUsd: Number(a.cost_usd ?? 0),
      tokens: Number(a.tokens ?? 0),
      cacheHits: Number(a.cache_hits ?? 0),
      failures: Number(a.failures ?? 0),
      avgLatencyMs: a.avg_latency === null || a.avg_latency === undefined ? null : Number(a.avg_latency),
      simulatedRuns: Number(a.simulated ?? 0),
    },
    aiByAgent: (byAgent as { agent: string; provider: string; model: string; runs: number; costUsd: number; tokens: number }[]).map(
      (r) => ({ ...r, runs: Number(r.runs), costUsd: Number(r.costUsd), tokens: Number(r.tokens) }),
    ),
    aiByMonth: (byMonth as unknown as { period: string; runs: number; cost_usd: number }[]).map((r) => ({
      period: r.period,
      runs: Number(r.runs),
      costUsd: Number(r.cost_usd),
    })),
  }
}

/* -------------------------------------------------------------- profile */

export type ProfileData = {
  user: {
    id: string
    name: string
    email: string
    jobTitle: string | null
    avatarHue: number
    createdAt: Date
    lastLoginAt: Date | null
    hasPassword: boolean
    ssoSubject: string | null
  }
  memberships: { workspaceId: string; workspaceName: string; slug: string; role: Role; joinedAt: Date }[]
  sessions: {
    id: string
    userAgent: string | null
    ip: string | null
    createdAt: Date
    expiresAt: Date
    current: boolean
  }[]
  activity: { seq: number; action: string; summary: string; createdAt: Date }[]
  contribution: { assets: number; decisions: number; campaigns: number; segments: number }
}

export async function accountProfile(
  userId: string,
  workspaceId: string,
  currentSessionId: string,
): Promise<ProfileData | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!row) return null

  const [spaces, sessionRows, activity, contribution] = await Promise.all([
    db
      .select({
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        slug: workspaces.slug,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(workspaces.name)),
    db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), sql`${sessions.expiresAt} > now()`))
      .orderBy(desc(sessions.createdAt))
      .limit(8),
    db
      .select({
        seq: auditEvents.seq,
        action: auditEvents.action,
        summary: auditEvents.summary,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.actorId, userId)))
      .orderBy(desc(auditEvents.seq))
      .limit(8),
    db.execute(sql`
      select
        (select count(*) from assets where workspace_id = ${workspaceId} and created_by = ${userId})::int as assets,
        (select count(*) from approval_decisions d join approval_requests r on r.id = d.request_id
          where r.workspace_id = ${workspaceId} and d.user_id = ${userId})::int as decisions,
        (select count(*) from campaigns where workspace_id = ${workspaceId} and owner_id = ${userId})::int as campaigns,
        (select count(*) from segments where workspace_id = ${workspaceId} and created_by = ${userId})::int as segments
    `),
  ])

  const c = ((contribution as unknown as Record<string, number>[])[0] ?? {}) as Record<string, number>

  return {
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      jobTitle: row.jobTitle,
      avatarHue: row.avatarHue,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      hasPassword: Boolean(row.passwordHash),
      ssoSubject: row.ssoSubject,
    },
    memberships: spaces,
    sessions: sessionRows.map((s) => ({ ...s, current: s.id === currentSessionId })),
    activity: activity.map((a) => ({ ...a, seq: Number(a.seq) })),
    contribution: {
      assets: Number(c.assets ?? 0),
      decisions: Number(c.decisions ?? 0),
      campaigns: Number(c.campaigns ?? 0),
      segments: Number(c.segments ?? 0),
    },
  }
}
