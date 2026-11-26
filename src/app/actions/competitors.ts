'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/session'
import { assertCan, ForbiddenError } from '@/lib/auth/rbac'
import {
  addCompetitorManually,
  buildLandscapeFor,
  CompetitorError,
  confirmProfile,
  draftProfile,
  findCompanies,
  runDiscovery,
  scanCompetitor,
  scanSelf,
  setCompetitorStatus,
  trackedWithScans,
} from '@/lib/competitors/service'
import { ApiError, FetchRefused } from '@/lib/competitors/sources/http'
import type { CompanyProfile, SourceRun } from '@/lib/competitors/types'
import type { RegisterHit } from '@/lib/competitors/sources/register'
import type { ActionResult } from './content'

/**
 * Server actions for Competitors. Thin on purpose: authenticate, check the
 * permission, call the service, turn a refusal into a sentence.
 *
 * A full refresh is several calls driven by the page (discover, then one scan
 * per competitor, then the landscape) rather than one long request, so a slow
 * website cannot time the whole thing out and the page can show progress.
 */

const failure = (e: unknown, fallback: string): ActionResult<never> => {
  if (e instanceof CompetitorError || e instanceof ForbiddenError || e instanceof FetchRefused) {
    return { ok: false, message: e.message }
  }
  if (e instanceof ApiError) return { ok: false, message: `${fallback} ${e.message}` }
  console.error('competitors action failed', e)
  return { ok: false, message: fallback }
}

async function authorised() {
  const auth = await requireAuth()
  assertCan(auth.role, 'competitor:analyse')
  return auth
}

const DENIED = 'Only owners, marketing ops and growth marketers can run competitor analysis.'

function revalidate(id?: string) {
  revalidatePath('/competitors')
  if (id) revalidatePath(`/competitors/${id}`)
}

export async function findCompaniesAction(query: string): Promise<ActionResult<RegisterHit[]>> {
  try {
    await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const hits = await findCompanies(query)
    return { ok: true, message: `${hits.length} matches.`, data: hits }
  } catch (e) {
    return failure(e, 'Could not search Companies House.')
  }
}

export async function draftProfileAction(input: {
  companyNumber?: string | null
  companyName?: string
  domain?: string | null
  postcode?: string | null
}): Promise<ActionResult<CompanyProfile>> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const profile = await draftProfile({ workspaceId: auth.workspace.id, userId: auth.user.id, ...input })
    return { ok: true, message: 'Check the profile, then save it.', data: profile }
  } catch (e) {
    return failure(e, 'Could not read that company.')
  }
}

const profileSchema = z.object({
  companyName: z.string().trim().min(2, 'Enter your company name.').max(160),
  companyNumber: z.string().trim().max(16).nullable(),
  sicCodes: z.array(z.string().regex(/^\d{5}$/)).max(6),
  domain: z.string().trim().max(200).nullable(),
  postcode: z.string().trim().max(10).nullable(),
  locality: z.string().trim().max(80).nullable(),
  lat: z.number().min(49).max(61).nullable(),
  lng: z.number().min(-9).max(3).nullable(),
  businessType: z.string().trim().min(2, 'Say what the business does.').max(80),
  keywords: z
    .array(z.string().trim().min(2).max(60))
    .min(1, 'Add at least one search customers use to find you.')
    .max(10, 'Ten searches at most: each one is searched for every competitor.'),
  scope: z.enum(['local', 'hybrid', 'national']),
  confidence: z.number().min(0).max(1),
  radiusKm: z.number().min(1).max(50),
  source: z.enum(['ai', 'rules', 'manual']),
})

