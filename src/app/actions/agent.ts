'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/session'
import { assertCan, ForbiddenError, type Permission } from '@/lib/auth/rbac'
import {
  AgentError,
  ANSWER_KEYS,
  chooseBusiness,
  connectCrm,
  connectGithub,
  disconnect,
  saveSettings,
  startRun,
  GOAL_LABEL,
} from '@/lib/agent/service'
import type { GoalKind } from '@/lib/agent'
import type { ActionResult } from './content'

/**
 * Server actions for the growth agent. Authenticate, check the permission,
 * validate, call the service, turn a refusal into a sentence.
 */

const DENIED: Record<string, string> = {
  'agent:run': 'Only owners, marketing ops and growth marketers can run the growth agent.',
  'agent:outreach': 'Only owners and marketing ops can send email through the growth agent.',
  'agent:configure': 'Only owners and marketing ops can connect the growth agent to the CRM or website.',
}

async function guard<T>(permission: Permission, fn: (auth: Awaited<ReturnType<typeof requireAuth>>) => Promise<ActionResult<T>>, fallback: string): Promise<ActionResult<T>> {
  let auth
  try {
    auth = await requireAuth()
    assertCan(auth.role, permission)
  } catch {
    return { ok: false, message: DENIED[permission] ?? 'Not permitted.' }
  }
  try {
    return await fn(auth)
  } catch (e) {
    if (e instanceof AgentError || e instanceof ForbiddenError) return { ok: false, message: e.message }
    console.error('agent action failed', e)
    return { ok: false, message: fallback }
  }
}

const refresh = () => revalidatePath('/agent')

export async function connectCrmAction(input: { crmUrl: string; crmToken: string }): Promise<ActionResult<{ businesses: { id: number; name: string }[]; scopes: string[] }>> {
  const p = z.object({ crmUrl: z.string().min(4).max(300), crmToken: z.string().min(10).max(100) }).safeParse(input)
  if (!p.success) return { ok: false, message: 'Enter the CRM address and the agent token.' }
  return guard('agent:configure', async (auth) => {
    const r = await connectCrm({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...p.data })
    refresh()
    return { ok: true, message: r.businesses.length === 1 ? `Connected to the CRM as ${r.businesses[0]!.name}.` : 'Connected. Choose which business the agent works for.', data: r }
  }, 'Could not connect the CRM.')
}

export async function chooseBusinessAction(businessId: number): Promise<ActionResult> {
  if (!Number.isInteger(businessId) || businessId < 1) return { ok: false, message: 'Choose a business.' }
  return guard('agent:configure', async (auth) => {
    await chooseBusiness({ workspaceId: auth.workspace.id, actorId: auth.user.id, businessId })
    refresh()
    return { ok: true, message: 'Saved.' }
  }, 'Could not save the business.')
}

export async function connectGithubAction(input: { repo: string; token: string }): Promise<ActionResult> {
  const p = z.object({ repo: z.string().min(3).max(200), token: z.string().min(10).max(300) }).safeParse(input)
  if (!p.success) return { ok: false, message: 'Enter the repository (owner/name) and a token.' }
  return guard('agent:configure', async (auth) => {
    await connectGithub({ workspaceId: auth.workspace.id, actorId: auth.user.id, ...p.data })
    refresh()
    return { ok: true, message: 'Website repository connected. Drafts will arrive as pull requests.' }
  }, 'Could not connect GitHub.')
}

export async function disconnectAction(what: 'crm' | 'github'): Promise<ActionResult> {
  if (what !== 'crm' && what !== 'github') return { ok: false, message: 'Unknown connection.' }
  return guard('agent:configure', async (auth) => {
    await disconnect({ workspaceId: auth.workspace.id, actorId: auth.user.id, what })
    refresh()
    return { ok: true, message: 'Disconnected.' }
  }, 'Could not disconnect.')
}

const scheduleSchema = z.object({ dailyBrief: z.boolean(), findLeads: z.boolean(), outreach: z.boolean() })
export async function saveScheduleAction(schedule: z.infer<typeof scheduleSchema>): Promise<ActionResult> {
  const p = scheduleSchema.safeParse(schedule)
  if (!p.success) return { ok: false, message: 'Invalid schedule.' }
  // Turning scheduled email on is an outreach decision.
  return guard(p.data.outreach ? 'agent:outreach' : 'agent:configure', async (auth) => {
    await saveSettings({ workspaceId: auth.workspace.id, actorId: auth.user.id, schedule: p.data })
    refresh()
    return { ok: true, message: 'Schedule saved.' }
  }, 'Could not save the schedule.')
}

const targetsSchema = z.object({
  sicCodes: z.array(z.string().max(10)).max(40),
  locations: z.array(z.string().max(80)).max(20),
  excludedSections: z.array(z.string().max(2)).max(21),
  incorporatedFrom: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).nullable().optional(),
})
export async function saveTargetsAction(targets: z.infer<typeof targetsSchema>): Promise<ActionResult> {
  const p = targetsSchema.safeParse(targets)
  if (!p.success) return { ok: false, message: 'Check the targets: SIC codes are five digits.' }
  return guard('agent:run', async (auth) => {
    await saveSettings({ workspaceId: auth.workspace.id, actorId: auth.user.id, targets: { ...p.data, incorporatedFrom: p.data.incorporatedFrom ?? null } })
    refresh()
    return { ok: true, message: 'Lead targets saved.' }
  }, 'Could not save the targets.')
}

export async function saveAnswersAction(answers: Record<string, string>): Promise<ActionResult> {
  const p = z.record(z.enum(ANSWER_KEYS), z.string().max(1200)).safeParse(answers)
  if (!p.success) return { ok: false, message: 'Unknown question.' }
  return guard('agent:run', async (auth) => {
    await saveSettings({ workspaceId: auth.workspace.id, actorId: auth.user.id, answers: p.data as Record<string, string> })
    refresh()
    return { ok: true, message: 'Thanks. The agent will use that from now on.' }
  }, 'Could not save.')
}

const GOALS = ['daily_brief', 'find_leads', 'outreach', 'content'] as const
export async function runGoalAction(goal: (typeof GOALS)[number]): Promise<ActionResult<{ id: string }>> {
  if (!GOALS.includes(goal)) return { ok: false, message: 'Unknown routine.' }
  return guard(goal === 'outreach' ? 'agent:outreach' : 'agent:run', async (auth) => {
    const run = await startRun({ workspaceId: auth.workspace.id, goal: goal as GoalKind, actorId: auth.user.id, trigger: 'manual' })
    refresh()
    if (run.status === 'failed') return { ok: false, message: run.error ?? 'The run failed.', data: { id: run.id } }
    return { ok: true, message: `${GOAL_LABEL[goal as GoalKind]} finished.`, data: { id: run.id } }
  }, 'The agent could not run.')
}

export async function askAction(question: string): Promise<ActionResult<{ id: string }>> {
  const q = (question ?? '').trim()
  if (q.length < 3) return { ok: false, message: 'Ask a question.' }
  if (q.length > 2000) return { ok: false, message: 'Keep the question under 2,000 characters.' }
  return guard('agent:run', async (auth) => {
    const run = await startRun({ workspaceId: auth.workspace.id, goal: 'ask', question: q, actorId: auth.user.id, trigger: 'chat' })
    refresh()
    if (run.status === 'failed') return { ok: false, message: run.error ?? 'The agent could not answer.', data: { id: run.id } }
    return { ok: true, message: 'Answered.', data: { id: run.id } }
  }, 'The agent could not answer.')
}
