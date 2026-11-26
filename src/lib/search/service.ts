import 'server-only'
import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  searchLeads,
  serpTwinActions,
  serpTwinProfiles,
  serpTwinRuns,
  type SearchLead,
  type SerpTwinAction,
  type SerpTwinRun,
} from '@/lib/db/schema'
import { canonical, recordAudit } from '@/lib/workflow/audit'
import { GateError, submitForReview } from '@/lib/workflow/approvals'
import {
  runSerpTwin,
  type BusinessProfile,
  type Lead,
  type LeadOutcome,
  type Recommendation,
} from '@/lib/serptwin'
import { simulate } from '@/lib/serptwin/simulator'

/**
 * PPC + SEO (SERP Twin) — the stateful side.
 *
 * The engine in `lib/serptwin` is pure and knows nothing about workspaces,
 * approvals or the database. This module is the only place that stores a
 * report, turns a recommendation into something that can be approved, and
 * records what was applied — so every path that changes a live ad or page
 * goes through the approval engine and leaves a hash-chained audit entry.
 *
 * Data source. Until Google Ads and Search Console are both connected, runs
 * use the simulator and are stored with `source: 'simulated'`, and every
 * apply is recorded as simulated. Nothing is ever presented as live when it
 * was not — the same rule the Google Ads push follows.
 */

export class SearchError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'SearchError'
  }
}

export const DEFAULT_SEED = 20260927

export function hashReport(report: unknown): string {
  return createHash('sha256').update(canonical(report)).digest('hex')
}

/** Run an analysis and store it whole, with its hash. */
export async function runAnalysis(args: {
  workspaceId: string
  actorId: string
  seed?: number
}): Promise<SerpTwinRun> {
  const seed = args.seed ?? DEFAULT_SEED
  const started = Date.now()
  const input = simulate({ seed, preset: await loadDataset(args.workspaceId) })

  // The business profile and the enquiries belong to the workspace, not to the run. The first
  // analysis stores the example ones; after that, what sales and the setup page say is used.
  const profile = await loadProfile(args.workspaceId)
  if (profile) input.business = profile
  else await saveProfile({ workspaceId: args.workspaceId, profile: input.business!, actorId: null })
  const stored = await loadLeads(args.workspaceId)
  if (stored.length > 0) input.leads = stored
  else await seedLeads(args.workspaceId, input.leads ?? [], input.simulated)

  const report = runSerpTwin(input)
  const durationMs = Date.now() - started
  const monthlyImpact = report.recommendations.reduce((s, r) => s + Math.max(0, r.monthlyImpact), 0)
  const reportHash = hashReport(report)

  const [run] = await db
    .insert(serpTwinRuns)
    .values({
      workspaceId: args.workspaceId,
      source: input.simulated ? 'simulated' : 'live',
      seed,
      windowStart: report.window.start || null,
      windowEnd: report.window.end || null,
      report,
      reportHash,
      recommendationCount: report.recommendations.length,
      monthlyImpact,
      durationMs,
      createdBy: args.actorId,
    })
    .returning()

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'search.analysed',
    subjectType: 'search_run',
    subjectId: run.id,
    summary: `PPC & SEO analysis over ${report.summary.queries} searches (${report.window.start} to ${report.window.end})${
      input.simulated ? ', simulated data' : ''
    }: ${report.recommendations.length} recommendations.`,
    payload: { reportHash, seed, source: run.source, recommendations: report.recommendations.length },
  })

  return run
}

export async function latestRun(workspaceId: string): Promise<SerpTwinRun | null> {
  const [run] = await db
    .select()
    .from(serpTwinRuns)
    .where(eq(serpTwinRuns.workspaceId, workspaceId))
    .orderBy(desc(serpTwinRuns.createdAt))
    .limit(1)
  return run ?? null
}

export async function loadRun(workspaceId: string, runId: string): Promise<SerpTwinRun | null> {
  const [run] = await db
    .select()
    .from(serpTwinRuns)
    .where(and(eq(serpTwinRuns.workspaceId, workspaceId), eq(serpTwinRuns.id, runId)))
    .limit(1)
  return run ?? null
}

