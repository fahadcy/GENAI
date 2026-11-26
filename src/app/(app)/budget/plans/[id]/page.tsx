import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { db } from '@/lib/db'
import { adCampaigns, approvalChains, approvalRequests, auditEvents } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { auditLabel } from '@/lib/workflow/audit-labels'
import { latestAllocation, loadPlan, planProblems } from '@/lib/budget/service'
import { CATEGORY_LABEL, CHANNELS } from '@/lib/budget/channels'
import { money, pct } from '@/lib/budget/money'
import { PLAN_STATUS } from '@/lib/budget/view'
import type { LineCategory } from '@/lib/budget/types'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { PlanGovernance, PlanLines, PlanSettings } from '@/components/budget/plan-editor'

export const metadata: Metadata = { title: 'Budget plan' }

/**
 * One plan: its lines, settings, approval and history. A reviewer arriving
 * from the approvals queue decides here, with the amounts — and for a
 * revision, what each line was before — in front of them.
 */
export default async function BudgetPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params
  const plan = await loadPlan(auth.workspace.id, id)
  if (!plan) notFound()

  const [notifications, parent, approvalRow, approved, campaigns, history, allocation] = await Promise.all([
    listNotifications(auth.workspace.id, auth.user.id),
    plan.parentPlanId ? loadPlan(auth.workspace.id, plan.parentPlanId) : Promise.resolve(null),
    db
      .select({ request: approvalRequests, chain: approvalChains })
      .from(approvalRequests)
      .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
      .where(and(eq(approvalRequests.workspaceId, auth.workspace.id), eq(approvalRequests.subjectType, 'budget_plan'), eq(approvalRequests.subjectId, id), eq(approvalRequests.status, 'pending')))
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({ v: approvalRequests.subjectVersion })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, auth.workspace.id), eq(approvalRequests.subjectType, 'budget_plan'), eq(approvalRequests.subjectId, id), eq(approvalRequests.status, 'approved')))
      .orderBy(desc(approvalRequests.completedAt))
      .limit(1)
      .then((r) => r[0]?.v ?? null),
    db
      .select({ id: adCampaigns.id, name: adCampaigns.name, status: adCampaigns.status })
      .from(adCampaigns)
      .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), inArray(adCampaigns.status, ['draft', 'in_review', 'approved', 'changes_requested', 'live', 'paused'])))
      .orderBy(adCampaigns.name),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspace.id), or(eq(auditEvents.subjectId, id), plan.parentPlanId ? eq(auditEvents.subjectId, plan.parentPlanId) : eq(auditEvents.subjectId, id))))
      .orderBy(desc(auditEvents.seq))
      .limit(25),
    latestAllocation(auth.workspace.id, id),
  ])

  const step = approvalRow?.chain.steps[approvalRow.request.currentStep] ?? null
  const editable = can(auth.role, 'budget:plan') && ['draft', 'changes_requested', 'in_review', 'approved'].includes(plan.status)
  const status = PLAN_STATUS[plan.status] ?? PLAN_STATUS.draft
  const problems = planProblems(plan)
  const parentByKey = new Map(parent?.lines.map((l) => [l.channelKey, l.plannedPence]) ?? [])
  const moved = parent ? plan.lines.reduce((a, l) => a + Math.abs(l.plannedPence - (parentByKey.get(l.channelKey) ?? 0)), 0) / 2 : 0

  return (
    <>
      <Topbar user={auth.user} role={auth.role} title="Budget plan" description="Lines, limits and approval" notifications={notifications} />
      <PageBody>
        <Link href="/budget" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Budget Allocator
        </Link>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">{plan.name}</h1>
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
          <Badge>v{plan.version}</Badge>
          <span className="tnum text-[13px] text-ink-muted">
            {money(plan.totalPence)} · {String(plan.periodStart)} to {String(plan.periodEnd)}
          </span>
        </div>
        {parent && (
          <p className="mb-5 rounded-md bg-info-bg px-3 py-2 text-[13px] text-ink-muted ring-1 ring-info-fg/20">
            A revision of{' '}
            <Link href={`/budget/plans/${parent.id}`} className="font-medium text-ink underline">
              {parent.name}
            </Link>{' '}
            ({PLAN_STATUS[parent.status]?.label.toLowerCase()}). It moves {money(moved)} between lines ({pct(moved / Math.max(1, parent.totalPence))} of the budget)
            {plan.totalPence !== parent.totalPence ? ` and changes the total from ${money(parent.totalPence)}` : ''}. The “Was” column shows each line before.
          </p>
        )}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-5">
            <PlanLines
              plan={view(plan)}
              editable={editable}
              campaigns={campaigns}
              options={CHANNELS.map((c) => ({ key: c.key, label: c.label, category: c.category, description: c.description }))}
              lines={plan.lines.map((l) => ({
                id: l.id,
                channelKey: l.channelKey,
                label: l.label,
                category: l.category,
                categoryLabel: CATEGORY_LABEL[l.category as LineCategory] ?? l.category,
                plannedPence: l.plannedPence,
                minPence: l.minPence,
                maxPence: l.maxPence,
                locked: l.locked,
                allowExtrapolation: l.allowExtrapolation,
                incrementality: l.incrementality,
                incrementalitySource: l.incrementalitySource,
                adCampaignIds: l.adCampaignIds,
                notes: l.notes,
                parentPence: parent ? (parentByKey.get(l.channelKey) ?? null) : null,
              }))}
            />
            {allocation && (
              <Card className="p-5">
                <div className="label">Latest allocator run</div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink">{allocation.result.summary}</p>
                <p className="mt-1 text-2xs text-ink-faint">
                  v{allocation.planVersion} · sha256 <span className="font-mono">{allocation.resultHash.slice(0, 12)}</span>
                  {allocation.planVersion !== plan.version && ' · the plan has changed since'} ·{' '}
                  <Link href="/budget?tab=allocate" className="underline">
                    details
                  </Link>
                </p>
              </Card>
            )}
            <PlanSettings plan={view(plan)} editable={editable} />
          </div>
          <div className="space-y-5">
            <PlanGovernance
              plan={view(plan)}
              problems={problems}
              canPlan={can(auth.role, 'budget:plan')}
              canActivate={can(auth.role, 'budget:activate')}
              approvedVersion={approved}
              decision={
                approvalRow
                  ? {
                      requestId: approvalRow.request.id,
                      chainName: approvalRow.chain.name,
                      stepName: step?.name ?? 'Review',
                      stepIndex: approvalRow.request.currentStep,
                      totalSteps: approvalRow.chain.steps.length,
                      stepRole: step?.role ?? 'reviewer',
                      eligible: auth.role === 'owner' || (step?.approverIds?.length ? step.approverIds.includes(auth.user.id) : step?.role === auth.role),
                      canDecide: can(auth.role, 'approval:decide'),
                    }
                  : null
              }
            />
            <Card>
              <CardHeader title="History" description="From the hash-chained audit trail." />
              <ul className="divide-y divide-line">
                {history.length === 0 && <li className="px-5 py-3 text-[13px] text-ink-faint">Nothing yet.</li>}
                {history.map((h) => (
                  <li key={h.id} className="px-5 py-2.5">
                    <div className="text-xs font-medium text-ink">{auditLabel(h.action)}</div>
                    <div className="text-xs leading-snug text-ink-muted">{h.summary}</div>
                    <div className="text-2xs text-ink-faint">
                      <RelativeTime date={h.createdAt} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}

function view(plan: NonNullable<Awaited<ReturnType<typeof loadPlan>>>) {
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    version: plan.version,
    totalPence: plan.totalPence,
    periodStart: String(plan.periodStart),
    periodEnd: String(plan.periodEnd),
    objective: plan.objective as 'conversions' | 'revenue' | 'profit',
    riskAversion: plan.riskAversion,
    learningShare: plan.learningShare,
    maxShift: plan.maxShift,
    valuePerConversionPence: plan.valuePerConversionPence,
    cardLimitPence: plan.cardLimitPence,
    notes: plan.notes,
    parentPlanId: plan.parentPlanId,
  }
}
