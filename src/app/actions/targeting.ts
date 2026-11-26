'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { segmentMembers, segments, type SegmentRuleGroup } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { interpretAudience } from '@/lib/ai/agents/segment'
import { buildLookalike, evaluateRules, refreshSegment, type EvaluationResult } from '@/lib/targeting/engine'
import { recordAudit } from '@/lib/workflow/audit'
import { adapterFor } from '@/lib/connectors/adapter'
import type { ActionResult } from './content'

/** AT-1: plain language in, inspectable rules out. */
export async function interpretAudienceAction(query: string): Promise<
  ActionResult<{
    name: string
    rules: SegmentRuleGroup
    interpretation: string
    unmapped: string[]
    evaluation: EvaluationResult
    simulated: boolean
  }>
> {
  const auth = await requireAuth()
  if (!query.trim()) return { ok: false, message: 'Describe the audience you want.' }

  const { result, simulated } = await interpretAudience({
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    query,
  })
  const evaluation = await evaluateRules(auth.workspace.id, result.rules)

  return {
    ok: true,
    message: `${evaluation.matched.toLocaleString()} contacts match.`,
    data: { ...result, evaluation, simulated },
  }
}

/** AT-3: live sizing as the marketer edits the rules by hand. */
export async function evaluateRulesAction(rules: SegmentRuleGroup): Promise<EvaluationResult> {
  const auth = await requireAuth()
  return evaluateRules(auth.workspace.id, rules)
}

export async function saveSegmentAction(input: {
  id?: string
  name: string
  description?: string
  nlQuery?: string
  rules: SegmentRuleGroup
  syncTargets: string[]
}): Promise<ActionResult<{ id: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'segment:create')
  } catch {
    return { ok: false, message: 'Your role cannot create or edit segments.' }
  }

  let id = input.id
  if (id) {
    await db
      .update(segments)
      .set({
        name: input.name,
        description: input.description ?? null,
        nlQuery: input.nlQuery ?? null,
        rules: input.rules,
        syncTargets: input.syncTargets,
      })
      .where(and(eq(segments.workspaceId, auth.workspace.id), eq(segments.id, id)))
  } else {
    const [row] = await db
      .insert(segments)
      .values({
        workspaceId: auth.workspace.id,
        name: input.name,
        description: input.description ?? null,
        nlQuery: input.nlQuery ?? null,
        rules: input.rules,
        sourceType: 'rule',
        syncTargets: input.syncTargets,
        createdBy: auth.user.id,
      })
      .returning({ id: segments.id })
    id = row.id
  }

  const result = await refreshSegment(auth.workspace.id, id!)

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: input.id ? 'segment.refreshed' : 'segment.created',
    subjectType: 'segment',
    subjectId: id!,
    summary: `"${input.name}" — ${result.matched.toLocaleString()} matched, ${result.reachable.toLocaleString()} reachable, ${result.suppressed.toLocaleString()} suppressed and excluded.`,
    payload: { rules: input.rules, reachability: result.reachability },
  })

  revalidatePath('/targeting')
  return { ok: true, message: `Saved. ${result.reachable.toLocaleString()} contacts are reachable.`, data: { id: id! } }
}

export async function refreshSegmentAction(segmentId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  const r = await refreshSegment(auth.workspace.id, segmentId)
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'segment.refreshed',
    subjectType: 'segment',
    subjectId: segmentId,
    summary: `Refreshed: ${r.matched.toLocaleString()} matched, ${r.reachable.toLocaleString()} reachable.`,
    payload: { reachability: r.reachability },
  })
  revalidatePath('/targeting')
  return { ok: true, message: `${r.matched.toLocaleString()} matched, ${r.reachable.toLocaleString()} reachable.` }
}

