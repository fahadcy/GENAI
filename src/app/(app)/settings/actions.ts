'use server'

import { revalidatePath } from 'next/cache'
import { randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  approvalChains,
  blackoutWindows,
  brandProfiles,
  connectors,
  frequencyCaps,
  invitations,
  legalRules,
  memberships,
  sessions,
  subscriptions,
  users,
  workspaces,
  type ApprovalStep,
  type ChainScope,
  type Channel,
  type Role,
} from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan, ROLE_LABEL } from '@/lib/auth/rbac'
import { hashPassword, passwordProblems, verifyPassword } from '@/lib/auth/password'
import { recordAudit } from '@/lib/workflow/audit'
import { matchChain } from '@/lib/workflow/approvals'
import { CONNECTOR_BY_PROVIDER } from '@/lib/connectors/registry'
import type { ActionResult } from '@/app/actions/content'

/**
 * Settings mutations.
 *
 * Two rules hold across this file:
 *   1. Every write is permission-checked server-side. The UI hides what a role
 *      cannot do, but hiding is not enforcement.
 *   2. Every governance change writes an audit event. Brand rules, approval
 *      chains, roles and connectors are exactly the settings a compliance
 *      reviewer will ask "who changed this, and when?" about.
 */

const ROLES = ['owner', 'admin', 'creator', 'strategist', 'approver', 'analyst'] as const

/** Shared guard: resolve auth, check the permission, return a typed failure. */
async function guard(permission: Parameters<typeof assertCan>[1], verb: string) {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, permission)
  } catch {
    return { auth, denied: { ok: false as const, message: `Your role cannot ${verb}.` } }
  }
  return { auth, denied: null }
}

/* ------------------------------------------------------------- workspace */

const generalSchema = z.object({
  name: z.string().min(2, 'Give the workspace a name.').max(80),
  defaultTimezone: z.string().min(3),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  weekStartsOn: z.coerce.number().int().min(0).max(1),
  dataResidency: z.enum(['eu', 'uk', 'us']),
  requireApprovalAboveSpend: z.coerce.number().min(0).max(1_000_000),
})

export async function updateWorkspaceGeneral(
  input: z.input<typeof generalSchema>,
): Promise<ActionResult> {
  const { auth, denied } = await guard('workspace:read', 'change workspace settings')
  if (denied) return denied
  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return { ok: false, message: 'Only an owner or marketing ops can change workspace settings.' }
  }

  const parsed = generalSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const before = auth.workspace
  await db
    .update(workspaces)
    .set({
      name: d.name,
      dataResidency: d.dataResidency,
      settings: {
        ...before.settings,
        defaultTimezone: d.defaultTimezone,
        currency: d.currency,
        weekStartsOn: d.weekStartsOn,
        requireApprovalAboveSpend: d.requireApprovalAboveSpend,
      },
    })
    .where(eq(workspaces.id, before.id))

  const changes: string[] = []
  if (before.name !== d.name) changes.push(`name "${before.name}" → "${d.name}"`)
  if (before.dataResidency !== d.dataResidency)
    changes.push(`data residency ${before.dataResidency.toUpperCase()} → ${d.dataResidency.toUpperCase()}`)
  if (before.settings.defaultTimezone !== d.defaultTimezone)
    changes.push(`timezone ${before.settings.defaultTimezone} → ${d.defaultTimezone}`)
  if (before.settings.currency !== d.currency)
    changes.push(`currency ${before.settings.currency} → ${d.currency}`)
  if ((before.settings.requireApprovalAboveSpend ?? 0) !== d.requireApprovalAboveSpend)
    changes.push(`approval threshold ${before.settings.requireApprovalAboveSpend ?? 0} → ${d.requireApprovalAboveSpend}`)

  await recordAudit({
    workspaceId: before.id,
    actorId: auth.user.id,
    action: 'workspace.updated',
    subjectType: 'workspace',
    subjectId: before.id,
    summary: changes.length > 0 ? `Workspace settings changed: ${changes.join('; ')}.` : 'Workspace settings saved with no effective change.',
    payload: { changes },
  })

  revalidatePath('/settings')
  revalidatePath('/', 'layout')
  return { ok: true, message: changes.length > 0 ? 'Workspace settings saved.' : 'Nothing changed.' }
}

/* ----------------------------------------------------------------- brand */

const toneSchema = z.object({
  formal: z.coerce.number().int().min(0).max(100),
  playful: z.coerce.number().int().min(0).max(100),
  technical: z.coerce.number().int().min(0).max(100),
  urgent: z.coerce.number().int().min(0).max(100),
  warm: z.coerce.number().int().min(0).max(100),
})

const brandSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(2, 'Name the profile.').max(80),
  voice: z.string().max(2000),
  tone: toneSchema,
  doList: z.array(z.string().max(240)).max(30),
  dontList: z.array(z.string().max(240)).max(30),
  bannedTerms: z.array(z.string().max(60)).max(120),
  preferredTerms: z.array(z.object({ avoid: z.string().max(60), use: z.string().max(60) })).max(80),
  requiredDisclaimers: z
    .array(z.object({ text: z.string().max(600), channels: z.array(z.string()).max(12) }))
    .max(20),
  readingLevelMax: z.coerce.number().int().min(4).max(18),
  maxExclamations: z.coerce.number().int().min(0).max(10),
  passThreshold: z.coerce.number().int().min(50).max(100),
  colors: z.object({
    primary: z.string().max(9),
    secondary: z.string().max(9),
    accent: z.string().max(9),
  }),
})

export async function saveBrandProfile(input: z.input<typeof brandSchema>): Promise<ActionResult> {
  const { auth, denied } = await guard('brand:manage', 'change brand rules')
  if (denied) return denied

  const parsed = brandSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const [before] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.id, d.id)))
    .limit(1)
  if (!before) return { ok: false, message: 'That brand profile no longer exists.' }

  const clean = {
    name: d.name,
    voice: d.voice.trim(),
    tone: d.tone,
    doList: d.doList.map((s) => s.trim()).filter(Boolean),
    dontList: d.dontList.map((s) => s.trim()).filter(Boolean),
    bannedTerms: [...new Set(d.bannedTerms.map((s) => s.trim().toLowerCase()).filter(Boolean))],
    preferredTerms: d.preferredTerms
      .map((p) => ({ avoid: p.avoid.trim(), use: p.use.trim() }))
      .filter((p) => p.avoid && p.use),
    requiredDisclaimers: d.requiredDisclaimers
      .map((p) => ({ text: p.text.trim(), channels: p.channels }))
      .filter((p) => p.text),
    readingLevelMax: d.readingLevelMax,
    maxExclamations: d.maxExclamations,
    passThreshold: d.passThreshold,
    colors: d.colors,
  }

  await db.update(brandProfiles).set(clean).where(eq(brandProfiles.id, d.id))

  // Name what moved rather than logging a whole snapshot — the audit feed is
  // read by people, and "3 fields changed" is not an answer.
  const diff = describeBrandDiff(before, clean)
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'brand.updated',
    subjectType: 'brand_profile',
    subjectId: d.id,
    summary:
      diff.length > 0
        ? `"${clean.name}" updated: ${diff.join('; ')}.`
        : `"${clean.name}" saved with no effective change.`,
    payload: { changes: diff, passThreshold: clean.passThreshold },
  })

  revalidatePath('/settings/brand')
  revalidatePath('/settings')
  return {
    ok: true,
    message:
      diff.length > 0
        ? `Saved. ${diff.length} change${diff.length === 1 ? '' : 's'} recorded in the audit trail.`
        : 'Saved. Nothing had changed.',
  }
}

function describeBrandDiff(
  before: {
    name: string
    voice: string
    tone: Record<string, number>
    doList: string[]
    dontList: string[]
    bannedTerms: string[]
    preferredTerms: { avoid: string; use: string }[]
    requiredDisclaimers: { text: string; channels: string[] }[]
    readingLevelMax: number
    maxExclamations: number
    passThreshold: number
  },
  after: typeof before,
): string[] {
  const out: string[] = []
  if (before.name !== after.name) out.push(`renamed to "${after.name}"`)
  if (before.voice !== after.voice) out.push('voice description rewritten')

  const movedAxes = Object.keys(after.tone).filter((k) => before.tone[k] !== after.tone[k])
  if (movedAxes.length > 0) {
    out.push(
      `tone ${movedAxes.map((k) => `${k} ${before.tone[k]}→${after.tone[k]}`).join(', ')}`,
    )
  }

  const listDelta = (label: string, a: string[], b: string[]) => {
    const added = b.filter((x) => !a.includes(x)).length
    const removed = a.filter((x) => !b.includes(x)).length
    if (added || removed) out.push(`${label} ${added ? `+${added}` : ''}${added && removed ? '/' : ''}${removed ? `−${removed}` : ''}`)
  }
  listDelta('do rules', before.doList, after.doList)
  listDelta("don't rules", before.dontList, after.dontList)
  listDelta('banned terms', before.bannedTerms, after.bannedTerms)
  listDelta(
    'preferred swaps',
    before.preferredTerms.map((p) => `${p.avoid}→${p.use}`),
    after.preferredTerms.map((p) => `${p.avoid}→${p.use}`),
  )
  listDelta(
    'disclaimers',
    before.requiredDisclaimers.map((p) => p.text),
    after.requiredDisclaimers.map((p) => p.text),
  )

  if (before.readingLevelMax !== after.readingLevelMax)
    out.push(`reading level ${before.readingLevelMax}→${after.readingLevelMax}`)
  if (before.maxExclamations !== after.maxExclamations)
    out.push(`exclamation limit ${before.maxExclamations}→${after.maxExclamations}`)
  if (before.passThreshold !== after.passThreshold)
    out.push(`pass threshold ${before.passThreshold}→${after.passThreshold}`)
  return out
}

