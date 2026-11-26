import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileStack,
  Sparkles,
  Timer,
} from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can, ROLE_LABEL } from '@/lib/auth/rbac'
import {
  attentionItems,
  headlineResults,
  livePipeline,
  portfolioKpis,
  recentActivity,
  upcomingSends,
} from '@/lib/queries/dashboard'
import { openRecommendations, recentlyApplied } from '@/lib/copilot/analyze'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Avatar, Badge, Card, CardHeader, EmptyState, LinkButton, StatTile } from '@/components/ui/primitives'
import {
  ChannelChip,
  PipelineStrip,
  RelativeTime,
  formatCompact,
  formatDurationMs,
  formatMoney,
  formatPercent,
} from '@/components/domain'
import { CopilotPanel, type RecommendationView } from '@/components/copilot/panel'
import { AUDIT_LABELS } from '@/lib/workflow/audit'

export const metadata: Metadata = { title: 'Command Center' }

export default async function CommandCenterPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const currency = auth.workspace.settings.currency

  const [kpis, pipeline, attention, activity, sends, results, recs, applied, notifications] =
    await Promise.all([
      portfolioKpis(wsId),
      livePipeline(wsId),
      attentionItems(wsId, auth.user.id, auth.role),
      recentActivity(wsId, 10),
      upcomingSends(wsId, 5),
      headlineResults(wsId),
      openRecommendations(wsId, 12),
      recentlyApplied(wsId, 5),
      listNotifications(wsId, auth.user.id),
    ])

  const approvalDelta =
    kpis.avgApprovalMs && kpis.prevAvgApprovalMs
      ? (kpis.avgApprovalMs - kpis.prevAvgApprovalMs) / kpis.prevAvgApprovalMs
      : null

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

  const mine = attention.filter((a) => a.mine)

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={`Good ${greeting()}, ${auth.user.name.split(' ')[0]}`}
        description={`${ROLE_LABEL[auth.role]} · ${auth.workspace.name}`}
        notifications={notifications}
        actions={
          <LinkButton href="/studio/new" variant="primary" size="sm" className="hidden sm:inline-flex">
            New brief
          </LinkButton>
        }
      />

      <PageBody>
        {/* ------------------------------------------------------------ KPIs */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Active campaigns"
            value={kpis.activeCampaigns}
            hint={`${pipeline.reduce((a, p) => a + p.total, 0)} assets in flight`}
            href="/planner"
            icon={<FileStack className="h-4 w-4" />}
          />
          <StatTile
            label="Awaiting review"
            value={kpis.awaitingReview}
            delta={
              kpis.overdueReview > 0
                ? { value: `${kpis.overdueReview} overdue`, direction: 'up', good: false }
                : undefined
            }
            hint={kpis.overdueReview === 0 ? 'All within SLA' : undefined}
            href="/approvals"
            icon={<Clock className="h-4 w-4" />}
          />
          <StatTile
            label="Scheduled (30 days)"
            value={kpis.scheduled30}
            delta={
              kpis.deadLetter > 0
                ? { value: `${kpis.deadLetter} failed`, direction: 'down', good: false }
                : undefined
            }
            hint={kpis.deadLetter === 0 ? 'Publish queue healthy' : undefined}
            href="/scheduler"
            icon={<CalendarDays className="h-4 w-4" />}
          />
          <StatTile
            label="Avg. approval time"
            value={formatDurationMs(kpis.avgApprovalMs)}
            delta={
              approvalDelta !== null
                ? {
                    value: formatPercent(Math.abs(approvalDelta), 0),
                    direction: approvalDelta < 0 ? 'down' : 'up',
                    good: approvalDelta < 0,
                  }
                : undefined
            }
            hint="vs. previous 30 days"
            href="/approvals"
            icon={<Timer className="h-4 w-4" />}
          />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          {/* -------------------------------------------------- left column */}
          <div className="space-y-6">
            {/* Needs you */}
            <Card>
              <CardHeader
                title={mine.length > 0 ? `${mine.length} item${mine.length === 1 ? '' : 's'} need you` : 'Nothing is waiting on you'}
                description={
                  mine.length > 0
                    ? 'Assigned to your role at the current approval step.'
                    : `${attention.length} item${attention.length === 1 ? ' is' : 's are'} with other reviewers.`
                }
                actions={
                  attention.length > 0 && (
                    <LinkButton href="/approvals" size="xs" variant="ghost">
                      All approvals
                      <ArrowRight className="h-3 w-3" />
                    </LinkButton>
                  )
                }
              />
              {attention.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 className="h-5 w-5" />}
                  title="The queue is empty"
                  description="Nothing is waiting for a decision anywhere in the workspace."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {attention.slice(0, 5).map((a) => (
                    <li key={a.requestId}>
                      <Link
                        href={`/approvals/${a.requestId}`}
                        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
                      >
                        <ChannelChip channel={a.channel} size="sm" showLabel={false} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium text-ink">{a.title}</p>
                          <p className="mt-0.5 truncate text-xs text-ink-muted">
                            {a.chainName} · {a.stepName} · submitted <RelativeTime date={a.requestedAt} />
                          </p>
                        </div>
                        {a.mine && <Badge tone="brand">Yours</Badge>}
                        {a.overdue ? (
                          <Badge tone="danger" dot>
                            Overdue
                          </Badge>
                        ) : (
                          <span className="hidden shrink-0 text-xs text-ink-faint sm:block">
                            due <RelativeTime date={a.dueAt} />
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Live pipeline */}
            <div>
              <SectionHeading
                title="Live pipeline"
                description="Where every asset sits across the five stages, by campaign."
                actions={
                  <LinkButton href="/planner" size="xs" variant="ghost">
                    All campaigns
                    <ArrowRight className="h-3 w-3" />
                  </LinkButton>
                }
              />
              {pipeline.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<FileStack className="h-5 w-5" />}
                    title="No campaigns with assets yet"
                    description="Write a brief and generate your first set of on-brand variants."
                    action={
                      <LinkButton href="/studio/new" variant="primary" size="sm">
                        Write a brief
                      </LinkButton>
                    }
                  />
                </Card>
              ) : (
                <div className="space-y-2">
                  {pipeline.map((row) => (
                    <Link
                      key={row.campaignId}
                      href={`/planner/${row.campaignId}`}
                      className="card block p-4 transition-colors hover:bg-surface-hover"
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {row.ownerName && (
                            <Avatar name={row.ownerName} hue={row.ownerHue ?? 250} size={24} />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-[13.5px] font-semibold text-ink">
                              {row.campaignName}
                            </p>
                            <p className="text-xs text-ink-faint">
                              {row.total} asset{row.total === 1 ? '' : 's'}
                              {row.blocked > 0 && ` · ${row.blocked} needing changes`}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {row.blocked > 0 && (
                            <Badge tone="danger" dot>
                              Blocked
                            </Badge>
                          )}
                          <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge>
                        </div>
                      </div>
                      <PipelineStrip counts={row.counts} />
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Results + upcoming */}
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader
                  title="Last 30 days"
                  description="Across every channel."
                  actions={
                    <LinkButton href="/performance" size="xs" variant="ghost">
                      Detail
                    </LinkButton>
                  }
                />
                <div className="grid grid-cols-2 gap-4 p-5">
                  <Metric label="Signups" value={formatCompact(results?.signups ?? 0)} />
                  <Metric
                    label="Cost per signup"
                    value={results?.costPerSignup ? formatMoney(results.costPerSignup, currency) : '—'}
                    delta={
                      results?.costPerSignup && results?.prevCostPerSignup
                        ? (results.costPerSignup - results.prevCostPerSignup) / results.prevCostPerSignup
                        : null
                    }
                    lowerIsBetter
                  />
                  <Metric label="Conversions" value={formatCompact(results?.conversions ?? 0)} />
                  <Metric label="Spend" value={formatMoney(results?.spend ?? 0, currency)} />
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Next out the door"
                  description="Approved work with a slot booked."
                  actions={
                    <LinkButton href="/scheduler" size="xs" variant="ghost">
                      Calendar
                    </LinkButton>
                  }
                />
                {sends.length === 0 ? (
                  <EmptyState
                    icon={<CalendarDays className="h-5 w-5" />}
                    title="Nothing scheduled"
                    description="Approved assets can be placed on the calendar."
                  />
                ) : (
                  <ul className="divide-y divide-line">
                    {sends.map((s) => (
                      <li key={s.id} className="flex items-center gap-3 px-5 py-2.5">
                        <ChannelChip channel={s.channel} size="sm" showLabel={false} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink">{s.title}</p>
                          <p className="text-xs text-ink-faint">
                            <RelativeTime date={s.scheduledAt} />
                            {s.source === 'ai' && s.predictedLift
                              ? ` · AI slot, +${Math.round(s.predictedLift * 100)}% predicted`
                              : ''}
                          </p>
                        </div>
                        {s.status === 'failed' && <Badge tone="warn">Retrying</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {/* Activity */}
            <Card>
              <CardHeader
                title="Activity"
                description="Read straight from the audit trail — nothing here is reconstructed."
                actions={
                  <LinkButton href="/settings/audit" size="xs" variant="ghost">
                    Full trail
                  </LinkButton>
                }
              />
              <ul className="divide-y divide-line">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-2.5">
                    <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center">
                      {a.actorName ? (
                        <Avatar name={a.actorName} hue={a.actorHue ?? 250} size={20} />
                      ) : a.actorType === 'copilot' ? (
                        <Sparkles className="h-3.5 w-3.5 text-brand-600" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-snug text-ink">
                        <span className="font-medium">{AUDIT_LABELS[a.action] ?? a.action}</span>
                        <span className="text-ink-muted"> — {a.summary}</span>
                      </p>
                      <p className="mt-0.5 text-2xs text-ink-faint">
                        #{a.seq} · <RelativeTime date={a.createdAt} />
                        {a.actorType === 'system' && ' · system'}
                        {a.actorType === 'copilot' && ' · copilot, human-authorised'}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* ------------------------------------------------- right column */}
          <div className="xl:sticky xl:top-[72px] xl:h-[calc(100vh-96px)]">
            <CopilotPanel
              recommendations={recs.map(toView)}
              applied={applied.map(toView)}
              canApply={can(auth.role, 'recommendation:apply')}
            />
          </div>
        </div>

        {kpis.passRate !== null && (
          <p className="mt-6 flex items-center gap-2 text-xs text-ink-faint">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {formatPercent(kpis.passRate, 0)} of generated assets passed brand and legal checks without a
            manual edit
            {kpis.passRate < 0.95 && (
              <span className="inline-flex items-center gap-1 text-warn-fg">
                <AlertTriangle className="h-3 w-3" />
                target is 95%
              </span>
            )}
          </p>
        )}
      </PageBody>
    </>
  )
}

function Metric({
  label,
  value,
  delta,
  lowerIsBetter,
}: {
  label: string
  value: string
  delta?: number | null
  lowerIsBetter?: boolean
}) {
  const good = delta === null || delta === undefined ? null : lowerIsBetter ? delta < 0 : delta > 0
  return (
    <div>
      <p className="label">{label}</p>
      <p className="tnum mt-1 text-xl font-semibold tracking-tight text-ink">{value}</p>
      {delta !== null && delta !== undefined && Number.isFinite(delta) && (
        <p className={`tnum mt-0.5 text-xs font-semibold ${good ? 'text-ok-fg' : 'text-danger-fg'}`}>
          {delta > 0 ? '↑' : '↓'} {formatPercent(Math.abs(delta), 0)}
        </p>
      )}
    </div>
  )
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}
