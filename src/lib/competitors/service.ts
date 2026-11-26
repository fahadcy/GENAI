import 'server-only'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  competitorLandscapes,
  competitorProfiles,
  competitors,
  competitorScans,
  memberships,
  notifications,
  type Competitor,
  type CompetitorContextRef,
  type CompetitorLandscape,
  type CompetitorScan,
} from '@/lib/db/schema'
import { env } from '@/lib/env'
import { canonical, recordAudit } from '@/lib/workflow/audit'
import { CLAIM_LABEL } from '@/lib/serptwin/claims'
import { analyseCompetitor, classifyBusiness, synthesiseLandscape } from '@/lib/ai/agents/competitors'
import { buildLandscape, channelActivity, claimsOf, diffSnapshots, PAIN_THEMES, threatScore } from './analysis'
import { collectSnapshot, type ScanTarget } from './collect'
import { buildContextBlock, NOT_A_PROMISE } from './context'
import { candidateKey, emptyCandidate } from './discovery'
import { discover } from './discover'
import { classifyCandidates } from './discovery'
import { verifyAll } from './verify'
import { resolveVocabulary } from './vocab-generate'
import { defaultRadiusKm, normaliseDomain, normalisePostcode, parseSicCodes } from './profile'
import { configured } from './sources/config'
import { geocodePostcode, companyProfile, searchCompanies, type RegisterHit } from './sources/register'
import { readWebsite } from './sources/website'
import type { ClassifiedCandidate, CompanyProfile, LandscapeReport, Scope, SourceRun } from './types'

/**
 * Competitor intelligence — the stateful side.
 *
 * Discovery, scans and the landscape are computed elsewhere (`discover`,
 * `collect`, `analysis` and the agent). This module is the only place that
 * stores them, decides who is notified about a change, and hands the
 * generators their competitive context. Every write leaves a hash-chained
 * audit entry; every stored scan and landscape keeps its sha256, so the
 * evidence a reviewer saw can be re-verified later.
 */

export class CompetitorError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'CompetitorError'
  }
}

export const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** How many competitors the first discovery tracks automatically, so the first scan has something to read. */
export const AUTO_TRACK = 5
/** A hard ceiling on tracked competitors: every one costs a scan. */
export const MAX_TRACKED = 10

/* ---------------------------------------------------------------- profile */

export async function loadProfile(workspaceId: string): Promise<CompanyProfile | null> {
  const [row] = await db.select().from(competitorProfiles).where(eq(competitorProfiles.workspaceId, workspaceId)).limit(1)
  return row?.profile ?? null
}

export async function saveProfile(args: { workspaceId: string; actorId: string | null; profile: CompanyProfile }) {
  await db
    .insert(competitorProfiles)
    .values({ workspaceId: args.workspaceId, profile: args.profile, updatedBy: args.actorId })
    .onConflictDoUpdate({
      target: competitorProfiles.workspaceId,
      set: { profile: args.profile, updatedBy: args.actorId, updatedAt: new Date() },
    })
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'competitors.profile_updated',
    subjectType: 'competitor_profile',
    subjectId: args.workspaceId,
    summary: `Competitor profile set: ${args.profile.companyName}, ${args.profile.businessType} (${args.profile.scope}), ${args.profile.keywords.length} searches.`,
    payload: { scope: args.profile.scope, keywords: args.profile.keywords, source: args.profile.source },
  })
}

export async function findCompanies(query: string): Promise<RegisterHit[]> {
  if (!configured('companies_house')) {
    throw new CompetitorError('Companies House is not connected. Add COMPANIES_HOUSE_API_KEY, or enter your details by hand.')
  }
  const q = query.trim()
  if (q.length < 2) return []
  return searchCompanies(q, 10)
}

/**
 * A profile to confirm, from the register entry or typed details. Reads the
 * company's own home page (when it has one) so the classifier describes what
 * the business says it does, not just its SIC code.
 */
