'use server'

import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { decide, delegate, GateError } from '@/lib/workflow/approvals'
import { exportAuditCsv, verifyChain } from '@/lib/workflow/audit'
import type { ActionResult } from './content'

export async function decideAction(
  requestId: string,
  decision: 'approve' | 'reject',
  comment?: string,
  /** Revalidated in addition to the standard set, e.g. `/ads/{id}`. */
  returnPath?: string,
): Promise<ActionResult<{ status: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'approval:decide')
  } catch {
    return { ok: false, message: 'Your role cannot approve or reject work.' }
  }

  try {
    const result = await decide({
      workspaceId: auth.workspace.id,
      requestId,
      actorId: auth.user.id,
      actorRole: auth.role,
      decision,
      comment,
    })
    revalidatePath('/approvals')
    revalidatePath('/studio')
    revalidatePath('/command-center')
    // Paid campaigns are approved on their own screen, so it has to be
    // revalidated too or the reviewer's decision does not appear where they made it.
    revalidatePath('/ads')
    if (returnPath) revalidatePath(returnPath)

    const message =
      result.status === 'approved'
        ? returnPath?.startsWith('/budget')
          ? 'Approved. An owner or marketing ops can now make it live.'
          : 'Approved. It can now be scheduled.'
        : result.status === 'rejected'
          ? 'Changes requested. The author has been notified.'
          : `Approved at this step. Now with ${result.nextStep}.`
    return { ok: true, message, data: { status: result.status } }
  } catch (e) {
    return { ok: false, message: e instanceof GateError ? e.message : 'Could not record that decision.' }
  }
}

export async function delegateAction(
  requestId: string,
  toUserId: string,
  comment?: string,
): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'approval:decide')
  } catch {
    return { ok: false, message: 'Your role cannot delegate approvals.' }
  }
  try {
    await delegate({
      workspaceId: auth.workspace.id,
      requestId,
      actorId: auth.user.id,
      toUserId,
      comment,
    })
    revalidatePath('/approvals')
    return { ok: true, message: 'Delegated. They have been notified.' }
  } catch (e) {
    return { ok: false, message: e instanceof GateError ? e.message : 'Could not delegate.' }
  }
}

export async function verifyAuditChainAction() {
  const auth = await requireAuth()
  return verifyChain(auth.workspace.id)
}

export async function exportAuditAction(): Promise<{ filename: string; csv: string }> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'audit:export')
  } catch {
    throw new Error('Your role cannot export the audit trail.')
  }
  const csv = await exportAuditCsv(auth.workspace.id)
  return {
    filename: `${auth.workspace.slug}-audit-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
  }
}
