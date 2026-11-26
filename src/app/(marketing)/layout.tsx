import { getAuth } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/auth/rbac'
import { SiteHeader, type HeaderSession } from '@/components/marketing/site-header'
import { SiteFooter } from '@/components/marketing/site-footer'

/**
 * Public site shell. These routes are open to anyone, so the session is read
 * with getAuth() and used only to change the call to action — never to gate.
 */
export const dynamic = 'force-dynamic'

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuth()
  const session: HeaderSession = auth
    ? {
        workspaceName: auth.workspace.name,
        homeHref: ROLE_HOME[auth.role] ?? '/command-center',
      }
    : null

  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-bg">
      <SiteHeader session={session} />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  )
}
