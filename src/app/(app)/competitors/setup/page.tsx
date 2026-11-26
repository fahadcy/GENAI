import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { loadProfile } from '@/lib/competitors/service'
import { configured, providerStatus } from '@/lib/competitors/sources/config'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { LinkButton } from '@/components/ui/primitives'
import { ProfileSetup } from '@/components/competitors/setup'
import { SourcesPanel } from '@/components/competitors/sources-panel'

export const metadata: Metadata = { title: 'Competitor profile' }

export default async function CompetitorSetupPage() {
  const auth = await requireAuth()
  if (!can(auth.role, 'competitor:analyse')) redirect('/competitors')
  const [profile, notifications] = await Promise.all([
    loadProfile(auth.workspace.id),
    listNotifications(auth.workspace.id, auth.user.id),
  ])
  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Competitor profile"
        description="What you do, where you compete and the searches every competitor is measured against"
        notifications={notifications}
        actions={
          <LinkButton href="/competitors" size="sm" variant="ghost">
            Back to Competitors
          </LinkButton>
        }
      />
      <PageBody width="narrow">
        <div className="space-y-4">
          <ProfileSetup companiesHouse={configured('companies_house')} initial={profile} firstRun={!profile} />
          <SourcesPanel providers={providerStatus()} />
        </div>
      </PageBody>
    </>
  )
}