export async function actionsForRun(workspaceId: string, runId: string): Promise<SerpTwinAction[]> {
  return db
    .select()
    .from(serpTwinActions)
    .where(and(eq(serpTwinActions.workspaceId, workspaceId), eq(serpTwinActions.runId, runId)))
}

export async function loadAction(workspaceId: string, actionId: string): Promise<SerpTwinAction | null> {
  const [row] = await db
    .select()
    .from(serpTwinActions)
    .where(and(eq(serpTwinActions.workspaceId, workspaceId), eq(serpTwinActions.id, actionId)))
    .limit(1)
  return row ?? null
}

/**
 * The action row for a recommendation, created on first use. The
 * recommendation is snapshotted from the stored report, never taken from the
 * client, so what a reviewer approves is exactly what the engine produced.
 */
export async function ensureAction(args: {
  workspaceId: string
  runId: string
  recommendationId: string
  actorId: string
}): Promise<SerpTwinAction> {
  const run = await loadRun(args.workspaceId, args.runId)
  if (!run) throw new SearchError('That analysis no longer exists.')
  if (run.reportHash !== hashReport(run.report)) {
    throw new SearchError('The stored report no longer matches its hash. Run the analysis again.')
  }
  const rec = run.report.recommendations.find((r) => r.id === args.recommendationId)
  if (!rec) throw new SearchError('That recommendation is not part of this analysis.')

  const [existing] = await db
    .select()
    .from(serpTwinActions)
    .where(and(eq(serpTwinActions.runId, run.id), eq(serpTwinActions.recommendationId, rec.id)))
    .limit(1)
  if (existing) return existing

  const [row] = await db
    .insert(serpTwinActions)
    .values({
      workspaceId: args.workspaceId,
      runId: run.id,
      recommendationId: rec.id,
      engine: rec.engine,
      title: rec.title,
      confidence: rec.confidence,
      monthlyImpact: rec.monthlyImpact,
      recommendation: rec,
      simulated: run.source !== 'live',
      createdBy: args.actorId,
    })
    .onConflictDoNothing()
    .returning()
  if (row) return row
  // Lost a race with a second tab; the other insert won, which is fine.
  const [again] = await db
    .select()
    .from(serpTwinActions)
    .where(and(eq(serpTwinActions.runId, run.id), eq(serpTwinActions.recommendationId, rec.id)))
    .limit(1)
  return again
}

export async function submitRecommendation(args: {
  workspaceId: string
  runId: string
  recommendationId: string
  actorId: string
}) {
  const action = await ensureAction(args)
  const result = await submitForReview({
    workspaceId: args.workspaceId,
    subjectType: 'search_action',
    subjectId: action.id,
    actorId: args.actorId,
  })
  return { ...result, actionId: action.id }
}

/**
 * Apply an approved change. Only an approved action at the approved version
 * can be applied, and applying twice is refused. The undo recorded on the
 * recommendation goes into the audit payload before the status changes.
 */
export async function applyAction(args: { workspaceId: string; actionId: string; actorId: string }) {
  const action = await loadAction(args.workspaceId, args.actionId)
  if (!action) throw new SearchError('Not found.')
  if (action.status === 'applied') throw new SearchError('This change has already been applied.')
  if (action.status !== 'approved') {
    throw new GateError('This change has not been approved. Send it for approval first.')
  }

  const gated = action.recommendation.actions.filter((a) => a.requiresApproval)
  const now = new Date()
  await db
    .update(serpTwinActions)
    .set({ status: 'applied', appliedAt: now, appliedBy: args.actorId, updatedAt: now })
    .where(and(eq(serpTwinActions.id, action.id), eq(serpTwinActions.status, 'approved')))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'search.applied',
    subjectType: 'search_action',
    subjectId: action.id,
    summary: `${action.simulated ? 'Simulated: ' : ''}${describeActions(action.recommendation)}`,
    payload: {
      simulated: action.simulated,
      version: action.version,
      actions: gated.map((a) => ({ kind: a.kind, payload: a.payload })),
      undo: gated.map((a) => a.undo),
    },
  })
  return { simulated: action.simulated }
}

