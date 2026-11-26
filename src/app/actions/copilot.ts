'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import {
  applyRecommendation,
  dismissRecommendation,
  revertRecommendation,
  type ApplyResult,
} from '@/lib/copilot/apply'
import { refreshRecommendations } from '@/lib/copilot/analyze'

export async function applyRecommendationAction(recommendationId: string): Promise<ApplyResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'recommendation:apply')
  } catch {
    return { ok: false, message: 'Your role cannot apply copilot actions. Ask an owner or growth marketer.' }
  }

  const result = await applyRecommendation({
    workspaceId: auth.workspace.id,
    recommendationId,
    actorId: auth.user.id,
  })
  revalidatePath('/', 'layout')
  return result
}

export async function revertRecommendationAction(recommendationId: string): Promise<ApplyResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'recommendation:apply')
  } catch {
    return { ok: false, message: 'Your role cannot revert copilot actions.' }
  }
  const result = await revertRecommendation({
    workspaceId: auth.workspace.id,
    recommendationId,
    actorId: auth.user.id,
  })
  revalidatePath('/', 'layout')
  return result
}

export async function dismissRecommendationAction(recommendationId: string) {
  const auth = await requireAuth()
  await dismissRecommendation({
    workspaceId: auth.workspace.id,
    recommendationId,
    actorId: auth.user.id,
  })
  revalidatePath('/', 'layout')
}

export async function refreshCopilotAction(): Promise<{ count: number }> {
  const auth = await requireAuth()
  const count = await refreshRecommendations(auth.workspace.id)
  revalidatePath('/', 'layout')
  return { count }
}
