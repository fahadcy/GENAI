import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  BookmarkCheck,
  CircleCheck,
  Flag,
  ListChecks,
  Waypoints,
} from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Avatar, Badge, Card, EmptyState, StatTile } from '@/components/ui/primitives'
import { ChannelChip, formatCompact, formatMoney, formatPercent } from '@/components/domain'
import { CampaignComposer } from '@/components/planner/composer'
import { TemplateGallery } from '@/components/planner/templates'
import { Meter } from '@/components/planner/bits'
import { formatIso, fromDay, todayDay, toDay, pluralDays } from '@/components/planner/schedule'
import { GOAL_METRIC_LABEL, type CampaignSummary } from '@/components/planner/types'
import { listCampaigns, listTemplates } from './queries'

export const metadata: Metadata = { title: 'Campaign Planner' }

const STATUS_TONE: Record<string, 'ok' | 'brand' | 'warn' | 'neutral' | 'info'> = {
  active: 'ok',
  planning: 'info',
  draft: 'neutral',
  paused: 'warn',
  completed: 'brand',
  archived: 'neutral',
}

export default async function PlannerPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const currency = auth.workspace.settings.currency

  const [campaigns, templates, notifications] = await Promise.all([
    listCampaigns(wsId),
    listTemplates(wsId),
    listNotifications(wsId, auth.user.id),
  ])

  const canCreate = can(auth.role, 'campaign:create')
  const today = todayDay()
  const todayIso = fromDay(today)

  const live = campaigns.filter((c) => c.status === 'active')
  const totalTasks = campaigns.reduce((a, c) => a + c.taskTotal, 0)
  const doneTasks = campaigns.reduce((a, c) => a + c.taskDone, 0)
  const atRisk = campaigns.reduce((a, c) => a + c.atRisk, 0)
  const blocked = campaigns.reduce((a, c) => a + c.taskBlocked, 0)
  const committed = campaigns
    .filter((c) => c.status === 'active' || c.status === 'planning')
    .reduce((a, c) => a + c.budget, 0)
  const spent = campaigns
    .filter((c) => c.status === 'active' || c.status === 'planning')
    .reduce((a, c) => a + c.spend, 0)

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Campaign Planner"
        description={
          campaigns.length === 0
            ? 'No campaigns yet — describe an objective below to get a sequenced plan.'
            : `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} · ${totalTasks} planned tasks · every date below is recalculated from the dependency graph`
        }
        notifications={notifications}
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Campaigns live"
            value={live.length}
            hint={
              campaigns.length === live.length
                ? 'every campaign is running'
                : `${campaigns.length - live.length} in planning, paused or closed`
            }
            icon={<Waypoints className="h-4 w-4" />}
          />
          <StatTile
            label="Plan progress"
            value={totalTasks > 0 ? formatPercent(doneTasks / totalTasks, 0) : '—'}
            hint={`${doneTasks} of ${totalTasks} tasks closed`}
            icon={<ListChecks className="h-4 w-4" />}
          />
          <StatTile
            label="Tasks at risk"
            value={atRisk}
            delta={
              blocked > 0 ? { value: `${blocked} blocked`, direction: 'up', good: false } : undefined
            }
            hint={atRisk === 0 ? 'no milestone is slipping' : 'slipping, blocked or overdue'}
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <StatTile
            label="Budget committed"
            value={formatMoney(committed, currency)}
            hint={`${formatMoney(spent, currency)} spent so far`}
            delta={
              committed > 0
                ? {
                    value: formatPercent(spent / committed, 0),
                    direction: 'flat',
                  }
                : undefined
            }
          />
        </div>

        <div className="mt-6">
          <CampaignComposer
            todayIso={todayIso}
            currency={currency}
            templates={templates}
            canCreate={canCreate}
          />
        </div>

        <div className="mt-8">
          <SectionHeading
            title="Campaigns"
            description="Budget, goal attainment and plan progress read straight from the campaign's own tasks and metric facts."
          />
          {campaigns.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Waypoints className="h-5 w-5" />}
                title="Nothing planned yet"
                description="Write what this campaign has to achieve in the composer above. You will get phases, tasks, owners and a dependency graph to read before a single row is written."
              />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {campaigns.map((c) => (
                <CampaignCard key={c.id} campaign={c} currency={currency} today={today} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-8">
          <SectionHeading
            title="Saved playbooks"
            description="Plans that worked, kept as reusable shapes."
            actions={
              templates.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
                  <BookmarkCheck className="h-3.5 w-3.5" />
                  {templates.reduce((a, t) => a + t.usageCount, 0)} campaigns started from a template
                </span>
              ) : undefined
            }
          />
          <TemplateGallery templates={templates} canManage={canCreate} />
        </div>
      </PageBody>
    </>
  )
}

