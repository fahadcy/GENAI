import type { Metadata } from 'next'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { adAccounts, campaigns } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, RequirementNote } from '@/components/shell/page'
import { Card, EmptyState, LinkButton } from '@/components/ui/primitives'
import { CampaignBuilder } from '@/components/ads/builder'
import { competitorContextSummary, loadProfile } from '@/lib/competitors/service'

export const metadata: Metadata = { title: 'New campaign' }

export default async function NewAdCampaignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const params = await searchParams

  const [accounts, marketingCampaigns, notifications, competitorContext, competitorProfile] = await Promise.all([
    db
      .select({
        id: adAccounts.id,
        descriptiveName: adAccounts.descriptiveName,
        customerId: adAccounts.customerId,
        currencyCode: adAccounts.currencyCode,
      })
      .from(adAccounts)
      .where(eq(adAccounts.workspaceId, wsId))
      .orderBy(desc(adAccounts.createdAt)),
    db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, wsId))
      .orderBy(desc(campaigns.updatedAt))
      .limit(50),
    listNotifications(wsId, auth.user.id),
    competitorContextSummary(wsId),
    loadProfile(wsId),
  ])

  const canCreate = can(auth.role, 'ads:create')

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="New campaign"
        description="Five questions in; a complete Google Ads campaign out, for you to read before anyone approves it"
        notifications={notifications}
      />

      <PageBody width="narrow">
        {canCreate ? (
          <>
            <CampaignBuilder
              accounts={accounts.map((a) => ({
                id: a.id,
                name: a.descriptiveName ?? `Account ${a.customerId}`,
                currencyCode: a.currencyCode,
              }))}
              campaigns={marketingCampaigns}
              workspaceCurrency={auth.workspace.settings?.currency ?? 'GBP'}
              competitorContext={competitorContext}
              initial={{
                brief: params.brief?.slice(0, 1000),
                name: params.name?.slice(0, 120),
                finalUrl:
                  params.url?.slice(0, 500) ??
                  (competitorProfile?.domain ? `https://${competitorProfile.domain}/` : undefined),
              }}
            />
            <RequirementNote>
              Nothing on this screen reaches Google. The campaign is built here, checked against
              Google&rsquo;s rules, then goes through the normal approval gate before it can be sent.
            </RequirementNote>
          </>
        ) : (
          <Card>
            <EmptyState
              title="Your role cannot build campaigns"
              description="Building a campaign is restricted to owners, marketing ops and growth marketers, because a campaign is what eventually spends money. You can still read every campaign in the workspace."
              action={
                <LinkButton href="/ads" size="sm">
                  Back to Google Ads
                </LinkButton>
              }
            />
          </Card>
        )}
      </PageBody>
    </>
  )
}