export async function draftProfile(args: {
  workspaceId: string
  userId: string
  companyNumber?: string | null
  companyName?: string
  domain?: string | null
  postcode?: string | null
  sicCodes?: string[]
}): Promise<CompanyProfile> {
  let name = args.companyName?.trim() ?? ''
  let sicCodes = parseSicCodes(args.sicCodes ?? [])
  let postcode = normalisePostcode(args.postcode)
  let locality: string | null = null
  let companyNumber: string | null = null

  if (args.companyNumber) {
    if (!configured('companies_house')) throw new CompetitorError('Companies House is not connected.')
    const reg = await companyProfile(args.companyNumber)
    name = reg.name
    sicCodes = reg.sicCodes
    postcode = postcode ?? reg.postcode
    locality = reg.locality
    companyNumber = reg.companyNumber
  }
  if (!name) throw new CompetitorError('Enter your company name.')

  const domain = normaliseDomain(args.domain)
  const geo = postcode ? await geocodePostcode(postcode) : null

  let site = undefined
  if (domain && env().COMPETITOR_CRAWL === 'on') {
    try {
      const w = await readWebsite(domain, { maxPages: 2 })
      if (w.status === 'ok') site = w.pages
    } catch {
      /* classification still works from the name and SIC codes */
    }
  }

  const guess = await classifyBusiness({ workspaceId: args.workspaceId, userId: args.userId, companyName: name, sicCodes, site })
  return {
    companyName: name,
    companyNumber,
    sicCodes,
    domain,
    postcode,
    locality: geo?.locality ?? locality,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    businessType: guess.businessType,
    keywords: guess.keywords,
    scope: guess.scope,
    confidence: guess.confidence,
    radiusKm: defaultRadiusKm(guess.scope),
    source: guess.source,
  }
}

/** Re-geocode when the postcode changes; keep a person's edits otherwise. */
export async function confirmProfile(args: {
  workspaceId: string
  actorId: string
  profile: CompanyProfile
}): Promise<CompanyProfile> {
  const p = args.profile
  const before = await loadProfile(args.workspaceId)
  const postcode = normalisePostcode(p.postcode)
  let { lat, lng, locality } = p
  if (postcode && (postcode !== before?.postcode || lat === null)) {
    const geo = await geocodePostcode(postcode)
    lat = geo?.lat ?? null
    lng = geo?.lng ?? null
    locality = geo?.locality ?? locality
  }
  const profile: CompanyProfile = { ...p, postcode, lat, lng, locality, domain: normaliseDomain(p.domain) }
  await saveProfile({ workspaceId: args.workspaceId, actorId: args.actorId, profile })
  return profile
}

/* -------------------------------------------------------------- discovery */

