import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, eq, gt } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { memberships, sessions, users, workspaces } from '@/lib/db/schema'
import type { Role, Workspace } from '@/lib/db/schema'

const COOKIE = 'genai_session'
const TTL_DAYS = 30

export type SessionUser = {
  id: string
  email: string
  name: string
  avatarHue: number
  jobTitle: string | null
}

export type AuthContext = {
  user: SessionUser
  workspace: Workspace
  role: Role
  sessionId: string
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex')

/* ------------------------------------------------------------- lifecycle */

export async function createSession(userId: string, workspaceId: string | null) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86_400_000)
  const hdrs = await headers()

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      workspaceId,
      tokenHash: sha(token),
      expiresAt,
      userAgent: hdrs.get('user-agent')?.slice(0, 256) ?? null,
      ip: (hdrs.get('x-forwarded-for') ?? '').split(',')[0].trim().slice(0, 64) || null,
    })
    .returning({ id: sessions.id })

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
  return row.id
}

export async function destroySession() {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha(token)))
  jar.delete(COOKIE)
}

export async function switchWorkspace(workspaceId: string) {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return
  await db.update(sessions).set({ workspaceId }).where(eq(sessions.tokenHash, sha(token)))
}

/* ---------------------------------------------------------------- lookup */

/**
 * Deduped per request by React `cache`, so a page that reads the session in the
 * layout, the header and three server components still issues one query.
 */
export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionWorkspaceId: sessions.workspaceId,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        avatarHue: users.avatarHue,
        jobTitle: users.jobTitle,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  // Resolve the active workspace: the one pinned on the session, else the first
  // membership. A user removed from their pinned workspace falls back cleanly.
  const memberRows = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, row.user.id))

  if (memberRows.length === 0) return null
  const active =
    memberRows.find((m) => m.workspace.id === row.sessionWorkspaceId) ?? memberRows[0]

  return {
    user: row.user,
    workspace: active.workspace,
    role: active.role,
    sessionId: row.sessionId,
  }
})

export const listWorkspaces = cache(async (userId: string) => {
  return db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
})

/** Use in every authenticated server component and route handler. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth()
  if (!auth) redirect('/login')
  return auth
}
