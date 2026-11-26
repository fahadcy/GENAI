import type { Metadata } from 'next'
import {
  Banknote,
  Coins,
  Target,
  TrendingUp,
  UserPlus,
} from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can, ROLE_LABEL } from '@/lib/auth/rbac'
import { openRecommendations, recentlyApplied } from '@/lib/copilot/analyze'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, RequirementNote } from '@/components/shell/page'
import { StatTile } from '@/components/ui/primitives'
import { formatCompact, formatMoney, formatPercent } from '@/components/domain'
import { CopilotPanel, type RecommendationView } from '@/components/copilot/panel'
import { RangeFilter } from '@/components/performance/range-filter'
import { TrendPanel } from '@/components/performance/trend-panel'
import { ChannelScorecard } from '@/components/performance/channel-scorecard'
import { CampaignAttribution } from '@/components/performance/campaign-attribution'
import { SendTimePanel } from '@/components/performance/send-time-panel'
import { AssetTable } from '@/components/performance/asset-table'
import {
  RANGE_OPTIONS,
  assetPerformance,
  campaignAttribution,
  channelScorecard,
  parseRange,
  performanceTotals,
  performanceTrend,
  sendTimeComparison,
} from './queries'

export const metadata: Metadata = { title: 'Performance' }

/**
 * The recommendation types this screen is responsible for. Approval bottlenecks
 * and audience expansion are real findings, but they belong to the surfaces that
 * can act on them — showing them here would give the marketer a decision they
 * cannot make from this page.
 */