export async function runDiscovery(args: { workspaceId: string; actorId: string }): Promise<{
  added: number
  updated: number
  tracked: number
  simulated: boolean
  runs: SourceRun[]
}> {
  const profile = await loadProfile(args.workspaceId)
  if (!profile) throw new CompetitorError('Set up your business first, so discovery knows what to look for.')
  if (profile.keywords.length === 0) throw new CompetitorError('Add at least one search term to your profile.')

  const existing = await db.select().from(competitors).where(eq(competitors.workspaceId, args.workspaceId))
  const byKey = new Map(existing.map((c) => [c.key, c]))
  const byDomain = new Map(existing.filter((c) => c.domain).map((c) => [c.domain!, c]))
  const byPlace = new Map(existing.filter((c) => c.placeId).map((c) => [c.placeId!, c]))
  const byCompany = new Map(existing.filter((c) => c.companyNumber).map((c) => [c.companyNumber!, c]))
  // The same business can arrive under a stronger key once its website is
  // known; match on every identity so it is neither duplicated nor revived
  // after a person dismissed it.
  const findExisting = (c: ClassifiedCandidate) =>
    byKey.get(c.key) ??
    (c.domain ? byDomain.get(c.domain) : undefined) ??
    (c.placeId ? byPlace.get(c.placeId) : undefined) ??
    (c.companyNumber ? byCompany.get(c.companyNumber) : undefined)
  const dismissed = new Set(existing.filter((c) => c.status === 'dismissed').map((c) => c.key))
  const firstRun = existing.filter((c) => c.status === 'tracked').length === 0

  const result = await discover(profile, { dismissed, workspaceId: args.workspaceId, userId: args.actorId })
  // Referral-tier businesses are stored too, so the screen can show what was
  // found and ruled out rather than silently dropping it.
  const all = [...result.direct, ...result.indirect, ...result.referral]
  let added = 0
  let updated = 0
  let tracked = 0

  for (const c of all) {
    const prev = findExisting(c)
    if (prev?.status === 'dismissed') continue
    if (prev) {
      const rekey = !prev.key.startsWith('d:') && c.key.startsWith('d:') && !byKey.has(c.key)
      await db
        .update(competitors)
        .set({
          key: rekey ? c.key : prev.key,
          name: prev.status === 'tracked' ? prev.name : c.name,
          domain: prev.domain ?? c.domain,
          placeId: prev.placeId ?? c.placeId,
          companyNumber: prev.companyNumber ?? c.companyNumber,
          kind: c.kind,
          tier: c.tier,
          relevance: c.relevance,
          candidate: c,
          simulated: result.simulated,
          updatedAt: new Date(),
        })
        .where(eq(competitors.id, prev.id))
      updated++
    } else {
      /*
       * Auto-track only what has been checked against its own website — a
       * business whose site could not be read is suggested, never tracked.
       * Where there is no verification to be had at all, because the market
       * is simulated or the crawler is off, the classification stands on its
       * own: the strict rule applies where there is something better to go
       * on, not where it would simply track nobody.
       */
      const autoTrack =
        firstRun &&
        c.kind === 'direct' &&
        (c.verification == null ||
          c.verification.verdict === 'match' ||
          c.sources.includes('manual')) &&
        tracked < AUTO_TRACK
      await db
        .insert(competitors)
        .values({
          workspaceId: args.workspaceId,
          key: c.key,
          name: c.name,
          domain: c.domain,
          placeId: c.placeId,
          companyNumber: c.companyNumber,
          kind: c.kind,
          tier: c.tier,
          status: autoTrack ? 'tracked' : 'suggested',
          relevance: c.relevance,
          candidate: c,
          simulated: result.simulated,
          createdBy: args.actorId,
        })
        .onConflictDoNothing()
      if (autoTrack) tracked++
      added++
    }
  }

  /*
   * Re-score the ones this run did not re-find.
   *
   * Discovery only updates businesses it sees again, and the sources return a
   * slightly different set each time. Without this, a row scored by an older
   * version of the ranking keeps that score for ever — which is how five
   * accountants stayed at the top of a tracked list long after the rule that
   * put them there had been fixed. Anything never checked against its own
   * website gets checked now, whether or not today's search found it.
   */
  const seenIds = new Set<string>()
  for (const c of all) {
    const prev = findExisting(c)
    if (prev) seenIds.add(prev.id)
  }
  const stale = existing.filter(
    (e) => e.status !== 'dismissed' && !seenIds.has(e.id) && !e.candidate.verification && !e.simulated,
  )
  let rescored = 0
  if (stale.length > 0) {
    const { vocab } = await resolveVocabulary({
      workspaceId: args.workspaceId,
      userId: args.actorId,
      profile,
    })
    const checks = await verifyAll(
      stale.map((e) => e.candidate),
      vocab,
    )
    const verified = new Map(
      [...checks.entries()].map(([k, v]) => [
        k,
        {
          verdict: v.verdict,
          confidence: v.confidence,
          note: v.note,
          decidedBy: v.decidedBy,
          serviceTerms: v.evidence ? [...v.evidence.strongHits, ...v.evidence.supportingHits].slice(0, 8) : [],
          otherTradeTerms: v.evidence ? v.evidence.adjacentHits.slice(0, 8) : [],
        },
      ]),
    )
    const regraded = classifyCandidates(
      stale.map((e) => e.candidate),
      profile,
      { verified, maxDirect: 999, maxIndirect: 999, maxReferral: 999 },
    )
    const byKey = new Map(
      [...regraded.direct, ...regraded.indirect, ...regraded.referral].map((c) => [c.key, c]),
    )
    for (const e of stale) {
      const next = byKey.get(e.candidate.key)
      if (!next) continue
      if (next.kind === e.kind && next.relevance === e.relevance) continue
      await db
        .update(competitors)
        .set({ kind: next.kind, relevance: next.relevance, candidate: next, updatedAt: new Date() })
        .where(eq(competitors.id, e.id))
      rescored++
    }
  }

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'competitors.discovered',
    subjectType: 'competitor_profile',
    subjectId: args.workspaceId,
    summary: `Discovery found ${result.direct.length} direct and ${result.indirect.length} indirect competitors, and ruled out ${result.referral.length} as the trade next door${
      result.simulated ? ' (simulated market)' : ''
    }; ${added} new, ${rescored} re-scored. ${result.verified} websites read.`,
    payload: {
      simulated: result.simulated,
      sources: result.runs.map((r) => ({ source: r.source, status: r.status, items: r.items })),
    },
  })

  return { added, updated, tracked, simulated: result.simulated, runs: result.runs }
}

