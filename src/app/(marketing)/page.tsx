import { redirect } from 'next/navigation'
import { getAuth } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/auth/rbac'

/**
 * The front door goes straight to work.
 *
 * This is an internal tool with a known set of people, not a product anyone
 * arrives at cold, so the marketing page is the wrong thing to meet them
 * with. Signed in, you land on whatever your role's home is; signed out, you
 * land on the sign-in form. The marketing page still exists at `/product`.
 */
export default async function Home() {
  const auth = await getAuth()
  redirect(auth ? (ROLE_HOME[auth.role] ?? '/command-center') : '/login')
}