/* ----------------------------------------------------------- legal rules */

const legalSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(3, 'Name the rule.').max(120),
  pattern: z.string().min(1, 'A rule needs a pattern.').max(500),
  severity: z.enum(['high', 'medium', 'low']),
  message: z.string().min(5, 'Explain why this is a problem.').max(400),
  remedy: z.string().max(400).optional(),
  channels: z.array(z.string()).max(12),
  active: z.boolean(),
})

export async function saveLegalRule(input: z.input<typeof legalSchema>): Promise<ActionResult> {
  const { auth, denied } = await guard('brand:manage', 'change legal rules')
  if (denied) return denied

  const parsed = legalSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  // A rule that does not compile silently stops checking anything, so reject it
  // here rather than letting checkLegal() swallow it at generation time.
  try {
    new RegExp(d.pattern, 'gi')
  } catch (e) {
    return { ok: false, message: `That pattern is not a valid expression: ${(e as Error).message}` }
  }

  const values = {
    workspaceId: auth.workspace.id,
    name: d.name,
    pattern: d.pattern,
    severity: d.severity,
    message: d.message,
    remedy: d.remedy?.trim() || null,
    channels: d.channels,
    active: d.active,
  }

  if (d.id) {
    const [existing] = await db
      .select()
      .from(legalRules)
      .where(and(eq(legalRules.workspaceId, auth.workspace.id), eq(legalRules.id, d.id)))
      .limit(1)
    if (!existing) return { ok: false, message: 'That rule no longer exists.' }

    await db.update(legalRules).set(values).where(eq(legalRules.id, d.id))
    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: 'legal.rule_updated',
      subjectType: 'legal_rule',
      subjectId: d.id,
      summary: `Legal rule "${d.name}" updated (${d.severity} severity, ${d.channels.length === 0 ? 'all channels' : d.channels.join(', ')}, ${d.active ? 'active' : 'paused'}).`,
      payload: { pattern: d.pattern, severity: d.severity, active: d.active, channels: d.channels },
    })
  } else {
    const [row] = await db.insert(legalRules).values(values).returning({ id: legalRules.id })
    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: 'legal.rule_created',
      subjectType: 'legal_rule',
      subjectId: row.id,
      summary: `Legal rule "${d.name}" added — ${d.severity} severity on ${d.channels.length === 0 ? 'every channel' : d.channels.join(', ')}.`,
      payload: { pattern: d.pattern, severity: d.severity, channels: d.channels },
    })
  }

  revalidatePath('/settings/brand')
  return { ok: true, message: d.id ? 'Rule updated. It applies to the next generation.' : 'Rule added. It applies to the next generation.' }
}

export async function deleteLegalRule(id: string): Promise<ActionResult> {
  const { auth, denied } = await guard('brand:manage', 'remove legal rules')
  if (denied) return denied

  const [rule] = await db
    .select()
    .from(legalRules)
    .where(and(eq(legalRules.workspaceId, auth.workspace.id), eq(legalRules.id, id)))
    .limit(1)
  if (!rule) return { ok: false, message: 'That rule no longer exists.' }

  await db.delete(legalRules).where(eq(legalRules.id, id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'legal.rule_removed',
    subjectType: 'legal_rule',
    subjectId: id,
    summary: `Legal rule "${rule.name}" removed. Copy is no longer checked against it.`,
    payload: { pattern: rule.pattern, severity: rule.severity },
  })

  revalidatePath('/settings/brand')
  return { ok: true, message: `"${rule.name}" removed.` }
}

/* ------------------------------------------------------- approval chains */

const stepSchema = z.object({
  name: z.string().min(2, 'Every step needs a name.').max(80),
  role: z.enum(ROLES),
  mode: z.enum(['any', 'all']),
  slaHours: z.coerce.number().int().min(1).max(336),
  approverIds: z.array(z.string().uuid()).max(20).optional(),
})

const chainSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(3, 'Name the chain.').max(80),
  description: z.string().max(400).optional(),
  channels: z.array(z.string()).max(12),
  spendThreshold: z.union([z.coerce.number().min(0).max(10_000_000), z.null()]),
  steps: z.array(stepSchema).min(1, 'A chain needs at least one step.').max(6),
  isDefault: z.boolean(),
  active: z.boolean(),
  priority: z.coerce.number().int().min(0).max(100),
})

