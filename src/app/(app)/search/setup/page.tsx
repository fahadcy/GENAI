import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { latestRun, loadProfile } from '@/lib/search/service'
import { DEFAULT_BUSINESS } from '@/lib/serptwin/business-sim'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { SetupForm } from '@/components/search/setup-form'

export const metadata: Metadata = { title: 'Business setup' }

export default async function SearchSetupPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const [profile, run, notifications] = await Promise.all([
    loadProfile(wsId),
    latestRun(wsId),
    listNotifications(wsId, auth.user.id),
  ])
  const known = new Map<string, string>()
  for (const u of run?.report.leads?.units ?? [])
    if (u.kind === 'ad_group') known.set(u.key.slice(3), u.label)
  for (const s of profile?.services ?? []) for (const g of s.adGroupIds) if (!known.has(g)) known.set(g, g)

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Business setup"
        description="What you sell, what a customer is worth and what the team can take on. The lead, budget and SEO engines read this; they never guess it"
        notifications={notifications}
      />
      <PageBody width="wide">
        <Link
          href="/search"
          className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> PPC &amp; SEO
        </Link>
        <SetupForm
          initial={profile ?? DEFAULT_BUSINESS}
          isExample={!profile}
          adGroups={[...known.entries()].map(([id, name]) => ({ id, name }))}
          canEdit={can(auth.role, 'search:apply')}
        />
      </PageBody>
    </>
  )
}