export async function listCompetitors(workspaceId: string): Promise<Competitor[]> {
  return db
    .select()
    .from(competitors)
    .where(eq(competitors.workspaceId, workspaceId))
    .orderBy(desc(competitors.relevance), competitors.name)
}

export async function loadCompetitor(workspaceId: string, id: string): Promise<Competitor | null> {
  const [row] = await db
    .select()
    .from(competitors)
    .where(and(eq(competitors.workspaceId, workspaceId), eq(competitors.id, id)))
    .limit(1)
  return row ?? null
}

export async function setCompetitorStatus(args: {
  workspaceId: string
  actorId: string
  id: string
  status: 'tracked' | 'suggested' | 'dismissed'
}): Promise<Competitor> {
  const c = await loadCompetitor(args.workspaceId, args.id)
  if (!c) throw new CompetitorError('Competitor not found.')
  if (args.status === 'tracked' && c.status !== 'tracked') {
    const count = (await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(and(eq(competitors.workspaceId, args.workspaceId), eq(competitors.status, 'tracked')))).length
    if (count >= MAX_TRACKED) {
      throw new CompetitorError(`You are already tracking ${MAX_TRACKED} competitors. Stop tracking one first; every tracked competitor costs a scan.`)
    }
  }
  const [row] = await db
    .update(competitors)
    .set({ status: args.status, updatedAt: new Date() })
    .where(eq(competitors.id, c.id))
    .returning()
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: args.status === 'tracked' ? 'competitors.tracked' : args.status === 'dismissed' ? 'competitors.dismissed' : 'competitors.untracked',
    subjectType: 'competitor',
    subjectId: c.id,
    summary: `${c.name}: ${args.status === 'tracked' ? 'now tracked' : args.status === 'dismissed' ? 'dismissed, will not be suggested again' : 'no longer tracked'}.`,
  })
  return row
}

export async function addCompetitorManually(args: {
  workspaceId: string
  actorId: string
  name: string
  domain: string | null
}): Promise<Competitor> {
  const name = args.name.trim()
  const domain = normaliseDomain(args.domain)
  if (name.length < 2) throw new CompetitorError('Enter the competitor’s name.')
  if (args.domain && !domain) throw new CompetitorError('That web address does not look right. Try example.co.uk.')
  const profile = await loadProfile(args.workspaceId)
  if (profile?.domain && domain === profile.domain) throw new CompetitorError('That is your own website.')
  const trackedNow = await db
    .select({ key: competitors.key })
    .from(competitors)
    .where(and(eq(competitors.workspaceId, args.workspaceId), eq(competitors.status, 'tracked')))

  const cand = emptyCandidate(name, 'manual')
  cand.domain = domain
  cand.key = candidateKey(cand)
  if (trackedNow.length >= MAX_TRACKED && !trackedNow.some((t) => t.key === cand.key)) {
    throw new CompetitorError(`You are already tracking ${MAX_TRACKED} competitors. Stop tracking one first; every tracked competitor costs a scan.`)
  }
  const classified: ClassifiedCandidate = {
    ...cand,
    kind: 'direct',
    tier: 'national',
    distanceKm: null,
    relevance: 60,
    reasons: ['Added by a person'],
  }
  const [row] = await db
    .insert(competitors)
    .values({
      workspaceId: args.workspaceId,
      key: cand.key,
      name,
      domain,
      kind: 'direct',
      tier: 'national',
      status: 'tracked',
      relevance: 60,
      candidate: classified,
      simulated: false,
      createdBy: args.actorId,
    })
    .onConflictDoUpdate({
      target: [competitors.workspaceId, competitors.key],
      set: { status: 'tracked', name, updatedAt: new Date() },
    })
    .returning()
  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: 'competitors.added',
    subjectType: 'competitor',
    subjectId: row.id,
    summary: `${name}${domain ? ` (${domain})` : ''} added and tracked.`,
  })
  return row
}

