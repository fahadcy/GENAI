import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Palette,
  Plug,
  ScrollText,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Badge, Card, StatTile } from '@/components/ui/primitives'
import { RelativeTime, formatPercent } from '@/components/domain'
import { WorkspaceGeneralForm } from '@/components/settings/general'
import { tierFor } from '@/components/settings/plans'
import { governanceSummary } from './queries'

export const metadata: Metadata = { title: 'Workspace settings' }

export default async function SettingsOverviewPage() {
  const auth = await requireAuth()
  const summary = await governanceSummary(auth.workspace.id)
  const ws = auth.workspace
  const canEdit = auth.role === 'owner' || auth.role === 'admin'
  const tier = tierFor(ws.plan)

  const passRate = summary.assetsScored > 0 ? summary.assetsPassed / summary.assetsScored : null

  return (
    <PageBody className="max-w-[1180px]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Governance rules in force"
          value={summary.legalRulesActive + summary.bannedTerms + summary.disclaimers}
          hint={`${summary.legalRulesActive} legal · ${summary.bannedTerms} banned · ${summary.disclaimers} disclaimer${summary.disclaimers === 1 ? '' : 's'}`}
          href="/settings/brand"
          icon={<Palette className="h-4 w-4" />}
        />
        <StatTile
          label="Approval steps configured"
          value={summary.chainSteps}
          hint={`across ${summary.activeChains} active chain${summary.activeChains === 1 ? '' : 's'}`}
          href="/settings/approvals"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <StatTile
          label="People with access"
          value={summary.members}
          delta={
            summary.pendingInvites > 0
              ? { value: `${summary.pendingInvites} invited`, direction: 'up' }
              : undefined
          }
          hint={summary.pendingInvites === 0 ? `${ws.seats} seats on the plan` : undefined}
          href="/settings/members"
          icon={<Users className="h-4 w-4" />}
        />
        <StatTile
          label="Audit events recorded"
          value={summary.auditEvents.toLocaleString('en-GB')}
          hint={
            summary.firstEventAt
              ? `unbroken since ${summary.firstEventAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : 'nothing recorded yet'
          }
          href="/settings/audit"
          icon={<ScrollText className="h-4 w-4" />}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <WorkspaceGeneralForm
            canEdit={canEdit}
            slug={ws.slug}
            createdAt={ws.createdAt.toISOString()}
            initial={{
              name: ws.name,
              defaultTimezone: ws.settings.defaultTimezone,
              currency: (ws.settings.currency as 'GBP' | 'EUR' | 'USD') ?? 'GBP',
              weekStartsOn: ws.settings.weekStartsOn ?? 1,
              dataResidency: (ws.dataResidency as 'eu' | 'uk' | 'us') ?? 'eu',
              requireApprovalAboveSpend: ws.settings.requireApprovalAboveSpend ?? 0,
            }}
          />
        </div>

        <div className="space-y-4">
          {/* A standing read on whether the guardrails are actually doing work.
              These are counts of live rows, not a configuration checklist. */}
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Is the governance working?</h2>
              <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
                Measured against every asset this workspace has scored.
              </p>
            </div>
            <div className="space-y-4 px-5 py-4">
              {passRate === null ? (
                <p className="text-[13px] text-ink-muted">
                  Nothing has been generated yet, so there is nothing to measure. The first brief will
                  populate this.
                </p>
              ) : (
                <>
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="label">First-pass rate</span>
                      <span className="tnum text-lg font-semibold leading-none text-ink">
                        {formatPercent(passRate, 0)}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-inset">
                      <div
                        className={`h-full rounded-full ${passRate >= 0.95 ? 'bg-ok-fg' : passRate >= 0.8 ? 'bg-warn-fg' : 'bg-danger-fg'}`}
                        style={{ width: `${Math.round(passRate * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                      {summary.assetsPassed} of {summary.assetsScored} scored assets cleared brand and
                      legal without a human edit. The product target is 95%.
                    </p>
                  </div>
                  {passRate < 0.95 && (
                    <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warn-fg">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      Below target. The brand page lists which rules are firing most — usually one
                      over-broad pattern is doing the damage.
                    </p>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Where things stand</h2>
            </div>
            <ul className="divide-y divide-line">
              <StatusRow
                href="/settings/connectors"
                icon={<Plug className="h-4 w-4" />}
                label="Integrations"
                value={`${summary.connectorsConnected} of ${summary.connectorsConfigured} connected`}
                tone={summary.connectorsUnhealthy > 0 ? 'warn' : 'ok'}
                note={
                  summary.connectorsUnhealthy > 0
                    ? `${summary.connectorsUnhealthy} degraded or failing`
                    : 'all healthy'
                }
              />
              <StatusRow
                href="/settings/approvals"
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Approval queue"
                value={`${summary.pendingApprovals} pending`}
                tone={summary.pendingApprovals > 0 ? 'info' : 'ok'}
                note={`${summary.blackouts} blackout window${summary.blackouts === 1 ? '' : 's'} · ${summary.frequencyCaps} frequency cap${summary.frequencyCaps === 1 ? '' : 's'}`}
              />
              <StatusRow
                href="/settings/audit"
                icon={<ScrollText className="h-4 w-4" />}
                label="Last recorded event"
                value={summary.lastEventAt ? <RelativeTime date={summary.lastEventAt} /> : '—'}
                tone="neutral"
                note="hash-chained and verifiable"
              />
              <StatusRow
                href="/settings/billing"
                icon={<CreditCard className="h-4 w-4" />}
                label="Plan"
                value={tier.name}
                tone={ws.plan === 'trial' ? 'warn' : 'brand'}
                note={
                  ws.trialEndsAt
                    ? `trial ends ${ws.trialEndsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                    : `${summary.members} of ${ws.seats} seats used`
                }
              />
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-8">
        <SectionHeading
          title="What lives where"
          description="Settings in Aurea are not preferences — most of them are enforced at generation, submission or publish time."
        />
        <div className="grid gap-3 md:grid-cols-3">
          <ExplainerCard
            href="/settings/brand"
            icon={<Palette className="h-4 w-4" />}
            title="Brand and legal"
            body="Voice, tone targets, banned terms and regex legal rules. Every generated variant is scored against these before a reviewer sees it, and anything with a high-severity finding cannot be submitted at all."
          />
          <ExplainerCard
            href="/settings/approvals"
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Approval chains"
            body="Which reviewers see what, in what order, with an SLA on each step. Scope by channel or by spend; the most specific matching chain wins. Blackout windows and frequency caps stop sends that would otherwise be legal but unwise."
          />
          <ExplainerCard
            href="/settings/audit"
            icon={<CheckCircle2 className="h-4 w-4" />}
            title="The audit trail"
            body="Every change above writes an append-only, hash-chained event. Verify the chain to prove nothing has been edited after the fact, and export the whole trail as CSV for a compliance review."
          />
        </div>
      </div>
    </PageBody>
  )
}

function StatusRow({
  href,
  icon,
  label,
  value,
  note,
  tone,
}: {
  href: string
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  note: string
  tone: 'ok' | 'warn' | 'info' | 'brand' | 'neutral'
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
      >
        <span className="text-ink-faint">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">{label}</span>
          <span className="block truncate text-2xs text-ink-faint">{note}</span>
        </span>
        <Badge tone={tone}>{value}</Badge>
      </Link>
    </li>
  )
}

function ExplainerCard({
  href,
  icon,
  title,
  body,
}: {
  href: string
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <Link href={href} className="card group flex flex-col p-4 transition-colors hover:bg-surface-hover">
      <div className="flex items-center gap-2 text-ink">
        <span className="text-brand-600">{icon}</span>
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        <ArrowRight className="ml-auto h-3.5 w-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </Link>
  )
}