export async function saveApprovalChain(input: z.input<typeof chainSchema>): Promise<ActionResult<{ id: string }>> {
  const { auth, denied } = await guard('approval:configure', 'change approval chains')
  if (denied) return denied

  const parsed = chainSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const scope: ChainScope = {}
  if (d.channels.length > 0) scope.channels = d.channels
  if (typeof d.spendThreshold === 'number') scope.spendThreshold = d.spendThreshold

  const steps: ApprovalStep[] = d.steps.map((s) => ({
    name: s.name,
    role: s.role,
    mode: s.mode,
    slaHours: s.slaHours,
    ...(s.approverIds?.length ? { approverIds: s.approverIds } : {}),
  }))

  const values = {
    workspaceId: auth.workspace.id,
    name: d.name,
    description: d.description?.trim() || null,
    scope,
    steps,
    isDefault: d.isDefault,
    active: d.active,
    priority: d.priority,
  }

  const scopeText =
    [
      scope.channels ? `${scope.channels.length} channel${scope.channels.length === 1 ? '' : 's'}` : null,
      typeof scope.spendThreshold === 'number'
        ? `spend over ${scope.spendThreshold.toLocaleString('en-GB')}`
        : null,
    ]
      .filter(Boolean)
      .join(' and ') || 'anything not matched by a narrower chain'

  let id = d.id
  if (id) {
    const [existing] = await db
      .select()
      .from(approvalChains)
      .where(and(eq(approvalChains.workspaceId, auth.workspace.id), eq(approvalChains.id, id)))
      .limit(1)
    if (!existing) return { ok: false, message: 'That chain no longer exists.' }
    await db.update(approvalChains).set(values).where(eq(approvalChains.id, id))
  } else {
    const [row] = await db.insert(approvalChains).values(values).returning({ id: approvalChains.id })
    id = row.id
  }

  // Exactly one default, or matchChain() has no fallback to land on.
  if (d.isDefault) {
    await db
      .update(approvalChains)
      .set({ isDefault: false })
      .where(and(eq(approvalChains.workspaceId, auth.workspace.id), sql`${approvalChains.id} <> ${id}`))
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: d.id ? 'chain.updated' : 'chain.created',
    subjectType: 'approval_chain',
    subjectId: id,
    summary: `Approval chain "${d.name}" ${d.id ? 'updated' : 'created'} — ${steps.length} step${steps.length === 1 ? '' : 's'} (${steps.map((s) => `${s.name}/${s.role}`).join(' → ')}) covering ${scopeText}.`,
    payload: { scope, steps, active: d.active, isDefault: d.isDefault, priority: d.priority },
  })

  revalidatePath('/settings/approvals')
  revalidatePath('/approvals')
  return { ok: true, message: `"${d.name}" saved.`, data: { id } }
}

export async function deleteApprovalChain(id: string): Promise<ActionResult> {
  const { auth, denied } = await guard('approval:configure', 'remove approval chains')
  if (denied) return denied

  const [chain] = await db
    .select()
    .from(approvalChains)
    .where(and(eq(approvalChains.workspaceId, auth.workspace.id), eq(approvalChains.id, id)))
    .limit(1)
  if (!chain) return { ok: false, message: 'That chain no longer exists.' }

  // Requests reference the chain, so history would break. Retiring keeps the
  // trail intact and stops the chain matching anything new.
  const usedRows = (await db.execute(
    sql`select count(*)::int as n from approval_requests where chain_id = ${id}`,
  )) as unknown as { n: number }[]
  const governed = Number(usedRows[0]?.n ?? 0)

  if (governed > 0) {
    await db.update(approvalChains).set({ active: false, isDefault: false }).where(eq(approvalChains.id, id))
    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: 'chain.retired',
      subjectType: 'approval_chain',
      subjectId: id,
      summary: `Approval chain "${chain.name}" retired. It governed ${governed} past request(s), so it is kept for the record but no longer matches new work.`,
      payload: { requests: governed },
    })
    revalidatePath('/settings/approvals')
    return {
      ok: true,
      message: `"${chain.name}" has governed ${governed} request(s), so it was retired rather than deleted. Its history stays intact.`,
    }
  }

  await db.delete(approvalChains).where(eq(approvalChains.id, id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'chain.removed',
    subjectType: 'approval_chain',
    subjectId: id,
    summary: `Approval chain "${chain.name}" deleted. It had never been used.`,
    payload: {},
  })
  revalidatePath('/settings/approvals')
  return { ok: true, message: `"${chain.name}" deleted.` }
}

/**
 * Answers "which chain would this go through?" without submitting anything.
 * Chain matching is otherwise invisible until the moment work is already in
 * review, which is the worst time to discover a gap.
 */
