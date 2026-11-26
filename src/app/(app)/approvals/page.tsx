import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle2, Clock, ShieldCheck, Timer, TrendingDown } from 'lucide-react'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { requireAuth } from '@/lib/auth/session'
import { can, ROLE_LABEL } from '@/lib/auth/rbac'
import { db } from '@/lib/db'
import { approvalRequests, assets, users } from '@/lib/db/schema'
import { averageApprovalMs, pendingQueue } from '@/lib/workflow/approvals'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, RequirementNote, SectionHeading } from '@/components/shell/page'
import { Avatar, Badge, Card, CardHeader, EmptyState, LinkButton, ScoreRing, StatTile } from '@/components/ui/primitives'
import {
  ChannelChip,
  RelativeTime,
  formatDurationMs,
  formatMoney,
  formatPercent,
} from '@/components/domain'

export const metadata: Metadata = { title: 'Approvals' }

export default async function ApprovalsPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const [queue, avgMs, stats, recent, notifications] = await Promise.all([
    pendingQueue(wsId, { id: auth.user.id, role: auth.role }),
    averageApprovalMs(wsId),
    approvalStats(wsId),
    recentDecisions(wsId),
    listNotifications(wsId, auth.user.id),
  ])

  const mine = queue.filter((q) => q.mine)
  const others = queue.filter((q) => !q.mine)
  const overdue = queue.filter((q) => q.overdue).length
  const canDecide = can(auth.role, 'approval:decide')

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Approvals"
        description="Nothing publishes without passing its gate, and every decision is on the record"
        notifications={notifications}
        actions={
          <LinkButton href="/settings/audit" size="sm" variant="ghost">
            Audit trail
          </LinkButton>
        }
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Waiting"
            value={queue.length}
            delta={overdue > 0 ? { value: `${overdue} overdue`, direction: 'up', good: false } : undefined}
            hint={overdue === 0 ? 'All within SLA' : undefined}
            icon={<Clock className="h-4 w-4" />}
          />
          <StatTile
            label="Assigned to you"
            value={mine.length}
            hint={canDecide ? ROLE_LABEL[auth.role] : 'Your role cannot decide'}
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <StatTile
            label="Average resolution"
            value={formatDurationMs(avgMs)}
            hint="Last 30 days, request to final decision"
            icon={<Timer className="h-4 w-4" />}
          />
          <StatTile
            label="First-pass approval"
            value={stats.total > 0 ? formatPercent(stats.approved / stats.total, 0) : '—'}
            hint={`${stats.rejected} sent back for changes`}
            icon={<TrendingDown className="h-4 w-4" />}
          />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <div>
              <SectionHeading
                title={mine.length > 0 ? `${mine.length} waiting on you` : 'Nothing is waiting on you'}
                description={
                  canDecide
                    ? 'You are an eligible approver at the current step of each of these.'
                    : `Your role (${ROLE_LABEL[auth.role]}) does not decide approvals — this queue is read-only for you.`
                }
              />
              {mine.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<CheckCircle2 className="h-5 w-5" />}
                    title="Your queue is clear"
                    description={
                      others.length > 0
                        ? `${others.length} item${others.length === 1 ? ' is' : 's are'} with other reviewers below.`
                        : 'Nothing anywhere in the workspace is waiting for a decision.'
                    }
                  />
                </Card>
              ) : (
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">
                    {mine.map((q) => (
                      <QueueRow key={q.request.id} item={q} highlight />
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            {others.length > 0 && (
              <div>
                <SectionHeading
                  title="With other reviewers"
                  description="Visible to everyone, so a bottleneck is never invisible."
                />
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">
                    {others.map((q) => (
                      <QueueRow key={q.request.id} item={q} />
                    ))}
                  </ul>
                </Card>
              </div>
            )}
          </div>

          <div className="space-y-4 xl:sticky xl:top-[76px] xl:self-start">
            <Card>
              <CardHeader
                title="Recent decisions"
                description="The last 12 outcomes across the workspace."
              />
              {recent.length === 0 ? (
                <EmptyState title="No decisions yet" description="Completed approvals appear here." />
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((r) => (
                    <li key={r.id} className="flex items-start gap-2.5 px-5 py-2.5">
                      {r.approverName ? (
                        <Avatar name={r.approverName} hue={r.approverHue ?? 250} size={22} />
                      ) : (
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-ink-faint" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-ink">{r.title}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {r.status === 'approved' ? 'Approved' : 'Changes requested'} in{' '}
                          {formatDurationMs(r.resolutionMs)} ·{' '}
                          <RelativeTime date={r.completedAt} />
                        </p>
                      </div>
                      <Badge tone={r.status === 'approved' ? 'ok' : 'danger'}>
                        {r.status === 'approved' ? 'Approved' : 'Returned'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title="How the gate works"
                description="The rules the engine enforces, not a description of them."
              />
              <ul className="space-y-2.5 p-5 text-[13px] leading-relaxed text-ink-muted">
                <li>
                  A high-severity guardrail finding blocks submission outright — a reviewer never sees
                  work that breaks a legal rule.
                </li>
                <li>
                  Rejection requires a comment. There is no silent no.
                </li>
                <li>
                  Approval is bound to a version. Edit an approved asset and the approval is void until
                  it is reviewed again.
                </li>
                <li>
                  The publisher re-checks the gate at send time, not only at schedule time.
                </li>
                <li>
                  Every state change is appended to a hash-chained trail that can be verified and
                  exported.
                </li>
              </ul>
              <div className="border-t border-line px-5 py-3">
                <LinkButton href="/settings/approvals" size="xs" variant="ghost">
                  Configure chains
                </LinkButton>
              </div>
            </Card>
          </div>
        </div>

        <RequirementNote>
          AP-1 configurable chains by channel and spend · AP-2 one-click decisions with required
          rejection comments · AP-3 immutable, exportable audit trail · AP-4 SLA tracking and reminders
          · AP-5 delegation so absence does not block a launch
        </RequirementNote>
      </PageBody>
    </>
  )
}

function QueueRow({
  item,
  highlight,
}: {
  item: Awaited<ReturnType<typeof pendingQueue>>[number]
  highlight?: boolean
}) {
  const totalSteps = item.chain.steps.length
  const paid = item.adCampaign
  const search = item.searchAction
  const summary = search
    ? `PPC & SEO · ${search.recommendation.summary}`
    : paid
    ? `${paid.structure?.adGroups.length ?? 0} ad groups · ${
        paid.structure?.adGroups.reduce((n, g) => n + g.keywords.length, 0) ?? 0
      } keywords · ${formatMoney(item.display.monthlySpend, paid.currencyCode)} a month at most`
    : (item.asset?.body.subject ?? item.asset?.body.headline ?? item.asset?.body.body ?? '')

  return (
    <li>
      <Link
        href={`/approvals/${item.request.id}`}
        className="flex items-start gap-3.5 px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <div className="pt-0.5">
          {search ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-info/40 bg-info/10 text-[10px] font-semibold leading-none text-info">
              SEO
            </div>
          ) : paid ? (
            /* A campaign has no guardrail score of its own; the money is the
               number a reviewer actually needs to see before approving. */
            <div className="flex h-9 w-9 flex-col items-center justify-center rounded-full border border-warn/40 bg-warn/10 text-[10px] font-semibold leading-none text-warn">
              <span>{Math.round(paid.dailyBudgetMicros / 1_000_000)}</span>
              <span className="mt-0.5 text-[8px] font-normal opacity-80">/day</span>
            </div>
          ) : (
            <ScoreRing score={item.asset?.compositeScore ?? 0} size={36} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-ink">{item.display.title}</span>
            {paid && <Badge tone="warn">Paid — spends money</Badge>}
            {search && <Badge tone="info">PPC &amp; SEO</Badge>}
            {highlight && <Badge tone="brand">Yours</Badge>}
          </div>
          <p className="mt-1 line-clamp-1 text-[13px] text-ink-muted">{summary}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-faint">
            <span>
              {item.chain.name} · step {item.request.currentStep + 1} of {totalSteps} (
              {item.step?.name ?? 'review'})
            </span>
            {item.requester?.name && (
              <span className="flex items-center gap-1">
                · from
                <Avatar name={item.requester.name} hue={item.requester.avatarHue ?? 250} size={14} />
                {item.requester.name}
              </span>
            )}
            <span>
              · submitted <RelativeTime date={item.request.requestedAt} />
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {item.overdue ? (
            <Badge tone="danger" dot>
              Overdue
            </Badge>
          ) : (
            <span className="text-xs text-ink-faint">
              due <RelativeTime date={item.request.dueAt} />
            </span>
          )}
          {item.display.channel && <ChannelChip channel={item.display.channel} size="sm" />}
        </div>
      </Link>
    </li>
  )
}

/* ------------------------------------------------------------- queries */

async function approvalStats(workspaceId: string) {
  const [row] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${approvalRequests.status} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${approvalRequests.status} = 'rejected')::int`,
      total: sql<number>`count(*) filter (where ${approvalRequests.status} in ('approved','rejected'))::int`,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.workspaceId, workspaceId))
  return row ?? { approved: 0, rejected: 0, total: 0 }
}

async function recentDecisions(workspaceId: string) {
  return db
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      resolutionMs: approvalRequests.resolutionMs,
      completedAt: approvalRequests.completedAt,
      title: assets.title,
      approverName: users.name,
      approverHue: users.avatarHue,
    })
    .from(approvalRequests)
    .innerJoin(assets, eq(assets.id, approvalRequests.subjectId))
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        inArray(approvalRequests.status, ['approved', 'rejected']),
      ),
    )
    .orderBy(desc(approvalRequests.completedAt))
    .limit(12)
}
