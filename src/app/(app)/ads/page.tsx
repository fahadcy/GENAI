import type { Metadata } from 'next'
import { Megaphone, Clock, Wallet, CalendarRange } from 'lucide-react'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { adAccounts, adCampaigns } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { hasGoogleAds, googleAdsMissing } from '@/lib/env'
import { MONTHLY_BUDGET_MULTIPLIER } from '@/lib/ads/objectives'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Card, EmptyState, LinkButton, StatTile } from '@/components/ui/primitives'
import { formatMoney } from '@/components/domain'
import { ConnectAccount } from '@/components/ads/connect'
import { CampaignList, type AdCampaignRow } from '@/components/ads/list'

export const metadata: Metadata = { title: 'Google Ads' }

export default async function AdsPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const [campaigns, accounts, notifications] = await Promise.all([
    db
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.workspaceId, wsId))
      .orderBy(desc(adCampaigns.updatedAt)),
    db
      .select()
      .from(adAccounts)
      .where(eq(adAccounts.workspaceId, wsId))
      .orderBy(desc(adAccounts.createdAt)),
    listNotifications(wsId, auth.user.id),
  ])

  const canCreate = can(auth.role, 'ads:create')

  const rows: AdCampaignRow[] = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective,
    dailyBudgetMicros: c.dailyBudgetMicros,
    currencyCode: c.currencyCode,
    geoTargets: c.geoTargets,
    adGroupCount: c.structure?.adGroups.length ?? 0,
    keywordCount:
      c.structure?.adGroups.reduce((n, g) => n + g.keywords.length, 0) ?? 0,
    updatedAt: c.updatedAt,
  }))

  const live = campaigns.filter((c) => c.status === 'live')
  const awaiting = campaigns.filter((c) => c.status === 'in_review')
  // Only live campaigns are actually taking money; a draft's budget is a
  // number in a form, not a commitment, and adding it in would overstate what
  // the workspace is spending.
  const liveDaily = live.reduce((sum, c) => sum + c.dailyBudgetMicros / 1_000_000, 0)
  const liveMonthly = liveDaily * MONTHLY_BUDGET_MULTIPLIER
  const currency = live[0]?.currencyCode ?? accounts[0]?.currencyCode ?? auth.workspace.settings?.currency ?? 'GBP'

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Google Ads"
        description="Describe what you are selling and GenAI builds the campaign — you check it, approve it, then it goes to Google"
        notifications={notifications}
        actions={
          canCreate ? (
            <LinkButton href="/ads/new" variant="primary" size="sm">
              New campaign
            </LinkButton>
          ) : undefined
        }
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Running now"
            value={live.length}
            hint={live.length === 0 ? 'nothing is spending' : 'showing to people today'}
            icon={<Megaphone className="h-4 w-4" />}
          />
          <StatTile
            label="Waiting for approval"
            value={awaiting.length}
            hint={awaiting.length === 0 ? 'nothing pending' : 'someone needs to sign these off'}
            icon={<Clock className="h-4 w-4" />}
          />
          <StatTile
            label="Daily budget, running campaigns"
            value={formatMoney(liveDaily, currency)}
            hint="an average, not a cap"
            icon={<Wallet className="h-4 w-4" />}
          />
          <StatTile
            label="Monthly ceiling"
            value={formatMoney(liveMonthly, currency)}
            hint="the most it can cost"
            icon={<CalendarRange className="h-4 w-4" />}
          />
        </div>

        {/* The tile hints are clipped on a narrow screen, so the sentence that
            actually matters about how Google spends a budget is stated here in
            full rather than left to a tooltip. */}
        <p className="mt-2.5 text-xs leading-relaxed text-ink-faint">
          Google can spend up to twice the daily budget on a busy day, but across a month it will
          not charge more than {MONTHLY_BUDGET_MULTIPLIER} times it — anything above that, Google
          absorbs.
        </p>

        <div className="mt-6">
          <ConnectAccount
            accounts={accounts.map((a) => ({
              id: a.id,
              customerId: a.customerId,
              descriptiveName: a.descriptiveName,
              currencyCode: a.currencyCode,
              timeZone: a.timeZone,
              status: a.status,
              testAccount: a.testAccount,
              isManager: a.isManager,
              lastError: a.lastError,
              lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
            }))}
            configured={hasGoogleAds()}
            missing={googleAdsMissing()}
            canManage={can(auth.role, 'connector:manage')}
          />
        </div>

        <div className="mt-8">
          <SectionHeading
            title="Your campaigns"
            description="A campaign only spends money once it is running. Everything before that can be changed or thrown away."
          />
          <Card className="overflow-hidden">
            {rows.length === 0 ? (
              <EmptyState
                icon={<Megaphone className="h-5 w-5" />}
                title="No campaigns yet"
                description="Tell GenAI in a sentence what you sell and who should buy it. You will get back a complete campaign — ad groups, keywords, headlines and a budget — to read through before anything is sent anywhere."
                action={
                  canCreate ? (
                    <LinkButton href="/ads/new" variant="primary" size="sm">
                      Build your first campaign
                    </LinkButton>
                  ) : (
                    <p className="text-[13px] text-ink-muted">
                      Your role can read campaigns but not build them.
                    </p>
                  )
                }
              />
            ) : (
              <CampaignList campaigns={rows} />
            )}
          </Card>
        </div>
      </PageBody>
    </>
  )
}
