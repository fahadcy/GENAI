import type { Metadata } from 'next'
import { Coins, Crosshair, ScanSearch, TrendingUp } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { actionsForRun, latestRun } from '@/lib/search/service'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, EmptyState, StatTile } from '@/components/ui/primitives'
import { RelativeTime, formatMoney } from '@/components/domain'
import { RunAnalysisButton } from '@/components/search/run-button'
import { SearchWorkspace, type ActionState } from '@/components/search/workspace'
import { BusinessLinks } from '@/components/search/business-views'

export const metadata: Metadata = { title: 'PPC & SEO' }

export default async function SearchPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const [run, notifications] = await Promise.all([latestRun(wsId), listNotifications(wsId, auth.user.id)])
  const canRun = can(auth.role, 'search:analyse')
  const actions = run ? await actionsForRun(wsId, run.id) : []
  const actionMap: Record<string, ActionState> = Object.fromEntries(
    actions.map((a) => [a.recommendationId, { id: a.id, status: a.status }]),
  )

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="PPC & SEO"
        description="Paid and organic search read as one system — what you pay for that you would get anyway, which promises win, and what paid can teach SEO"
        notifications={notifications}
        actions={canRun && run ? <RunAnalysisButton label="Run again" variant="secondary" /> : undefined}
      />
      <PageBody>
        {!run ? (
          <Card>
            <EmptyState
              icon={<ScanSearch className="h-5 w-5" />}
              title="No analysis yet"
              description="The analysis joins your Google Ads search terms and ad assets with Search Console, search by search, and returns ranked recommendations with their evidence. Until both are connected it runs on a simulated account, and says so everywhere."
              action={
                canRun ? (
                  <RunAnalysisButton label="Run the first analysis" />
                ) : (
                  <p className="text-[13px] text-ink-muted">
                    Your role can read an analysis but not run one.
                  </p>
                )
              }
            />
          </Card>
        ) : (
          <RunView run={run} actions={actionMap} canSubmit={canRun} />
        )}
      </PageBody>
    </>
  )
}

function RunView({
  run,
  actions,
  canSubmit,
}: {
  run: NonNullable<Awaited<ReturnType<typeof latestRun>>>
  actions: Record<string, ActionState>
  canSubmit: boolean
}) {
  const r = run.report
  const s = r.summary
  const by = { measured: 0, estimated: 0, hypothesis: 0 }
  for (const x of r.recommendations) by[x.confidence] += Math.max(0, x.monthlyImpact)
  const recentOff = (r.drifts.reduce((a, d) => a + d.recentOffIntentCost, 0) * 30.4) / r.settings.recentDays

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        {run.source === 'simulated' && (
          <Badge tone="warn" dot>
            Simulated data
          </Badge>
        )}
        <span className="tnum">
          {r.window.start} to {r.window.end} · {s.queries} searches · {s.assetsScored} ad assets ·{' '}
          {s.pagesAnalysed} pages
        </span>
        <span>·</span>
        <span>
          run <RelativeTime date={run.createdAt} /> in {run.durationMs ?? 0} ms, no model call
        </span>
        <span className="font-mono" title="sha256 of the stored report">
          · report {run.reportHash.slice(0, 12)}
        </span>
      </div>

      {r.dataNote && (
        <p className="rounded-md bg-warn-bg px-3 py-2 ring-1 ring-warn-fg/20 text-[13px] text-ink-muted">
          {r.dataNote}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Paid search spend"
          value={formatMoney(Math.round(s.monthlyPaidSpend))}
          hint="a month"
          icon={<Coins className="h-4 w-4" />}
        />
        <StatTile
          label="Paying where you already rank"
          value={formatMoney(Math.round(s.monthlyOverlapSpend))}
          hint={`${Math.round((s.monthlyOverlapSpend / Math.max(1, s.monthlyPaidSpend)) * 100)}% of spend, organic top three`}
          icon={<Crosshair className="h-4 w-4" />}
        />
        <StatTile
          label="Spend on non-buyers"
          value={formatMoney(Math.round(recentOff))}
          hint="monthly rate, last 14 days"
          icon={<ScanSearch className="h-4 w-4" />}
        />
        <StatTile
          label="Monthly opportunity"
          value={formatMoney(Math.round(by.measured + by.estimated))}
          hint={`${formatMoney(Math.round(by.measured))} measured · plus ${formatMoney(Math.round(by.hypothesis))} to test`}
          icon={<TrendingUp className="h-4 w-4" />}
        />
      </div>

      <BusinessLinks canExport={canSubmit} />
      <SearchWorkspace runId={run.id} report={r} actions={actions} canSubmit={canSubmit} />
    </div>
  )
}