/* ------------------------------------------------------------------ scans */

export async function latestScan(workspaceId: string, competitorId: string | null): Promise<CompetitorScan | null> {
  const [row] = await db
    .select()
    .from(competitorScans)
    .where(
      and(
        eq(competitorScans.workspaceId, workspaceId),
        competitorId ? eq(competitorScans.competitorId, competitorId) : eq(competitorScans.isSelf, true),
      ),
    )
    .orderBy(desc(competitorScans.createdAt))
    .limit(1)
  return row ?? null
}

export async function scanHistory(workspaceId: string, competitorId: string, limit = 12) {
  return db
    .select({
      id: competitorScans.id,
      createdAt: competitorScans.createdAt,
      changes: competitorScans.changes,
      simulated: competitorScans.simulated,
      snapshotHash: competitorScans.snapshotHash,
      durationMs: competitorScans.durationMs,
    })
    .from(competitorScans)
    .where(and(eq(competitorScans.workspaceId, workspaceId), eq(competitorScans.competitorId, competitorId)))
    .orderBy(desc(competitorScans.createdAt))
    .limit(limit)
}

/** Read the business's own presence, the baseline every comparison uses. */
export async function scanSelf(args: { workspaceId: string; actorId: string | null }): Promise<CompetitorScan> {
  const profile = await loadProfile(args.workspaceId)
  if (!profile) throw new CompetitorError('Set up your business first.')
  const started = Date.now()
  const snapshot = await collectSnapshot(
    { name: profile.companyName, domain: profile.domain, placeId: null, companyNumber: profile.companyNumber },
    profile,
  )
  const prev = await latestScan(args.workspaceId, null)
  const changes = prev ? diffSnapshots(prev.snapshot, snapshot) : []
  const [row] = await db
    .insert(competitorScans)
    .values({
      workspaceId: args.workspaceId,
      competitorId: null,
      isSelf: true,
      snapshot,
      analysis: null,
      changes,
      snapshotHash: sha256(snapshot),
      simulated: snapshot.simulated,
      durationMs: Date.now() - started,
      createdBy: args.actorId,
    })
    .returning()
  return row
}

export async function scanCompetitor(args: {
  workspaceId: string
  actorId: string | null
  competitorId: string
}): Promise<CompetitorScan> {
  const profile = await loadProfile(args.workspaceId)
  if (!profile) throw new CompetitorError('Set up your business first.')
  const c = await loadCompetitor(args.workspaceId, args.competitorId)
  if (!c) throw new CompetitorError('Competitor not found.')

  const started = Date.now()
  const target: ScanTarget = { name: c.name, domain: c.domain, placeId: c.placeId, companyNumber: c.companyNumber }
  const snapshot = await collectSnapshot(target, profile)
  const prev = await latestScan(args.workspaceId, c.id)
  const changes = prev ? diffSnapshots(prev.snapshot, snapshot) : []

  const channels = channelActivity(snapshot, profile.keywords.length)
  const claims = claimsOf(snapshot)
  const threat = threatScore(snapshot, c.relevance, channels)
  const self = (await latestScan(args.workspaceId, null))?.snapshot ?? null
  const analysis = await analyseCompetitor({
    workspaceId: args.workspaceId,
    userId: args.actorId,
    competitorId: c.id,
    profile,
    snapshot,
    self,
    computed: { claims, channels, threat },
    discoveryReasons: c.candidate.reasons,
  })

  const [row] = await db
    .insert(competitorScans)
    .values({
      workspaceId: args.workspaceId,
      competitorId: c.id,
      isSelf: false,
      snapshot,
      analysis,
      changes,
      snapshotHash: sha256(snapshot),
      simulated: snapshot.simulated,
      durationMs: Date.now() - started,
      createdBy: args.actorId,
    })
    .returning()

  await db
    .update(competitors)
    .set({ lastScannedAt: new Date(), threatScore: threat.score, simulated: snapshot.simulated, updatedAt: new Date() })
    .where(eq(competitors.id, c.id))

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'competitors.scanned',
    subjectType: 'competitor',
    subjectId: c.id,
    summary: `${c.name} scanned${snapshot.simulated ? ' (simulated)' : ''}: threat ${threat.score}/100${
      changes.length ? `; ${changes.map((x) => x.summary.toLowerCase()).join(', ')}` : ''
    }.`,
    payload: {
      snapshotHash: row.snapshotHash,
      sources: snapshot.sources.map((s) => ({ source: s.source, status: s.status, items: s.items })),
      changes: changes.map((x) => x.kind),
    },
  })

  const significant = changes.filter((x) => x.significant)
  if (prev && significant.length) await notifyChange(args.workspaceId, c, significant.map((x) => x.summary))

  return row
}