export async function revertAction(args: { workspaceId: string; actionId: string; actorId: string }) {
  const action = await loadAction(args.workspaceId, args.actionId)
  if (!action) throw new SearchError('Not found.')
  if (action.status !== 'applied') throw new SearchError('Only an applied change can be reverted.')

  const gated = action.recommendation.actions.filter((a) => a.requiresApproval)
  const now = new Date()
  await db
    .update(serpTwinActions)
    .set({ status: 'reverted', revertedAt: now, updatedAt: now })
    .where(eq(serpTwinActions.id, action.id))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'search.reverted',
    subjectType: 'search_action',
    subjectId: action.id,
    summary: `${action.simulated ? 'Simulated: ' : ''}reverted "${action.title}".`,
    payload: { simulated: action.simulated, undo: gated.map((a) => a.undo) },
  })
}

export function describeActions(rec: Recommendation): string {
  return rec.actions
    .filter((a) => a.requiresApproval)
    .map((a) => a.description)
    .join('; ')
}

/* ------------------------------------------------------------ business profile */

export async function loadProfile(workspaceId: string): Promise<BusinessProfile | null> {
  const [row] = await db
    .select()
    .from(serpTwinProfiles)
    .where(eq(serpTwinProfiles.workspaceId, workspaceId))
    .limit(1)
  return row?.profile ?? null
}

/** The simulated account a workspace runs on until real data is connected. */
export async function loadDataset(workspaceId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ dataset: serpTwinProfiles.dataset })
    .from(serpTwinProfiles)
    .where(eq(serpTwinProfiles.workspaceId, workspaceId))
    .limit(1)
  return row?.dataset
}

export async function saveProfile(args: {
  workspaceId: string
  profile: BusinessProfile
  actorId: string | null
}) {
  const now = new Date()
  await db
    .insert(serpTwinProfiles)
    .values({ workspaceId: args.workspaceId, profile: args.profile, updatedBy: args.actorId, updatedAt: now })
    .onConflictDoUpdate({
      target: serpTwinProfiles.workspaceId,
      set: { profile: args.profile, updatedBy: args.actorId, updatedAt: now },
    })
  if (args.actorId) {
    await recordAudit({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: 'search.profile_updated',
      subjectType: 'search_profile',
      subjectId: args.workspaceId,
      summary: `Business setup saved: ${args.profile.services.length} services, capacity ${args.profile.services
        .map(
          (s) =>
            `${s.name} ${s.weeklyCapacity === null ? 'unlimited' : `${s.bookedThisWeek}/${s.weeklyCapacity}`}`,
        )
        .join(', ')}.`,
      payload: { profile: args.profile },
    })
  }
}

/* ------------------------------------------------------------------- enquiries */

export function toLead(row: SearchLead): Lead {
  return {
    id: row.externalId,
    receivedAt: row.receivedAt.toISOString(),
    source: row.source as Lead['source'],
    gclid: row.gclid,
    campaignId: row.campaignId,
    adGroupId: row.adGroupId,
    searchTerm: row.searchTerm,
    landingPage: row.landingPage,
    serviceId: row.serviceId,
    message: row.message,
    email: row.email,
    phone: row.phone,
    location: row.locationCountry ? { country: row.locationCountry, area: row.locationArea } : null,
    signals: row.signals ?? undefined,
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    contactAttempts: row.contactAttempts,
    outcome: row.outcome as LeadOutcome,
    lostReason: row.lostReason,
    value: row.value,
  }
}

export async function loadLeadRows(workspaceId: string): Promise<SearchLead[]> {
  return db
    .select()
    .from(searchLeads)
    .where(eq(searchLeads.workspaceId, workspaceId))
    .orderBy(desc(searchLeads.receivedAt))
}