export async function testChainMatch(
  channel: string,
  spend: number,
): Promise<{
  chainId: string | null
  chainName: string
  reason: string
  steps: ApprovalStep[]
  totalSlaHours: number
}> {
  const auth = await requireAuth()
  const chain = await matchChain(auth.workspace.id, { channel, spend, subjectType: 'asset' })
  const currency = auth.workspace.settings.currency
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '£'

  if (!chain) {
    return {
      chainId: null,
      chainName: 'No chain matches',
      reason:
        'Nothing would govern this. Work on this channel could not be submitted for review until a chain covers it, or one chain is marked as the workspace default.',
      steps: [],
      totalSlaHours: 0,
    }
  }

  const s = chain.scope
  const reasons: string[] = []
  if (s.channels?.includes(channel)) reasons.push(`its scope names this channel`)
  if (typeof s.spendThreshold === 'number' && spend >= s.spendThreshold)
    reasons.push(`the spend clears its ${symbol}${s.spendThreshold.toLocaleString('en-GB')} threshold`)
  if (reasons.length === 0 && chain.isDefault) reasons.push('it is the workspace default and nothing narrower matched')
  if (reasons.length === 0) reasons.push('it was the highest-priority active chain available')

  return {
    chainId: chain.id,
    chainName: chain.name,
    reason: `Matched because ${reasons.join(' and ')}.`,
    steps: chain.steps,
    totalSlaHours: chain.steps.reduce((a, x) => a + (x.slaHours || 0), 0),
  }
}

/* ---------------------------------------------------- scheduling guards */

const blackoutSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(3, 'Name the window.').max(80),
  startsAt: z.string().min(10),
  endsAt: z.string().min(10),
  channels: z.array(z.string()).max(12),
  reason: z.string().max(300).optional(),
})

export async function saveBlackoutWindow(input: z.input<typeof blackoutSchema>): Promise<ActionResult> {
  const { auth, denied } = await guard('schedule:edit', 'change blackout windows')
  if (denied) return denied

  const parsed = blackoutSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const startsAt = new Date(d.startsAt)
  const endsAt = new Date(d.endsAt)
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return { ok: false, message: 'Those dates could not be read.' }
  }
  if (endsAt <= startsAt) return { ok: false, message: 'The window has to end after it starts.' }

  const values = {
    workspaceId: auth.workspace.id,
    name: d.name,
    startsAt,
    endsAt,
    channels: d.channels,
    reason: d.reason?.trim() || null,
  }

  if (d.id) {
    await db
      .update(blackoutWindows)
      .set(values)
      .where(and(eq(blackoutWindows.workspaceId, auth.workspace.id), eq(blackoutWindows.id, d.id)))
  } else {
    await db.insert(blackoutWindows).values(values)
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'blackout.saved',
    subjectType: 'blackout_window',
    subjectId: d.id ?? null,
    summary: `Blackout "${d.name}" ${d.id ? 'updated' : 'added'}: ${startsAt.toISOString().slice(0, 10)} to ${endsAt.toISOString().slice(0, 10)} on ${d.channels.length === 0 ? 'every channel' : d.channels.join(', ')}.`,
    payload: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), channels: d.channels },
  })

  revalidatePath('/settings/approvals')
  revalidatePath('/scheduler')
  return { ok: true, message: `"${d.name}" saved. The scheduler will refuse placements inside it.` }
}

export async function deleteBlackoutWindow(id: string): Promise<ActionResult> {
  const { auth, denied } = await guard('schedule:edit', 'remove blackout windows')
  if (denied) return denied

  const [row] = await db
    .select()
    .from(blackoutWindows)
    .where(and(eq(blackoutWindows.workspaceId, auth.workspace.id), eq(blackoutWindows.id, id)))
    .limit(1)
  if (!row) return { ok: false, message: 'That window no longer exists.' }

  await db.delete(blackoutWindows).where(eq(blackoutWindows.id, id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'blackout.removed',
    subjectType: 'blackout_window',
    subjectId: id,
    summary: `Blackout "${row.name}" removed. Those dates are open again.`,
    payload: {},
  })
  revalidatePath('/settings/approvals')
  revalidatePath('/scheduler')
  return { ok: true, message: `"${row.name}" removed.` }
}

const capSchema = z.object({
  id: z.string().uuid().optional(),
  channel: z.string().min(1),
  maxPerContact: z.coerce.number().int().min(1).max(50),
  windowDays: z.coerce.number().int().min(1).max(90),
})

