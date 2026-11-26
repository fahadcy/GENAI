import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, History, Sparkles, Target } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Avatar, Badge, Card, EmptyState } from '@/components/ui/primitives'
import { ChannelChip, RelativeTime, formatCompact, formatMoney, formatPercent } from '@/components/domain'
import { PlanWorkspace } from '@/components/planner/workspace'
import { CampaignActions } from '@/components/planner/campaign-actions'
import { Meter } from '@/components/planner/bits'
import { formatIso, fromDay, pluralDays, toDay, todayDay } from '@/components/planner/schedule'
import { GOAL_METRIC_LABEL } from '@/components/planner/types'
import {
  attachableAssets,
  campaignResults,
  chainOptions,
  getCampaign,
  getPlan,
  planningNote,
  rescheduleHistory,
  segmentOptions,
} from '../queries'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const auth = await requireAuth()
  const campaign = await getCampaign(auth.workspace.id, id)
  return { title: campaign ? campaign.name : 'Campaign' }
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const currency = auth.workspace.settings.currency

  const campaign = await getCampaign(wsId, id)
  if (!campaign) notFound()

  const [tasks, results, segments, chains, attachable, note, history, notifications] =
    await Promise.all([
      getPlan(wsId, id),
      campaignResults(id, campaign.goalMetric),
      segmentOptions(wsId),
      chainOptions(wsId),
      attachableAssets(wsId, id),
      planningNote(wsId, id),
      rescheduleHistory(wsId, id),
      listNotifications(wsId, auth.user.id),
    ])

  const canEdit = can(auth.role, 'campaign:edit')
  const today = todayDay()
  const todayIso = fromDay(today)

  const start = campaign.startDate ? toDay(campaign.startDate) : null
  const end = campaign.endDate ? toDay(campaign.endDate) : null
  const elapsed =
    start !== null && end !== null
      ? Math.max(0, Math.min(1, (today - start) / Math.max(1, end - start)))
      : null
  const goalShare =
    campaign.targetValue && campaign.targetValue > 0
      ? results.goalActual / campaign.targetValue
      : null
  const done = tasks.filter((t) => t.status === 'done').length

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={campaign.name}
        description={`${campaign.status} · ${tasks.length} tasks · ${formatIso(
          campaign.startDate,
        )} – ${formatIso(campaign.endDate, { year: true })}`}
        notifications={notifications}
        actions={
          <CampaignActions
            campaignId={campaign.id}
            campaignName={campaign.name}
            status={campaign.status}
            taskCount={tasks.length}
            canEdit={canEdit}
          />
        }
      />

      <PageBody>
        <Link
          href="/planner"
          className="mb-4 inline-flex items-center gap-1 text-[13px] text-ink-muted transition-colors hover:text-ink"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          All campaigns
        </Link>

        {/* ------------------------------------------------------- header */}
        <Card className="overflow-hidden">
          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,190px))]">
            <div className="min-w-0">
              <p className="label">Objective</p>
              <p className="mt-1.5 text-[15px] leading-snug text-ink">{campaign.objective}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
                {campaign.ownerName && (
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar name={campaign.ownerName} hue={campaign.ownerHue ?? 250} size={18} />
                    {campaign.ownerName}
                  </span>
                )}
                <span className="tnum">
                  {formatIso(campaign.startDate)} – {formatIso(campaign.endDate)}
                  {end !== null &&
                    (end >= today ? ` · ${pluralDays(end - today)} left` : ' · window closed')}
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {campaign.channels.map((c) => (
                    <ChannelChip key={c} channel={c} size="sm" />
                  ))}
                </span>
              </div>
            </div>

            <Stat
              label={GOAL_METRIC_LABEL[campaign.goalMetric] ?? campaign.goalMetric}
              value={formatCompact(results.goalActual)}
              suffix={campaign.targetValue ? `/${formatCompact(campaign.targetValue)}` : undefined}
              meter={
                goalShare !== null
                  ? {
                      value: results.goalActual,
                      max: campaign.targetValue ?? 1,
                      tone: goalShare >= 1 ? 'ok' : goalShare >= 0.6 ? 'brand' : 'warn',
                    }
                  : undefined
              }
              note={
                goalShare !== null
                  ? `${formatPercent(goalShare, 0)} of target${
                      elapsed !== null ? ` · ${formatPercent(elapsed, 0)} of window gone` : ''
                    }`
                  : 'no target set on this campaign'
              }
            />

            <Stat
              label="Spend"
              value={formatMoney(results.spend, currency)}
              meter={{
                value: results.spend,
                max: Math.max(1, campaign.budget),
                tone:
                  elapsed !== null &&
                  campaign.budget > 0 &&
                  results.spend / campaign.budget > Math.max(0.1, elapsed) * 1.25
                    ? 'danger'
                    : 'brand',
              }}
              note={`of ${formatMoney(campaign.budget, currency)}${
                results.conversions > 0
                  ? ` · ${formatMoney(results.spend / results.conversions, currency)} per conversion`
                  : ''
              }`}
            />

            <Stat
              label="Plan progress"
              value={String(done)}
              suffix={`/${tasks.length}`}
              meter={{ value: done, max: Math.max(1, tasks.length), tone: 'ok' }}
              note={
                tasks.length === 0
                  ? 'no tasks on this campaign'
                  : `${tasks.length - done} still open · ${
                      tasks.filter((t) => t.isMilestone).length
                    } milestone${tasks.filter((t) => t.isMilestone).length === 1 ? '' : 's'}`
              }
            />
          </div>

          {(note || history.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line bg-bg-subtle px-5 py-2.5 text-2xs text-ink-faint">
              {note && (
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" />
                  Planned <RelativeTime date={note.at} />
                  {note.simulated && (
                    <Badge tone="neutral" className="ml-1">
                      simulated model
                    </Badge>
                  )}
                </span>
              )}
              {history.length > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <History className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    Last recalculated <RelativeTime date={history[0].at} />
                    {history[0].actorName ? ` by ${history[0].actorName}` : ''} — {history[0].summary}
                  </span>
                </span>
              )}
              {tasks.some((t) => t.segmentId) && (
                <span className="inline-flex items-center gap-1.5">
                  <Target className="h-3 w-3" />
                  {tasks.filter((t) => t.segmentId).length} task
                  {tasks.filter((t) => t.segmentId).length === 1 ? '' : 's'} aimed at a saved audience
                </span>
              )}
            </div>
          )}
        </Card>

        {/* --------------------------------------------------------- plan */}
        <div className="mt-6">
          {tasks.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Target className="h-5 w-5" />}
                title="This campaign has no plan"
                description="It was created without one, or every task has since been removed. Start a fresh plan from the composer on the planner index and it will arrive with phases, owners and dependencies already wired."
              />
            </Card>
          ) : (
            <PlanWorkspace
              campaignId={campaign.id}
              tasks={tasks}
              segments={segments}
              chains={chains}
              attachable={attachable}
              todayIso={todayIso}
              campaignStartIso={campaign.startDate}
              campaignEndIso={campaign.endDate}
              budget={campaign.budget}
              spend={results.spend}
              currency={currency}
              canEdit={canEdit}
              planningRisks={note?.risks ?? []}
            />
          )}
        </div>
      </PageBody>
    </>
  )
}

function Stat({
  label,
  value,
  suffix,
  meter,
  note,
}: {
  label: string
  value: string
  suffix?: string
  meter?: { value: number; max: number; tone: 'brand' | 'ok' | 'warn' | 'danger' }
  note?: string
}) {
  return (
    <div className="min-w-0 border-line lg:border-l lg:pl-6">
      <p className="label">{label}</p>
      <p className="tnum mt-1.5 text-xl font-semibold leading-none tracking-tight text-ink">
        {value}
        {suffix && <span className="text-ink-faint">{suffix}</span>}
      </p>
      {meter && <Meter value={meter.value} max={meter.max} tone={meter.tone} className="mt-2.5" />}
      {note && <p className="mt-1.5 text-2xs leading-snug text-ink-faint">{note}</p>}
    </div>
  )
}