async function notifyChange(workspaceId: string, c: Competitor, summaries: string[]) {
  const people = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['owner', 'admin', 'strategist'])))
  if (people.length === 0) return
  await db.insert(notifications).values(
    people.map((p) => ({
      workspaceId,
      userId: p.userId,
      type: 'competitor.changed',
      title: `${c.name}: ${summaries[0].toLowerCase()}`,
      body: summaries.length > 1 ? summaries.slice(1).join('; ') : null,
      href: `/competitors/${c.id}`,
    })),
  )
}

/* -------------------------------------------------------------- landscape */

export async function trackedWithScans(workspaceId: string) {
  const tracked = await db
    .select()
    .from(competitors)
    .where(and(eq(competitors.workspaceId, workspaceId), eq(competitors.status, 'tracked')))
    .orderBy(desc(competitors.relevance))
  const out: { competitor: Competitor; scan: CompetitorScan | null }[] = []
  for (const c of tracked) out.push({ competitor: c, scan: await latestScan(workspaceId, c.id) })
  return out
}

export async function buildLandscapeFor(args: { workspaceId: string; actorId: string | null }): Promise<CompetitorLandscape> {
  const profile = await loadProfile(args.workspaceId)
  if (!profile) throw new CompetitorError('Set up your business first.')
  const rows = (await trackedWithScans(args.workspaceId)).filter((r) => r.scan)
  if (rows.length === 0) throw new CompetitorError('Scan at least one tracked competitor first.')
  const self = (await latestScan(args.workspaceId, null))?.snapshot ?? null

  const base = buildLandscape({
    keywords: profile.keywords,
    businessType: profile.businessType,
    selfName: profile.companyName,
    self,
    competitors: rows.map((r) => ({ id: r.competitor.id, name: r.competitor.name, snapshot: r.scan!.snapshot })),
  })
  const narrative = await synthesiseLandscape({
    workspaceId: args.workspaceId,
    userId: args.actorId,
    profile,
    report: base,
    analyses: rows
      .filter((r) => r.scan!.analysis)
      .map((r) => ({ id: r.competitor.id, name: r.competitor.name, analysis: r.scan!.analysis! })),
    self,
  })
  const report: LandscapeReport = { ...base, summary: narrative.summary, differentiators: narrative.differentiators }

  const [row] = await db
    .insert(competitorLandscapes)
    .values({
      workspaceId: args.workspaceId,
      report,
      reportHash: sha256(report),
      simulated: report.simulated,
      createdBy: args.actorId,
    })
    .returning()

  await recordAudit({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    actorType: args.actorId ? 'user' : 'system',
    action: 'competitors.landscape_built',
    subjectType: 'competitor_landscape',
    subjectId: row.id,
    summary: `Competitive landscape over ${rows.length} competitors${report.simulated ? ' (partly simulated)' : ''}: ${report.plays.length} plays.`,
    payload: { reportHash: row.reportHash, plays: report.plays.length },
  })
  return row
}

export async function latestLandscape(workspaceId: string): Promise<CompetitorLandscape | null> {
  const [row] = await db
    .select()
    .from(competitorLandscapes)
    .where(eq(competitorLandscapes.workspaceId, workspaceId))
    .orderBy(desc(competitorLandscapes.createdAt))
    .limit(1)
  return row ?? null
}