export async function saveFrequencyCap(input: z.input<typeof capSchema>): Promise<ActionResult> {
  const { auth, denied } = await guard('schedule:edit', 'change frequency caps')
  if (denied) return denied

  const parsed = capSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const values = {
    workspaceId: auth.workspace.id,
    channel: d.channel as Channel,
    maxPerContact: d.maxPerContact,
    windowDays: d.windowDays,
  }

  if (d.id) {
    await db
      .update(frequencyCaps)
      .set(values)
      .where(and(eq(frequencyCaps.workspaceId, auth.workspace.id), eq(frequencyCaps.id, d.id)))
  } else {
    const existing = await db
      .select({ id: frequencyCaps.id })
      .from(frequencyCaps)
      .where(and(eq(frequencyCaps.workspaceId, auth.workspace.id), eq(frequencyCaps.channel, d.channel as Channel)))
      .limit(1)
    if (existing[0]) return { ok: false, message: 'That channel already has a cap. Edit the existing one.' }
    await db.insert(frequencyCaps).values(values)
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'frequency_cap.saved',
    subjectType: 'frequency_cap',
    subjectId: d.id ?? null,
    summary: `Frequency cap for ${d.channel}: at most ${d.maxPerContact} message(s) per contact every ${d.windowDays} day(s).`,
    payload: { channel: d.channel, maxPerContact: d.maxPerContact, windowDays: d.windowDays },
  })

  revalidatePath('/settings/approvals')
  revalidatePath('/scheduler')
  return { ok: true, message: 'Cap saved.' }
}

export async function deleteFrequencyCap(id: string): Promise<ActionResult> {
  const { auth, denied } = await guard('schedule:edit', 'remove frequency caps')
  if (denied) return denied

  const [row] = await db
    .select()
    .from(frequencyCaps)
    .where(and(eq(frequencyCaps.workspaceId, auth.workspace.id), eq(frequencyCaps.id, id)))
    .limit(1)
  if (!row) return { ok: false, message: 'That cap no longer exists.' }

  await db.delete(frequencyCaps).where(eq(frequencyCaps.id, id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'frequency_cap.removed',
    subjectType: 'frequency_cap',
    subjectId: id,
    summary: `Frequency cap on ${row.channel} removed. That channel is now uncapped.`,
    payload: { channel: row.channel },
  })
  revalidatePath('/settings/approvals')
  return { ok: true, message: `Cap on ${row.channel} removed.` }
}

/* --------------------------------------------------------------- people */

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  role: z.enum(ROLES),
})

export async function inviteMember(input: z.input<typeof inviteSchema>): Promise<ActionResult<{ link: string }>> {
  const { auth, denied } = await guard('member:manage', 'invite people')
  if (denied) return denied

  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data
  const email = d.email.trim().toLowerCase()

  if (d.role === 'owner' && auth.role !== 'owner') {
    return { ok: false, message: 'Only an owner can invite another owner.' }
  }

  const existing = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, auth.workspace.id), sql`lower(${users.email}) = ${email}`))
    .limit(1)
  if (existing[0]) return { ok: false, message: 'That person is already a member of this workspace.' }

  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + 14 * 86_400_000)

  await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.workspaceId, auth.workspace.id),
        sql`lower(${invitations.email}) = ${email}`,
        sql`${invitations.acceptedAt} is null`,
      ),
    )

  await db.insert(invitations).values({
    workspaceId: auth.workspace.id,
    email,
    role: d.role,
    token,
    invitedBy: auth.user.id,
    expiresAt,
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'member.invited',
    subjectType: 'invitation',
    summary: `${email} invited as ${ROLE_LABEL[d.role]}. The invitation expires in 14 days.`,
    payload: { email, role: d.role },
  })

  revalidatePath('/settings/members')
  return {
    ok: true,
    message: `Invitation created for ${email}.`,
    data: { link: `/signup?invite=${token}` },
  }
}

export async function revokeInvitation(id: string): Promise<ActionResult> {
  const { auth, denied } = await guard('member:manage', 'revoke invitations')
  if (denied) return denied

  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.workspaceId, auth.workspace.id), eq(invitations.id, id)))
    .limit(1)
  if (!row) return { ok: false, message: 'That invitation no longer exists.' }

  await db.delete(invitations).where(eq(invitations.id, id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'member.invite_revoked',
    subjectType: 'invitation',
    subjectId: id,
    summary: `Invitation for ${row.email} revoked before it was accepted.`,
    payload: { email: row.email, role: row.role },
  })
  revalidatePath('/settings/members')
  return { ok: true, message: `Invitation for ${row.email} revoked.` }
}