function CampaignCard({
  campaign: c,
  currency,
  today,
}: {
  campaign: CampaignSummary
  currency: string
  today: number
}) {
  const progress = c.taskTotal > 0 ? c.taskDone / c.taskTotal : 0
  const goalShare = c.targetValue && c.targetValue > 0 ? c.goalActual / c.targetValue : null
  const burn = c.budget > 0 ? c.spend / c.budget : 0
  const start = c.startDate ? toDay(c.startDate) : null
  const end = c.endDate ? toDay(c.endDate) : null
  const elapsed = start !== null && end !== null ? (today - start) / Math.max(1, end - start) : null

  return (
    <Card className="flex flex-col overflow-hidden transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/planner/${c.id}`}
              className="truncate text-sm font-semibold text-ink hover:text-brand-600"
            >
              {c.name}
            </Link>
            <Badge tone={STATUS_TONE[c.status] ?? 'neutral'} dot={c.status === 'active'}>
              {c.status}
            </Badge>
            {c.atRisk > 0 && (
              <Badge tone="danger">
                <AlertTriangle className="h-3 w-3" />
                {c.atRisk} at risk
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-muted">{c.objective}</p>
        </div>
        <Link
          href={`/planner/${c.id}`}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Open
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
        <div>
          <p className="label">Plan progress</p>
          <p className="tnum mt-1 text-lg font-semibold leading-none tracking-tight text-ink">
            {c.taskDone}
            <span className="text-ink-faint">/{c.taskTotal}</span>
          </p>
          <Meter
            value={c.taskDone}
            max={Math.max(1, c.taskTotal)}
            tone={c.atRisk > 0 ? 'warn' : 'ok'}
            className="mt-2"
          />
          {elapsed !== null && (
            <p className="mt-1.5 text-2xs text-ink-faint">
              {/* Progress only means something next to how much of the window
                  has already gone. */}
              {Math.round(Math.max(0, Math.min(1, elapsed)) * 100)}% of the window elapsed
            </p>
          )}
        </div>

        <div>
          <p className="label">{GOAL_METRIC_LABEL[c.goalMetric] ?? c.goalMetric}</p>
          <p className="tnum mt-1 text-lg font-semibold leading-none tracking-tight text-ink">
            {formatCompact(c.goalActual)}
            {c.targetValue ? (
              <span className="text-ink-faint">/{formatCompact(c.targetValue)}</span>
            ) : null}
          </p>
          {goalShare !== null ? (
            <>
              <Meter
                value={c.goalActual}
                max={Math.max(1, c.targetValue ?? 1)}
                tone={goalShare >= 1 ? 'ok' : goalShare >= 0.6 ? 'brand' : 'warn'}
                className="mt-2"
              />
              <p className="mt-1.5 text-2xs text-ink-faint">
                {formatPercent(goalShare, 0)} of target
              </p>
            </>
          ) : (
            <p className="mt-2 text-2xs text-ink-faint">no target set</p>
          )}
        </div>

        <div>
          <p className="label">Spend</p>
          <p className="tnum mt-1 text-lg font-semibold leading-none tracking-tight text-ink">
            {formatMoney(c.spend, currency)}
          </p>
          <Meter
            value={c.spend}
            max={Math.max(1, c.budget)}
            tone={elapsed !== null && burn > Math.max(0.1, elapsed) * 1.25 ? 'danger' : 'brand'}
            className="mt-2"
          />
          <p className="mt-1.5 text-2xs text-ink-faint">
            of {formatMoney(c.budget, currency)} budget
          </p>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-bg-subtle px-5 py-2.5 text-2xs text-ink-faint">
        {c.ownerName && (
          <span className="inline-flex items-center gap-1.5 text-ink-muted">
            <Avatar name={c.ownerName} hue={c.ownerHue ?? 250} size={16} />
            {c.ownerName}
          </span>
        )}
        <span className="tnum">
          {formatIso(c.startDate)} – {formatIso(c.endDate)}
          {end !== null && end >= today && ` · ${pluralDays(end - today)} left`}
        </span>
        {c.milestoneDate && (
          <span className="inline-flex items-center gap-1">
            <Flag className="h-3 w-3 text-gold-600" />
            {formatIso(c.milestoneDate)}
          </span>
        )}
        {c.taskBlocked === 0 && c.atRisk === 0 && c.taskTotal > 0 && (
          <span className="inline-flex items-center gap-1 text-ok-fg">
            <CircleCheck className="h-3 w-3" />
            on plan
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {c.channels.map((ch) => (
            <ChannelChip key={ch} channel={ch} size="sm" showLabel={false} />
          ))}
        </span>
      </div>

      {progress === 0 && c.taskTotal > 0 && (
        <div className="border-t border-line px-5 py-2 text-2xs text-ink-faint">
          {c.phases.length} phases planned, nothing started yet
        </div>
      )}
    </Card>
  )
}
