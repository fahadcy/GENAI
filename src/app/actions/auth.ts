'use server'

import { redirect } from 'next/navigation'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { brandProfiles, approvalChains, memberships, subscriptions, users, workspaces } from '@/lib/db/schema'
import { hashPassword, passwordProblems, verifyPassword } from '@/lib/auth/password'
import { createSession, destroySession, getAuth, switchWorkspace } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/auth/rbac'
import { recordAudit } from '@/lib/workflow/audit'

export type FormState = { error?: string; fieldErrors?: Record<string, string> } | null

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
  })
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])) }
  }

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${parsed.data.email})`)
    .limit(1)

  // Same message and comparable timing whether or not the account exists.
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? null)
  if (!user || !ok) {
    return { error: 'That email and password combination is not recognised.' }
  }

  const [membership] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1)

  if (!membership) return { error: 'This account is not a member of any workspace.' }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
  await createSession(user.id, membership.workspaceId)

  redirect(ROLE_HOME[membership.role] ?? '/command-center')
}

const signupSchema = z.object({
  name: z.string().min(2, 'Enter your name.'),
  email: z.string().email('Enter a valid email address.'),
  password: z.string(),
  workspaceName: z.string().min(2, 'Give your workspace a name.'),
})

export async function signupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    name: String(formData.get('name') ?? '').trim(),
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    workspaceName: String(formData.get('workspaceName') ?? '').trim(),
  })
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])) }
  }

  const problems = passwordProblems(parsed.data.password)
  if (problems.length) return { fieldErrors: { password: problems.join(' ') } }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${parsed.data.email})`)
    .limit(1)
  if (existing) return { fieldErrors: { email: 'An account with this email already exists.' } }

  const slug = await uniqueSlug(parsed.data.workspaceName)

  const [ws] = await db
    .insert(workspaces)
    .values({
      name: parsed.data.workspaceName,
      slug,
      plan: 'trial',
      seats: 3,
      trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
    })
    .returning()

  const [user] = await db
    .insert(users)
    .values({
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      avatarHue: Math.floor(Math.random() * 360),
    })
    .returning()

  await db.insert(memberships).values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
  await db.insert(subscriptions).values({ workspaceId: ws.id, plan: 'trial', status: 'trialing', seats: 3 })

  // A workspace with no brand profile and no approval chain cannot govern
  // anything, so both are created up front rather than left as a setup chore.
  await db.insert(brandProfiles).values({
    workspaceId: ws.id,
    name: `${parsed.data.workspaceName} — core voice`,
    isDefault: true,
    voice: 'Clear, credible and human. Concrete over abstract. Respect the reader’s time.',
    doList: ['Lead with the concrete problem', 'Use specific figures where we have them'],
    dontList: ['Open with a cliché', 'Make claims we cannot evidence'],
    bannedTerms: ['guaranteed', 'revolutionary', 'game-changing'],
  })

  await db.insert(approvalChains).values({
    workspaceId: ws.id,
    name: 'Standard content',
    description: 'One review before anything can be scheduled.',
    scope: {},
    steps: [{ name: 'Marketing review', role: 'approver', mode: 'any', slaHours: 24 }],
    isDefault: true,
  })

  await recordAudit({
    workspaceId: ws.id,
    actorId: user.id,
    action: 'campaign.created',
    subjectType: 'workspace',
    subjectId: ws.id,
    summary: `Workspace "${ws.name}" created. Audit trail begins here.`,
    payload: { plan: 'trial' },
  })

  await createSession(user.id, ws.id)
  redirect('/onboarding')
}

export async function logoutAction() {
  await destroySession()
  redirect('/login')
}

export async function switchWorkspaceAction(formData: FormData) {
  const id = String(formData.get('workspaceId') ?? '')
  const auth = await getAuth()
  if (!auth) redirect('/login')
  const allowed = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(sql`${memberships.userId} = ${auth.user.id} and ${memberships.workspaceId} = ${id}`)
    .limit(1)
  if (allowed.length === 0) return
  await switchWorkspace(id)
  redirect('/command-center')
}

async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace'
  for (let i = 0; i < 40; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`
    const [taken] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1)
    if (!taken) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}