export async function changeMemberRole(membershipId: string, role: Role): Promise<ActionResult> {
  const { auth, denied } = await guard('member:manage', 'change roles')
  if (denied) return denied
  if (!ROLES.includes(role)) return { ok: false, message: 'Unknown role.' }

  const [row] = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, auth.workspace.id), eq(memberships.id, membershipId)))
    .limit(1)
  if (!row) return { ok: false, message: 'That member is not in this workspace.' }
  if (row.membership.role === role) return { ok: true, message: 'No change — they already hold that role.' }

  if ((row.membership.role === 'owner' || role === 'owner') && auth.role !== 'owner') {
    return { ok: false, message: 'Only an owner can grant or remove the owner role.' }
  }

  // Losing the last owner would leave nobody able to manage billing or restore
  // access, so block it here rather than discovering it later.
  if (row.membership.role === 'owner' && role !== 'owner') {
    const owners = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, auth.workspace.id), eq(memberships.role, 'owner')))
    if (Number(owners[0]?.n ?? 0) <= 1) {
      return { ok: false, message: 'This is the only owner. Promote someone else first.' }
    }
  }

  await db.update(memberships).set({ role }).where(eq(memberships.id, membershipId))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'member.role_changed',
    subjectType: 'user',
    subjectId: row.user.id,
    summary: `${row.user.name}: ${ROLE_LABEL[row.membership.role]} → ${ROLE_LABEL[role]}.`,
    payload: { from: row.membership.role, to: role, email: row.user.email },
  })

  revalidatePath('/settings/members')
  return { ok: true, message: `${row.user.name} is now ${ROLE_LABEL[role]}.` }
}

export async function removeMember(membershipId: string): Promise<ActionResult> {
  const { auth, denied } = await guard('member:manage', 'remove people')
  if (denied) return denied

  const [row] = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, auth.workspace.id), eq(memberships.id, membershipId)))
    .limit(1)
  if (!row) return { ok: false, message: 'That member is not in this workspace.' }
  if (row.user.id === auth.user.id) return { ok: false, message: 'You cannot remove yourself.' }
  if (row.membership.role === 'owner' && auth.role !== 'owner') {
    return { ok: false, message: 'Only an owner can remove another owner.' }
  }

  await db.delete(memberships).where(eq(memberships.id, membershipId))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'member.removed',
    subjectType: 'user',
    subjectId: row.user.id,
    summary: `${row.user.name} (${ROLE_LABEL[row.membership.role]}) removed from the workspace. Their past work and decisions stay on the record.`,
    payload: { email: row.user.email, role: row.membership.role },
  })

  revalidatePath('/settings/members')
  return { ok: true, message: `${row.user.name} no longer has access.` }
}

/* ----------------------------------------------------------- connectors */

export async function setConnectorStatus(
  provider: string,
  next: 'connected' | 'disconnected',
): Promise<ActionResult> {
  const { auth, denied } = await guard('connector:manage', 'manage integrations')
  if (denied) return denied

  const def = CONNECTOR_BY_PROVIDER.get(provider)
  if (!def) return { ok: false, message: 'Unknown integration.' }

  const [existing] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.workspaceId, auth.workspace.id), eq(connectors.provider, provider)))
    .limit(1)

  if (next === 'connected') {
    const values = {
      workspaceId: auth.workspace.id,
      provider,
      category: def.category,
      displayName: def.displayName,
      status: 'connected' as const,
      scopes: def.capabilities,
      lastSyncAt: new Date(),
      lastError: null,
    }
    if (existing) {
      await db.update(connectors).set(values).where(eq(connectors.id, existing.id))
    } else {
      await db.insert(connectors).values(values)
    }
    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: 'connector.connected',
      subjectType: 'connector',
      subjectId: existing?.id ?? null,
      summary: `${def.displayName} connected via ${def.authType === 'oauth2' ? 'OAuth' : 'an API key'} with ${def.capabilities.length} capability grant(s).`,
      payload: { provider, capabilities: def.capabilities },
    })
    revalidatePath('/settings/connectors')
    return { ok: true, message: `${def.displayName} connected.` }
  }

  if (!existing) return { ok: false, message: `${def.displayName} is not connected.` }
  await db
    .update(connectors)
    .set({ status: 'disconnected', credentialRef: null, scopes: [], lastError: null })
    .where(eq(connectors.id, existing.id))
  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'connector.disconnected',
    subjectType: 'connector',
    subjectId: existing.id,
    summary: `${def.displayName} disconnected. Anything scheduled through it will fail until it is reconnected.`,
    payload: { provider },
  })
  revalidatePath('/settings/connectors')
  return { ok: true, message: `${def.displayName} disconnected.` }
}