export async function loadLeads(workspaceId: string): Promise<Lead[]> {
  return (await loadLeadRows(workspaceId)).map(toLead)
}

async function seedLeads(workspaceId: string, leads: Lead[], simulated: boolean) {
  for (let i = 0; i < leads.length; i += 250) {
    await db
      .insert(searchLeads)
      .values(
        leads.slice(i, i + 250).map((l) => ({
          workspaceId,
          externalId: l.id,
          receivedAt: new Date(l.receivedAt),
          source: l.source,
          gclid: l.gclid ?? null,
          campaignId: l.campaignId ?? null,
          adGroupId: l.adGroupId ?? null,
          searchTerm: l.searchTerm ?? null,
          landingPage: l.landingPage ?? null,
          serviceId: l.serviceId ?? null,
          message: l.message,
          email: l.email ?? null,
          phone: l.phone ?? null,
          locationCountry: l.location?.country ?? null,
          locationArea: l.location?.area ?? null,
          signals: l.signals ?? null,
          firstResponseAt: l.firstResponseAt ? new Date(l.firstResponseAt) : null,
          contactAttempts: l.contactAttempts,
          outcome: l.outcome,
          lostReason: l.lostReason ?? null,
          value: l.value ?? null,
          simulated,
        })),
      )
      .onConflictDoNothing()
  }
}

export const LEAD_OUTCOMES: LeadOutcome[] = ['open', 'won', 'lost', 'unqualified', 'spam']

/**
 * One-click outcome from sales. The reason is free text in their own words; the
 * engine reads it. Contact attempts matter: they are what separates "never
 * answered" from "we never called".
 */
export async function updateLeadOutcome(args: {
  workspaceId: string
  leadId: string
  actorId: string
  outcome: LeadOutcome
  lostReason?: string | null
  contactAttempts?: number
  value?: number | null
}) {
  if (!LEAD_OUTCOMES.includes(args.outcome)) throw new SearchError('Unknown outcome.')
  const [row] = await db
    .select()
    .from(searchLeads)
    .where(and(eq(searchLeads.workspaceId, args.workspaceId), eq(searchLeads.id, args.leadId)))
    .limit(1)
  if (!row) throw new SearchError('That enquiry no longer exists.')
  const attempts = Math.max(0, Math.min(50, Math.floor(args.contactAttempts ?? row.contactAttempts)))
  await db
    .update(searchLeads)
    .set({
      outcome: args.outcome,
      lostReason:
        args.outcome === 'won' || args.outcome === 'open'
          ? null
          : (args.lostReason?.slice(0, 500) ?? row.lostReason),
      contactAttempts: attempts,
      firstResponseAt: row.firstResponseAt ?? (attempts > 0 ? new Date() : null),
      value: args.outcome === 'won' ? (args.value ?? row.value) : null,
      updatedBy: args.actorId,
      updatedAt: new Date(),
    })
    .where(eq(searchLeads.id, row.id))
  // No names or contact details in the audit trail: the id and the outcome are enough.
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'search.lead_updated',
    subjectType: 'search_lead',
    subjectId: row.id,
    summary: `Enquiry ${row.externalId} marked ${args.outcome}${args.lostReason ? ` (“${args.lostReason.slice(0, 80)}”)` : ''}.`,
    payload: { from: row.outcome, to: args.outcome, contactAttempts: attempts },
  })
}

/** Google Ads "Upload clicks" CSV for the verified outcomes in a run. */
export function offlineConversionsCsv(report: SerpTwinRun['report']): string {
  const rows = report.leads?.offlineRows ?? []
  // Local time in Europe/London, as the header row declares; Intl handles GMT/BST.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const fmt = (iso: string) => {
    const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
  }
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [
    'Parameters:TimeZone=Europe/London',
    'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency',
    ...rows.map((r) =>
      [r.gclid, r.conversionName, fmt(r.conversionTime), r.value.toFixed(2), 'GBP'].map(esc).join(','),
    ),
  ].join('\n')
}