/* ---------------------------------------------- context for the generators */

/**
 * The competitive context a generator should use, or null when there is no
 * landscape yet. The caller stores the returned ref with what it generated.
 */
export async function competitorContextFor(workspaceId: string): Promise<CompetitorContextRef | null> {
  const [landscape, profile] = await Promise.all([latestLandscape(workspaceId), loadProfile(workspaceId)])
  if (!landscape || !profile) return null
  const block = buildContextBlock(landscape.report, {
    businessType: profile.businessType,
    keywords: profile.keywords,
    selfName: profile.companyName,
  })
  return {
    landscapeId: landscape.id,
    generatedAt: landscape.report.generatedAt,
    competitorIds: block.competitorIds,
    text: block.text,
    brandNames: block.brandNames,
  }
}

/** What the composers show beside the "use competitor intelligence" switch. */
export async function competitorContextSummary(workspaceId: string): Promise<{
  competitors: number
  generatedAt: string
  simulated: boolean
  highlights: string[]
} | null> {
  const landscape = await latestLandscape(workspaceId)
  if (!landscape) return null
  const r = landscape.report
  const n = Math.max(1, r.competitorIds.length)
  const crowded = r.claims
    .filter((c) => c.competitorsUsing / n >= 0.5 && !NOT_A_PROMISE.has(c.claim))
    .map((c) => CLAIM_LABEL[c.claim].toLowerCase())
  const open = r.claims
    .filter((c) => c.competitorsUsing / n <= 0.25 && !['cta', 'specificity', 'feature', 'urgency'].includes(c.claim))
    .map((c) => CLAIM_LABEL[c.claim].toLowerCase())
  const highlights = [
    crowded.length ? `Avoids sounding like everyone on ${crowded.slice(0, 3).join(', ')}` : '',
    open.length ? `Leans into ${open.slice(0, 3).join(', ')}` : '',
    r.painPoints[0]
      ? `Answers the top complaint about competitors: ${PAIN_THEMES.find((t) => t.theme === r.painPoints[0].theme)?.phrase ?? r.painPoints[0].label.toLowerCase()}`
      : '',
  ].filter(Boolean)
  return { competitors: r.competitorIds.length, generatedAt: r.generatedAt, simulated: r.simulated, highlights }
}

/** Every tracked competitor's brand terms, for the guardrail. Cheap: names only. */
export async function competitorBrandNames(workspaceId: string): Promise<string[]> {
  const ctx = await competitorContextFor(workspaceId)
  return ctx?.brandNames ?? []
}

/* ----------------------------------------------------------------- worker */

/**
 * Rescan tracked competitors whose last scan is older than the configured
 * interval, a few per tick, then rebuild the landscape if anything was
 * rescanned. Called from the worker and the cron route.
 */
export async function refreshDue(workspaceId: string, max = 2): Promise<number> {
  const profile = await loadProfile(workspaceId)
  if (!profile) return 0
  const cutoff = new Date(Date.now() - env().COMPETITOR_RESCAN_DAYS * 86_400_000)
  const due = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(
      and(
        eq(competitors.workspaceId, workspaceId),
        eq(competitors.status, 'tracked'),
        or(isNull(competitors.lastScannedAt), lt(competitors.lastScannedAt, cutoff)),
      ),
    )
    // Never-scanned first: Postgres sorts NULLs last by default.
    .orderBy(sql`${competitors.lastScannedAt} asc nulls first`)
    .limit(max)
  let scanned = 0
  for (const d of due) {
    try {
      await scanCompetitor({ workspaceId, actorId: null, competitorId: d.id })
      scanned++
    } catch (e) {
      // Mark it as tried, so one broken competitor cannot hold the front of the queue forever.
      console.error(`competitor rescan ${d.id} failed`, e)
      await db.update(competitors).set({ lastScannedAt: new Date() }).where(eq(competitors.id, d.id))
    }
  }
  if (scanned) {
    const selfScan = await latestScan(workspaceId, null)
    if (!selfScan || selfScan.createdAt < cutoff) await scanSelf({ workspaceId, actorId: null })
    await buildLandscapeFor({ workspaceId, actorId: null })
  }
  return scanned
}

export type { Scope }
