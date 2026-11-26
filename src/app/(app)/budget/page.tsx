import type { Metadata } from 'next'
import Link from 'next/link'
import { and, eq, sql } from 'drizzle-orm'
import { AlertTriangle, CreditCard, Gauge, PiggyBank, Wallet } from 'lucide-react'
import { db } from '@/lib/db'
import { budgetObservations } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import {
  cardProviderLabel,
  currentPlan,
  discrepanciesFor,
  latestAllocation,
  latestReconciliation,
  linkedControls,
  listCards,
  pacingFor,
  planProblems,
  revisionsOf,
  transactionsFor,
} from '@/lib/budget/service'
import { trueLayerConfigured } from '@/lib/budget/cards/truelayer'
import { CATEGORY_LABEL, CHANNELS } from '@/lib/budget/channels'
import { money, pct } from '@/lib/budget/money'
import { PLAN_STATUS } from '@/lib/budget/view'
import type { LineCategory } from '@/lib/budget/types'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader, EmptyState, LinkButton, StatTile } from '@/components/ui/primitives'
import { NewPlanButton, NewPlanForm } from '@/components/budget/new-plan'
import { BudgetTabs } from '@/components/budget/tabs'
import { AllocatorPanel } from '@/components/budget/allocator'
import { PacingPanel } from '@/components/budget/pacing'
import { ReconcilePanel } from '@/components/budget/reconcile'
import { CardsPanel } from '@/components/budget/cards'

export const metadata: Metadata = { title: 'Budget Allocator' }

/**
 * The Budget Allocator. One plan at a time on screen — the live one, else the
 * newest open one — with four views over it: the allocator's recommendation,
 * pacing and the cash forecast, the three-way reconciliation, and the cards
 * and transactions behind it.
 */