/** Clears a degraded/error state by recording a fresh successful sync. */
export async function retryConnector(provider: string): Promise<ActionResult> {
  const { auth, denied } = await guard('connector:manage', 'retry integrations')
  if (denied) return denied

  const [existing] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.workspaceId, auth.workspace.id), eq(connectors.provider, provider)))
    .limit(1)
  if (!existing) return { ok: false, message: 'That integration is not configured.' }

  await db
    .update(connectors)
    .set({ status: 'connected', lastError: null, lastSyncAt: new Date() })
    .where(eq(connectors.id, existing.id))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'connector.resynced',
    subjectType: 'connector',
    subjectId: existing.id,
    summary: `${existing.displayName} resynced by hand after: ${existing.lastError ?? 'a degraded state'}`,
    payload: { provider, clearedError: existing.lastError },
  })

  revalidatePath('/settings/connectors')
  return { ok: true, message: `${existing.displayName} resynced.` }
}

/* -------------------------------------------------------------- billing */

const planSchema = z.object({
  plan: z.enum(['trial', 'studio', 'growth', 'scale', 'enterprise']),
  seats: z.coerce.number().int().min(1).max(500),
})

export async function changePlan(input: z.input<typeof planSchema>): Promise<ActionResult> {
  const { auth, denied } = await guard('billing:manage', 'change the plan')
  if (denied) return denied

  const parsed = planSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  const used = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.workspaceId, auth.workspace.id))
  const seatsUsed = Number(used[0]?.n ?? 0)
  if (d.seats < seatsUsed) {
    return {
      ok: false,
      message: `${seatsUsed} people already have access. Remove members before reducing to ${d.seats} seats.`,
    }
  }

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, auth.workspace.id))
    .limit(1)

  const values = {
    workspaceId: auth.workspace.id,
    plan: d.plan,
    seats: d.seats,
    status: d.plan === 'trial' ? 'trialing' : 'active',
    updatedAt: new Date(),
  }
  if (existing) {
    await db.update(subscriptions).set(values).where(eq(subscriptions.workspaceId, auth.workspace.id))
  } else {
    await db.insert(subscriptions).values(values)
  }
  await db.update(workspaces).set({ plan: d.plan, seats: d.seats }).where(eq(workspaces.id, auth.workspace.id))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'billing.plan_changed',
    subjectType: 'subscription',
    subjectId: auth.workspace.id,
    summary: `Plan ${existing?.plan ?? 'none'} → ${d.plan} at ${d.seats} seat(s), ${seatsUsed} in use.`,
    payload: { from: existing?.plan ?? null, to: d.plan, seats: d.seats, seatsUsed },
  })

  revalidatePath('/settings/billing')
  revalidatePath('/', 'layout')
  return { ok: true, message: `Now on ${d.plan} with ${d.seats} seats.` }
}

/* -------------------------------------------------------------- profile */

const profileSchema = z.object({
  name: z.string().min(2, 'Enter your name.').max(80),
  jobTitle: z.string().max(80).optional(),
  avatarHue: z.coerce.number().int().min(0).max(359),
})

export async function updateOwnProfile(input: z.input<typeof profileSchema>): Promise<ActionResult> {
  const auth = await requireAuth()
  const parsed = profileSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  const d = parsed.data

  await db
    .update(users)
    .set({ name: d.name, jobTitle: d.jobTitle?.trim() || null, avatarHue: d.avatarHue })
    .where(eq(users.id, auth.user.id))

  revalidatePath('/settings/profile')
  revalidatePath('/', 'layout')
  return { ok: true, message: 'Profile updated.' }
}

export async function changeOwnPassword(current: string, next: string): Promise<ActionResult> {
  const auth = await requireAuth()

  const [row] = await db.select().from(users).where(eq(users.id, auth.user.id)).limit(1)
  if (!row) return { ok: false, message: 'Account not found.' }
  if (!row.passwordHash) {
    return { ok: false, message: 'This account signs in through your identity provider, so there is no password to change.' }
  }
  if (!(await verifyPassword(current, row.passwordHash))) {
    return { ok: false, message: 'That is not your current password.' }
  }

  const problems = passwordProblems(next)
  if (problems.length > 0) return { ok: false, message: problems.join(' ') }

  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, auth.user.id))

  // Everything except this session, so a stolen cookie elsewhere dies with the
  // password it was obtained under.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, auth.user.id), sql`${sessions.id} <> ${auth.sessionId}`))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'user.password_changed',
    subjectType: 'user',
    subjectId: auth.user.id,
    summary: `${row.name} changed their password. All other sessions were signed out.`,
    payload: {},
  })

  revalidatePath('/settings/profile')
  return { ok: true, message: 'Password changed. Every other session has been signed out.' }
}

export async function revokeSession(sessionId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  if (sessionId === auth.sessionId) {
    return { ok: false, message: 'That is the session you are using. Sign out instead.' }
  }
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, auth.user.id), eq(sessions.id, sessionId)))
    .returning({ id: sessions.id })
  if (deleted.length === 0) return { ok: false, message: 'That session has already ended.' }

  revalidatePath('/settings/profile')
  return { ok: true, message: 'Session signed out.' }
}