/** AT-2: lookalike expansion from a seed segment. */
export async function buildLookalikeAction(
  seedSegmentId: string,
  threshold: number,
): Promise<ActionResult<{ id: string; matched: number }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'segment:create')
  } catch {
    return { ok: false, message: 'Your role cannot create segments.' }
  }

  const [seed] = await db
    .select()
    .from(segments)
    .where(and(eq(segments.workspaceId, auth.workspace.id), eq(segments.id, seedSegmentId)))
    .limit(1)
  if (!seed) return { ok: false, message: 'Seed segment not found.' }

  const look = await buildLookalike(auth.workspace.id, seedSegmentId, threshold)
  if (look.matched === 0) {
    return { ok: false, message: 'No contacts cleared that similarity threshold. Try lowering it.' }
  }

  // Segment row and its membership are written together: a lookalike that
  // exists with zero members is worse than one that was never created, because
  // anything downstream would treat it as a real, empty audience.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(segments)
      .values({
        workspaceId: auth.workspace.id,
        name: `${seed.name} — lookalike`,
        description: `Built from "${seed.name}" at ${threshold.toFixed(2)} similarity.`,
        rules: { combinator: 'and', rules: [] },
        sourceType: 'lookalike',
        seedSegmentId,
        similarityThreshold: threshold,
        syncTargets: seed.syncTargets,
        estimatedSize: look.matched,
        reachableSize: look.matched,
        lastRefreshedAt: new Date(),
        createdBy: auth.user.id,
      })
      .returning({ id: segments.id })

    await materialiseMembers(tx, row.id, look.contactIds)
    return row
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'segment.created',
    subjectType: 'segment',
    subjectId: created.id,
    summary: `Lookalike from "${seed.name}" at ${threshold.toFixed(2)} similarity — ${look.matched.toLocaleString()} contacts.`,
    payload: { centroid: look.centroid, threshold },
  })

  revalidatePath('/targeting')
  return { ok: true, message: `${look.matched.toLocaleString()} similar contacts found.`, data: { id: created.id, matched: look.matched } }
}

/** AT-4: push the segment to connected channels. */
export async function syncSegmentAction(segmentId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  const [seg] = await db
    .select()
    .from(segments)
    .where(and(eq(segments.workspaceId, auth.workspace.id), eq(segments.id, segmentId)))
    .limit(1)
  if (!seg) return { ok: false, message: 'Segment not found.' }
  if (seg.syncTargets.length === 0) {
    return { ok: false, message: 'No sync targets configured on this segment.' }
  }

  const { segmentMembers } = await import('@/lib/db/schema')
  const members = await db
    .select({ contactId: segmentMembers.contactId })
    .from(segmentMembers)
    .where(eq(segmentMembers.segmentId, segmentId))
  const ids = members.map((m) => m.contactId)

  const lines: string[] = []
  for (const channel of seg.syncTargets) {
    const provider =
      channel === 'google_ads' ? 'google_ads' : channel === 'meta_ads' ? 'meta_ads' : 'hubspot_crm'
    const adapter = adapterFor(provider)
    const result = await adapter.syncAudience?.({
      segmentId,
      segmentName: seg.name,
      contactIds: ids,
      connector: null,
    })
    if (result?.ok) {
      lines.push(`${channel}: ${result.synced.toLocaleString()} matched (${Math.round(result.matchRate * 100)}%)`)
    } else {
      lines.push(`${channel}: ${result?.error ?? 'sync unavailable'}`)
    }
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'segment.synced',
    subjectType: 'segment',
    subjectId: segmentId,
    summary: `Synced "${seg.name}" to ${seg.syncTargets.join(', ')}. ${lines.join(' · ')}`,
    payload: { targets: seg.syncTargets, size: ids.length },
  })

  revalidatePath('/targeting')
  return { ok: true, message: lines.join(' · ') }
}

/**
 * Write membership rows for an explicitly scored id list.
 *
 * Deliberately a parameterised insert rather than `unnest(${ids}::uuid[])`:
 * drizzle expands a JS array inside a raw `sql` template into a parenthesised
 * parameter list for `IN (...)`, which is not a valid array expression. That
 * failed *after* the segment row was written, leaving a segment with zero
 * members and no audit event. Chunked so a large lookalike does not blow the
 * parameter limit.
 */
async function materialiseMembers(
  tx: Pick<typeof db, 'insert'>,
  segmentId: string,
  contactIds: string[],
) {
  const CHUNK = 1000
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const rows = contactIds.slice(i, i + CHUNK).map((contactId) => ({
      segmentId,
      contactId,
      score: 1,
    }))
    if (rows.length > 0) await tx.insert(segmentMembers).values(rows).onConflictDoNothing()
  }
}

export async function deleteSegmentAction(segmentId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'segment:edit')
  } catch {
    return { ok: false, message: 'Your role cannot delete segments.' }
  }
  await db
    .delete(segments)
    .where(and(eq(segments.workspaceId, auth.workspace.id), eq(segments.id, segmentId)))
  revalidatePath('/targeting')
  return { ok: true, message: 'Segment deleted.' }
}