export default async function BudgetPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const sp = await searchParams
  const canPlan = can(auth.role, 'budget:plan')
  const canActivate = can(auth.role, 'budget:activate')
  const canCards = can(auth.role, 'budget:cards')

  const [notifications, plan, cards, historyCount] = await Promise.all([
    listNotifications(wsId, auth.user.id),
    currentPlan(wsId),
    listCards(wsId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(budgetObservations)
      .where(and(eq(budgetObservations.workspaceId, wsId)))
      .then((r) => r[0]?.n ?? 0),
  ])
  const hasHistory = historyCount > 0

  const topbar = (
    <Topbar
      user={auth.user}
      role={auth.role}
      title="Budget Allocator"
      description="Every pound of the marketing budget — planned, allocated on evidence, paced, and matched to what actually left the card"
      notifications={notifications}
      actions={plan && canPlan ? <NewPlanButton hasHistory={hasHistory} /> : undefined}
    />
  )

  if (!plan) {
    return (
      <>
        {topbar}
        <PageBody width="narrow">
          <div className="space-y-4">
            <Card className="p-5">
              <h1 className="text-lg font-semibold text-ink">Plan the whole budget, then prove where it went</h1>
              <ul className="mt-3 grid gap-3 text-[13px] leading-relaxed text-ink-muted sm:grid-cols-3">
                <li>
                  <strong className="block text-ink">Allocate on evidence</strong>
                  Response curves per channel, refitted many times so every recommendation carries its uncertainty — and never spends past
                  what your history supports.
                </li>
                <li>
                  <strong className="block text-ink">Pace to plan</strong>
                  Each platform’s own overspend rules, and a forecast of when threshold billing will actually hit the card.
                </li>
                <li>
                  <strong className="block text-ink">Match to the card</strong>
                  Plan, platform and card reconciled line by line: duplicates, VAT, FX, unbudgeted spend and failed payments, found and explained.
                </li>
              </ul>
            </Card>
            {canPlan ? (
              <Card>
                <CardHeader icon={<PiggyBank className="h-4 w-4" />} title="Create your first plan" description="You can change every line afterwards. Nothing goes live until it is approved." />
                <div className="p-5">
                  <NewPlanForm hasHistory={hasHistory} />
                </div>
              </Card>
            ) : (
              <Card>
                <EmptyState icon={<Wallet className="h-5 w-5" />} title="No budget plan yet" description="Owners, marketing ops and growth marketers can create one. Once they have, you can read everything here." />
              </Card>
            )}
          </div>
        </PageBody>
      </>
    )
  }

  const from = String(plan.periodStart)
  const to = String(plan.periodEnd)
  const [allocation, recon, discrepancies, txs, revisions] = await Promise.all([
    latestAllocation(wsId, plan.id),
    latestReconciliation(wsId, plan.id),
    discrepanciesFor(wsId, plan.id),
    transactionsFor(wsId, from, to, 400),
    revisionsOf(wsId, plan.id),
  ])
  const pacing = await pacingFor(wsId, plan)
  const controls = await linkedControls(wsId, plan)

  const status = PLAN_STATUS[plan.status] ?? PLAN_STATUS.draft
  const problems = planProblems(plan)
  const paidLines = pacing.lines.filter((l) => l.source !== 'none')
  const spent = pacing.lines.reduce((a, l) => a + l.actualPence, 0)
  const projected = pacing.lines.reduce((a, l) => a + Math.max(l.projectedPence, l.source === 'none' ? l.plannedPence : 0), 0)
  const open = discrepancies.filter((d) => d.status === 'open' && d.present)
  const openHigh = open.filter((d) => d.severity === 'high')
  const openAmount = open.reduce((a, d) => a + d.amountPence, 0)
  const simulated = Boolean(allocation?.simulated || recon?.report.simulated || cards.some((c) => c.simulated))
  const byCategory = new Map<string, number>()
  for (const l of plan.lines) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + l.plannedPence)
  const openRevision = revisions.find((r) => ['draft', 'in_review', 'changes_requested', 'approved'].includes(r.status))

  const channels = CHANNELS.map((c) => ({ key: c.key, label: plan.lines.find((l) => l.channelKey === c.key)?.label ?? c.label }))
  const connectMessage = sp.message ? { tone: sp.connect === 'ok' ? ('ok' as const) : ('error' as const), text: sp.message.slice(0, 300) } : null

  return (
    <>
      {topbar}
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold text-ink">{plan.name}</h1>
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
                <Badge>v{plan.version}</Badge>
                {simulated && (
                  <Badge tone="warn" dot>
                    Includes simulated data
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">
                {new Date(`${from}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} –{' '}
                {new Date(`${to}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} ·{' '}
                {plan.lines.length} lines · optimising for {plan.objective}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {openRevision && (
                <LinkButton href={`/budget/plans/${openRevision.id}`} size="sm" variant="secondary">
                  Revision: {PLAN_STATUS[openRevision.status]?.label.toLowerCase()}
                </LinkButton>
              )}
              <LinkButton href={`/budget/plans/${plan.id}`} size="sm" variant={plan.status === 'active' ? 'secondary' : 'primary'}>
                {plan.status === 'active' ? 'Plan details' : plan.status === 'approved' ? 'Review and make live' : 'Edit lines and submit'}
              </LinkButton>
            </div>
          </div>

          {simulated && (
            <p className="rounded-md bg-warn-bg px-3 py-2 text-[13px] text-ink-muted ring-1 ring-warn-fg/20">
              Some history, platform spend or card charges here are simulated — fictional figures built so the allocator and reconciliation can be
              tried before anything is connected. They are labelled wherever they appear, and real data replaces them channel by channel.
            </p>
          )}
          {problems.length > 0 && plan.status !== 'active' && (
            <p className="flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-fg ring-1 ring-danger-fg/20">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {problems[0]}{' '}
                <Link href={`/budget/plans/${plan.id}`} className="font-medium underline">
                  Fix it
                </Link>
              </span>
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Budget" value={money(plan.totalPence)} hint={`${[...byCategory.keys()].length} kinds of cost`} icon={<Wallet className="h-4 w-4" />} />
            <StatTile
              label="Spent so far"
              value={money(spent)}
              hint={paidLines.length ? `projected ${money(projected)} (${projected > plan.totalPence ? '+' : ''}${pct(projected / plan.totalPence - 1)})` : 'no spend data yet'}
              icon={<Gauge className="h-4 w-4" />}
            />
            <StatTile
              label="Open discrepancies"
              value={open.length}
              hint={open.length ? `${openHigh.length} high · ${money(openAmount)} involved` : recon ? 'plan, platforms and card agree' : 'not reconciled yet'}
              icon={<AlertTriangle className="h-4 w-4" />}
              href="/budget?tab=reconcile"
            />
            <StatTile
              label="Card headroom"
              value={pacing.cash?.headroomPence != null ? money(pacing.cash.headroomPence) : '—'}
              hint={pacing.cash ? (pacing.cash.limitHitOn ? `limit runs out ${pacing.cash.limitHitOn}` : `+${money(pacing.cash.forecastPence)} forecast`) : 'connect a card'}
              icon={<CreditCard className="h-4 w-4" />}
              href="/budget?tab=cards"
            />
          </div>

          <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
            {[...byCategory.entries()].map(([k, v]) => (
              <span key={k} className="rounded-md bg-bg-inset px-2 py-1">
                {CATEGORY_LABEL[k as LineCategory] ?? k} <span className="tnum font-medium text-ink">{money(v)}</span>
              </span>
            ))}
          </div>

          <BudgetTabs
            initial={sp.tab ?? (plan.status === 'active' ? 'pacing' : 'allocate')}
            tabs={[
              {
                value: 'allocate',
                label: 'Allocator',
                panel: (
                  <AllocatorPanel
                    planId={plan.id}
                    planVersion={plan.version}
                    planStatus={plan.status}
                    canPlan={canPlan}
                    hasHistory={hasHistory}
                    allocation={
                      allocation
                        ? {
                            id: allocation.id,
                            createdAt: allocation.createdAt.toISOString(),
                            planVersion: allocation.planVersion,
                            result: allocation.result,
                            curves: allocation.curves,
                            settings: allocation.settings,
                            simulated: allocation.simulated,
                            appliedPlanId: allocation.appliedPlanId,
                            hash: allocation.resultHash,
                          }
                        : null
                    }
                  />
                ),
              },
              {
                value: 'pacing',
                label: 'Pacing',
                count: pacing.lines.filter((l) => l.status === 'over' || l.status === 'at_risk').length || undefined,
                panel: (
                  <PacingPanel
                    rows={pacing.lines}
                    cash={pacing.cash}
                    controls={controls}
                    planId={plan.id}
                    planStatus={plan.status}
                    canActivate={canActivate}
                    canCards={canCards}
                    today={pacing.today}
                    periodStart={from}
                    periodEnd={to}
                  />
                ),
              },
              {
                value: 'reconcile',
                label: 'Reconciliation',
                count: open.length || undefined,
                panel: (
                  <ReconcilePanel
                    planId={plan.id}
                    report={recon?.report ?? null}
                    reportHash={recon?.reportHash ?? null}
                    createdAt={recon?.createdAt.toISOString() ?? null}
                    canPlan={canPlan}
                    canResolve={canCards}
                    hasCards={cards.length > 0}
                    discrepancies={discrepancies.map((d) => ({
                      id: d.id,
                      kind: d.kind as never,
                      severity: d.severity as never,
                      amountPence: d.amountPence,
                      title: d.title,
                      detail: d.detail,
                      suggestion: d.suggestion,
                      status: d.status,
                      present: d.present,
                      note: d.note,
                      firstSeenAt: d.firstSeenAt.toISOString(),
                    }))}
                  />
                ),
              },
              {
                value: 'cards',
                label: 'Cards',
                count: cards.length || undefined,
                panel: (
                  <CardsPanel
                    canCards={canCards}
                    canPlan={canPlan}
                    trueLayerReady={trueLayerConfigured()}
                    connectMessage={connectMessage}
                    channels={channels}
                    cards={cards.map((c) => ({
                      id: c.id,
                      provider: c.provider,
                      providerLabel: cardProviderLabel(c.provider),
                      label: c.label,
                      last4: c.last4,
                      currency: c.currency,
                      monthlyLimitPence: c.monthlyLimitPence,
                      channelKey: c.channelKey,
                      status: c.status,
                      simulated: c.simulated,
                      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
                      lastError: c.lastError,
                      consentExpiresAt: c.consentExpiresAt?.toISOString() ?? null,
                    }))}
                    txs={txs.map(({ tx, cardLabel }) => ({
                      id: tx.id,
                      postedAt: tx.postedAt.toISOString(),
                      amountPence: tx.amountPence,
                      currency: tx.currency,
                      originalAmountMinor: tx.originalAmountMinor,
                      originalCurrency: tx.originalCurrency,
                      descriptor: tx.descriptor,
                      status: tx.status,
                      channelKey: tx.channelKey,
                      classifiedVia: tx.classifiedVia,
                      ignored: tx.ignored,
                      simulated: tx.simulated,
                      cardLabel,
                    }))}
                  />
                ),
              },
            ]}
          />
        </div>
      </PageBody>
    </>
  )
}