export async function saveProfileAction(profile: CompanyProfile): Promise<ActionResult<CompanyProfile>> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  const parsed = profileSchema.safeParse(profile)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    return { ok: false, message: `${i?.path.join(' → ') || 'Profile'}: ${i?.message ?? 'not valid'}` }
  }
  try {
    const saved = await confirmProfile({ workspaceId: auth.workspace.id, actorId: auth.user.id, profile: parsed.data })
    revalidate()
    revalidatePath('/competitors/setup')
    return { ok: true, message: 'Saved.', data: saved }
  } catch (e) {
    return failure(e, 'Could not save the profile.')
  }
}

export async function discoverAction(): Promise<
  ActionResult<{ tracked: { id: string; name: string }[]; simulated: boolean; runs: SourceRun[]; added: number }>
> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const r = await runDiscovery({ workspaceId: auth.workspace.id, actorId: auth.user.id })
    const tracked = await trackedWithScans(auth.workspace.id)
    revalidate()
    return {
      ok: true,
      message: r.simulated
        ? `No discovery source returned results, so a simulated market of ${r.added || r.updated} competitors was generated.`
        : `Found ${r.added} new competitor${r.added === 1 ? '' : 's'}${r.tracked ? `; tracking the top ${r.tracked}` : ''}.`,
      data: {
        tracked: tracked.map((t) => ({ id: t.competitor.id, name: t.competitor.name })),
        simulated: r.simulated,
        runs: r.runs,
        added: r.added,
      },
    }
  } catch (e) {
    return failure(e, 'Discovery failed.')
  }
}

export async function setCompetitorStatusAction(
  id: string,
  status: 'tracked' | 'suggested' | 'dismissed',
): Promise<ActionResult> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const c = await setCompetitorStatus({ workspaceId: auth.workspace.id, actorId: auth.user.id, id, status })
    revalidate(id)
    return {
      ok: true,
      message:
        status === 'tracked'
          ? `Tracking ${c.name}. Scan it to include it in the analysis.`
          : status === 'dismissed'
            ? `${c.name} dismissed. It will not be suggested again.`
            : `${c.name} is no longer tracked.`,
    }
  } catch (e) {
    return failure(e, 'Could not update that competitor.')
  }
}

export async function addCompetitorAction(input: { name: string; domain: string }): Promise<ActionResult<{ id: string }>> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const c = await addCompetitorManually({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      name: input.name,
      domain: input.domain.trim() || null,
    })
    revalidate()
    return { ok: true, message: `${c.name} added and tracked.`, data: { id: c.id } }
  } catch (e) {
    return failure(e, 'Could not add that competitor.')
  }
}

export async function scanSelfAction(): Promise<ActionResult> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const s = await scanSelf({ workspaceId: auth.workspace.id, actorId: auth.user.id })
    return { ok: true, message: `Read your own presence: ${s.snapshot.pages.length} pages, ${s.snapshot.blog.posts.length} posts.` }
  } catch (e) {
    return failure(e, 'Could not read your own website.')
  }
}

export async function scanCompetitorAction(id: string): Promise<ActionResult<{ changes: number; threat: number | null }>> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const s = await scanCompetitor({ workspaceId: auth.workspace.id, actorId: auth.user.id, competitorId: id })
    revalidate(id)
    return {
      ok: true,
      message: `${s.snapshot.name} scanned${s.changes.length ? `: ${s.changes.map((c) => c.summary.toLowerCase()).join(', ')}` : ''}.`,
      data: { changes: s.changes.length, threat: s.analysis?.threat.score ?? null },
    }
  } catch (e) {
    return failure(e, 'Could not scan that competitor.')
  }
}

export async function buildLandscapeAction(): Promise<ActionResult<{ plays: number }>> {
  let auth
  try {
    auth = await authorised()
  } catch {
    return { ok: false, message: DENIED }
  }
  try {
    const l = await buildLandscapeFor({ workspaceId: auth.workspace.id, actorId: auth.user.id })
    revalidate()
    return { ok: true, message: `Analysis updated: ${l.report.plays.length} plays.`, data: { plays: l.report.plays.length } }
  } catch (e) {
    return failure(e, 'Could not build the analysis.')
  }
}