const PERFORMANCE_RECS = new Set(['creative_fatigue', 'budget_shift', 'send_time'])

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const currency = auth.workspace.settings.currency
  const days = parseRange((await searchParams).range)

  const [totals, trend, channels, campaigns, assets, sendTime, recs, applied, notifications] =
    await Promise.all([
      performanceTotals(wsId, days),
      performanceTrend(wsId, days),
      channelScorecard(wsId, days),
      campaignAttribution(wsId, days),
      assetPerformance(wsId, days),
      sendTimeComparison(wsId, days),
      openRecommendations(wsId, 20),
      recentlyApplied(wsId, 8),
      listNotifications(wsId, auth.user.id),
    ])

  const costPerSignup = totals.signups > 0 ? totals.spend / totals.signups : null
  const prevCostPerSignup = totals.prevSignups > 0 ? totals.prevSpend / totals.prevSignups : null

  const toView = (r: Awaited<ReturnType<typeof openRecommendations>>[number]): RecommendationView => ({
    id: r.id,
    type: r.type,
    title: r.title,
    rationale: r.rationale,
    evidence: r.evidence,
    expectedEffect: r.expectedEffect,
    priorityScore: r.priorityScore,
    status: r.status,
    appliedAt: r.appliedAt?.toISOString() ?? null,
  })

  const perfRecs = recs.filter((r) => PERFORMANCE_RECS.has(r.type)).map(toView)
  const perfApplied = applied.filter((r) => PERFORMANCE_RECS.has(r.type)).map(toView)

  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  const window = `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  /**
   * A period-over-period delta is only honest when both windows are measured
   * for a comparable stretch. This workspace's history starts partway into the
   * 30- and 90-day comparison windows, and dividing a full month by a few
   * scattered days produces a four-figure "increase" that means nothing. Below
   * three quarters coverage the tiles show the number without a delta and the
   * header says why.
   */
  const comparable =
    totals.prevMeasuredDays > 0 && totals.prevMeasuredDays >= totals.measuredDays * 0.75

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Performance"
        description={`${ROLE_LABEL[auth.role]} · results tied to spend and to the decisions that produced them`}
        notifications={notifications}
      />

      <PageBody>
        {/* One filter row, above everything it scopes: the range drives every
            panel on the page through a server refetch. */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <RangeFilter options={RANGE_OPTIONS} value={days} />
            <RequirementNote>
              PF-1 every channel against spend and pipeline · PF-2 results attributed to campaigns,
              assets and send-time decisions · PF-3 fatigue and underperformance · PF-4 budget and
              scheduling changes applied from here · PF-5 scorecard export.
            </RequirementNote>
          </div>
          <p className="text-xs text-ink-muted">
            {window}
            {comparable ? (
              <span className="text-ink-faint"> · compared with the {days} days before</span>
            ) : totals.prevMeasuredDays === 0 ? (
              <span className="text-ink-faint"> · no earlier data to compare against</span>
            ) : (
              <span className="text-ink-faint">
                {' '}
                · only {totals.prevMeasuredDays} measured day
                {totals.prevMeasuredDays === 1 ? '' : 's'} beforehand, so deltas are withheld
              </span>
            )}
          </p>
        </div>

        {/* ------------------------------------------------------------ KPIs */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile
            label="Signups"
            value={totals.signups.toLocaleString('en-GB')}
            delta={comparable ? delta(totals.signups, totals.prevSignups, true) : undefined}
            hint={`${days}-day total`}
            icon={<UserPlus className="h-4 w-4" />}
          />
          <StatTile
            label="Cost per signup"
            value={costPerSignup === null ? '—' : formatMoney(costPerSignup, currency)}
            delta={comparable ? delta(costPerSignup ?? 0, prevCostPerSignup ?? 0, false) : undefined}
            hint="blended, all channels"
            icon={<Coins className="h-4 w-4" />}
          />
          <StatTile
            label="Conversions"
            value={totals.conversions.toLocaleString('en-GB')}
            delta={comparable ? delta(totals.conversions, totals.prevConversions, true) : undefined}
            hint={
              totals.clicks > 0
                ? `${formatPercent(totals.conversions / totals.clicks, 1)} of clicks`
                : undefined
            }
            icon={<Target className="h-4 w-4" />}
          />
          {/* Spend carries no coloured delta on purpose: spending more is
              neither good nor bad on its own, and the cost-per-signup tile is
              where that judgement belongs. */}
          <StatTile
            label="Media spend"
            value={formatMoney(totals.spend, currency)}
            hint={
              comparable
                ? `from ${formatMoney(totals.prevSpend, currency)} · ${formatCompact(totals.impressions)} impr.`
                : `${formatCompact(totals.impressions)} impressions`
            }
            icon={<Banknote className="h-4 w-4" />}
          />
          <StatTile
            label="Revenue"
            value={formatMoney(totals.revenue, currency)}
            delta={comparable ? delta(totals.revenue, totals.prevRevenue, true) : undefined}
            hint={`${formatMoney(totals.pipeline, currency)} pipeline`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* -------------------------------------------------- left column */}
          <div className="space-y-6">
            <TrendPanel
              points={trend.points}
              grain={trend.grain}
              currency={currency}
              rangeDays={days}
            />

            <ChannelScorecard rows={channels} currency={currency} rangeDays={days} />

            <div className="grid gap-6 lg:grid-cols-2">
              <CampaignAttribution rows={campaigns} currency={currency} rangeDays={days} />
              <SendTimePanel
                ai={sendTime.ai}
                manual={sendTime.manual}
                predictedLift={sendTime.predictedLift}
                channels={sendTime.channels}
                rangeDays={days}
              />
            </div>

            <AssetTable rows={assets} currency={currency} rangeDays={days} />
          </div>

          {/* ------------------------------------------------- right column */}
          <div className="xl:sticky xl:top-[72px] xl:h-[calc(100vh-96px)]">
            <CopilotPanel
              recommendations={perfRecs}
              applied={perfApplied}
              canApply={can(auth.role, 'recommendation:apply')}
            />
          </div>
        </div>
      </PageBody>
    </>
  )
}

/** Period-over-period delta for a stat tile, or nothing when there is no baseline. */
function delta(
  current: number,
  previous: number,
  higherIsBetter: boolean,
): { value: string; direction: 'up' | 'down' | 'flat'; good?: boolean } | undefined {
  if (!previous || !Number.isFinite(previous) || !Number.isFinite(current)) return undefined
  const change = (current - previous) / previous
  if (Math.abs(change) < 0.005) return { value: 'level', direction: 'flat' }
  return {
    value: formatPercent(Math.abs(change), 0),
    direction: change > 0 ? 'up' : 'down',
    good: higherIsBetter ? change > 0 : change < 0,
  }
}
