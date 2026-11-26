import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { db } from '@/lib/db'
import { approvalChains, approvalRequests, auditEvents } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { auditLabel } from '@/lib/workflow/audit-labels'
import { hashReport, loadAction, loadRun } from '@/lib/search/service'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { RelativeTime, formatMoney } from '@/components/domain'
import { SearchActionPanel } from '@/components/search/action-panel'

export const metadata: Metadata = { title: 'Search change' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'warn' | 'danger' | 'brand' | 'ok' }> = {
  draft: { label: 'Not sent', tone: 'neutral' },
  in_review: { label: 'Waiting for approval', tone: 'warn' },
  changes_requested: { label: 'Changes requested', tone: 'danger' },
  approved: { label: 'Approved — not applied', tone: 'brand' },
  applied: { label: 'Applied', tone: 'ok' },
  reverted: { label: 'Reverted', tone: 'neutral' },
}

export default async function SearchActionPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params
  const action = await loadAction(auth.workspace.id, id)
  if (!action) notFound()

  const [run, notifications, approvalRow, history] = await Promise.all([
    loadRun(auth.workspace.id, action.runId),
    listNotifications(auth.workspace.id, auth.user.id),
    db
      .select({ request: approvalRequests, chain: approvalChains })
      .from(approvalRequests)
      .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
      .where(
        and(
          eq(approvalRequests.workspaceId, auth.workspace.id),
          eq(approvalRequests.subjectType, 'search_action'),
          eq(approvalRequests.subjectId, id),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, auth.workspace.id), eq(auditEvents.subjectId, id)))
      .orderBy(desc(auditEvents.seq))
      .limit(20),
  ])

  const rec = action.recommendation
  const step = approvalRow?.chain.steps[approvalRow.request.currentStep] ?? null
  const intact = run ? run.reportHash === hashReport(run.report) : false
  const status = STATUS[action.status] ?? STATUS.draft

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Search change"
        description="One PPC & SEO recommendation, with the evidence it rests on"
        notifications={notifications}
      />
      <PageBody width="wide">
        <Link href="/search" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> PPC &amp; SEO
        </Link>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-5">
            <Card className="p-5">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
                <Badge>{rec.confidence}</Badge>
                {action.simulated && <Badge tone="warn">Simulated data</Badge>}
              </div>
              <h1 className="text-lg font-semibold leading-snug text-ink">{rec.title}</h1>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-muted">{rec.summary}</p>
              <p className="tnum mt-3 text-[13px] text-ink">
                Monthly impact: <strong>{rec.monthlyImpact > 0.5 ? formatMoney(Math.round(rec.monthlyImpact)) : 'none'}</strong>
              </p>
            </Card>

            <Card>
              <CardHeader title="What changes" description="Each change and its exact undo, recorded before anything is applied" />
              <ul className="divide-y divide-line">
                {rec.actions.map((a, i) => (
                  <li key={i} className="space-y-2 px-5 py-3.5 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-ink">{a.description}</span>
                      {a.requiresApproval ? <Badge tone="brand">Needs approval</Badge> : <Badge>No approval needed</Badge>}
                    </div>
                    <details>
                      <summary className="cursor-pointer text-xs text-ink-faint">Payload and undo</summary>
                      <pre className="mt-2 overflow-x-auto rounded-lg bg-bg-inset p-3 text-2xs leading-relaxed text-ink">
                        {JSON.stringify({ payload: a.payload, undo: a.undo }, null, 2)}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Evidence" />
              <dl className="grid gap-x-4 gap-y-2 px-5 py-4 text-[13px] sm:grid-cols-[minmax(160px,max-content)_1fr]">
                {rec.evidence.map((e, i) => (
                  <div key={i} className="contents">
                    <dt className="text-ink-faint">{e.label}</dt>
                    <dd className="tnum min-w-0 break-words text-ink">{e.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="border-t border-line px-5 py-4">
                <p className="label mb-1.5">Assumptions</p>
                <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink-muted">
                  {rec.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <SearchActionPanel
              actionId={action.id}
              status={action.status}
              simulated={action.simulated}
              canApply={can(auth.role, 'search:apply')}
              decision={
                approvalRow
                  ? {
                      requestId: approvalRow.request.id,
                      chainName: approvalRow.chain.name,
                      stepName: step?.name ?? 'Review',
                      stepIndex: approvalRow.request.currentStep,
                      totalSteps: approvalRow.chain.steps.length,
                      stepRole: step?.role ?? 'reviewer',
                      eligible:
                        auth.role === 'owner' ||
                        (step?.approverIds?.length ? step.approverIds.includes(auth.user.id) : step?.role === auth.role),
                      canDecide: can(auth.role, 'approval:decide'),
                    }
                  : null
              }
            />
            <Card>
              <CardHeader title="Provenance" />
              <div className="space-y-1.5 px-5 py-4 text-[13px] text-ink-muted">
                <p>
                  From the analysis run <RelativeTime date={run?.createdAt ?? action.createdAt} />, window{' '}
                  {run?.windowStart ?? '—'} to {run?.windowEnd ?? '—'}.
                </p>
                <p className="font-mono text-2xs break-all">report sha256 {run?.reportHash ?? 'missing'}</p>
                <p className={intact ? 'text-ok-fg' : 'text-danger-fg'}>
                  {intact ? 'The stored report still matches its hash.' : 'The stored report does not match its hash.'}
                </p>
              </div>
            </Card>
            <Card>
              <CardHeader title="History" />
              <ul className="divide-y divide-line">
                {history.length === 0 && <li className="px-5 py-3 text-[13px] text-ink-faint">Nothing yet.</li>}
                {history.map((h) => (
                  <li key={h.id} className="px-5 py-2.5 text-[13px]">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium text-ink">{auditLabel(h.action)}</span>
                      <RelativeTime date={h.createdAt} className="text-xs text-ink-faint" />
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">{h.summary}</p>
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
