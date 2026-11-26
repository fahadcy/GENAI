import '../src/lib/load-env'
import { eq } from 'drizzle-orm'
import { db } from '../src/lib/db'
import {
  approvalChains,
  brandProfiles,
  legalRules,
  memberships,
  users,
  workspaces,
  type ApprovalStep,
} from '../src/lib/db/schema'

/**
 * Every database test builds its own throwaway workspace. Tenant isolation is
 * the thing under test as much as anything else, so tests must never lean on
 * the seeded demo data — and must never damage it either.
 */
export type Fixture = Awaited<ReturnType<typeof createWorkspace>>

let counter = 0

export async function createWorkspace(options: { chainSteps?: ApprovalStep[] } = {}) {
  const n = ++counter
  const suffix = `${process.pid}-${Date.now().toString(36)}-${n}`

  const [ws] = await db
    .insert(workspaces)
    .values({ name: `Test ${suffix}`, slug: `test-${suffix}`, plan: 'trial' })
    .returning()

  const mkUser = async (role: 'owner' | 'creator' | 'approver' | 'admin', name: string) => {
    const [u] = await db
      .insert(users)
      .values({ name, email: `${role}-${suffix}@test.invalid`, passwordHash: null })
      .returning()
    await db.insert(memberships).values({ workspaceId: ws.id, userId: u.id, role })
    return u
  }

  const owner = await mkUser('owner', 'Test Owner')
  const creator = await mkUser('creator', 'Test Creator')
  const approver = await mkUser('approver', 'Test Approver')
  const admin = await mkUser('admin', 'Test Admin')

  const [profile] = await db
    .insert(brandProfiles)
    .values({
      workspaceId: ws.id,
      name: 'Test voice',
      isDefault: true,
      voice: 'Plain and direct.',
      bannedTerms: ['guaranteed'],
      passThreshold: 60,
    })
    .returning()

  const [rule] = await db
    .insert(legalRules)
    .values({
      workspaceId: ws.id,
      name: 'No guarantees',
      pattern: '\\bguarantee[sd]?\\b',
      severity: 'high',
      message: 'Absolute guarantees are not permitted.',
    })
    .returning()

  const [chain] = await db
    .insert(approvalChains)
    .values({
      workspaceId: ws.id,
      name: 'Test chain',
      scope: {},
      steps: options.chainSteps ?? [
        { name: 'Marketing review', role: 'approver', mode: 'any', slaHours: 8 },
      ],
      isDefault: true,
    })
    .returning()

  return { ws, owner, creator, approver, admin, profile, rule, chain }
}

export async function destroyWorkspace(fixture: Fixture) {
  // Cascades clear everything else that hangs off the workspace.
  await db.delete(workspaces).where(eq(workspaces.id, fixture.ws.id))
  for (const u of [fixture.owner, fixture.creator, fixture.approver, fixture.admin]) {
    await db.delete(users).where(eq(users.id, u.id))
  }
}

export { db }
