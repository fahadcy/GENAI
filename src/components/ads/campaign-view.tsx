'use client'

import * as React from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  ExternalLink,
  Globe,
  Info,
  Languages,
  MapPin,
  Sparkles,
  Target,
  Wallet,
} from 'lucide-react'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { Disclosure } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'
import { budgetExplanation, objectiveDef, LANGUAGE_PRESETS } from '@/lib/ads/objectives'
import { DecisionPanel } from './decision'
import { PlanView } from '@/components/ads/plan'
import { LaunchPanel, type LaunchApproval } from '@/components/ads/launch'
import { PushHistory, type PushLogEntry } from '@/components/ads/history'
import type { AdIssue, ValidationReport } from '@/lib/ads/validate'
import type { AdCampaignStatus, AdCampaignStructure, AdObjective } from '@/lib/db/schema'

export type CampaignSummary = {
  id: string
  name: string
  status: AdCampaignStatus
  objective: AdObjective
  dailyBudget: number
  currencyCode: string
  finalUrl: string | null
  conversionAction: string | null
  geoTargets: { criterionId: string; name: string }[]
  languages: string[]
  briefText: string | null
  structure: AdCampaignStructure | null
  externalCampaignId: string | null
  lastError: string | null
}

export type AccountSummary = {
  name: string
  customerId: string
  connected: boolean
  testAccount: boolean
} | null

type Props = {
  campaign: CampaignSummary
  account: AccountSummary
  report: ValidationReport
  history: PushLogEntry[]
  blockReason: string | null
  approval: LaunchApproval
  /** Present whenever an approval is open, so the decision can be made here. */
  decision: {
    requestId: string
    chainName: string
    stepName: string
    stepIndex: number
    totalSteps: number
    stepRole: string
    eligible: boolean
    canDecide: boolean
  } | null
  permissions: { create: boolean; push: boolean; golive: boolean }
}

/**
 * The review-and-launch screen.
 *
 * The money column comes first in the markup, so on a phone the cost is read
 * before the copy, and it sticks on a wide screen so the figure stays on screen
 * while the plan is scrolled. Nobody should be able to reach a decision here
 * without the numbers having been in front of them the whole time.
 */
export function CampaignView({
  campaign,
  account,
  report,
  history,
  blockReason,
  approval,
  decision,
  permissions,
}: Props) {
  const objective = objectiveDef(campaign.objective)
  const money = budgetExplanation(campaign.dailyBudget, campaign.currencyCode)
  const spending = campaign.status === 'live'

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* ------------------------------------------------------- money rail */}
      <aside className="w-full min-w-0 space-y-4 lg:sticky lg:top-[76px] lg:order-2 lg:w-[380px] lg:shrink-0">
        <Card>
          <CardHeader
            title={spending ? 'What this is costing' : 'What this can cost'}
            description="Read this before anything else."
            icon={<Wallet className="h-4 w-4" />}
          />
          <div className="space-y-3.5 p-5">
            <div>
              <p className="tnum text-3xl font-semibold leading-none tracking-tight text-ink">
                {formatMoney(campaign.dailyBudget, campaign.currencyCode)}
              </p>
              <p className="mt-1.5 text-[13px] text-ink-muted">
                a day on average, in {campaign.currencyCode}
              </p>
            </div>

            {/* Verbatim from the objectives module: both ceilings, in Google's
                own published terms, wherever a budget appears. */}
            <div className="rounded-xl border border-warn-fg/25 bg-warn-bg p-3.5">
              <p className="text-[13px] font-semibold text-warn-fg">
                A daily budget is not a daily cap
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink">{money.sentence}</p>
            </div>

            <dl className="grid grid-cols-2 gap-3">
              <Tile
                label="Busy day, up to"
                value={formatMoney(money.dailyMax, campaign.currencyCode)}
              />
              <Tile
                label="A month, up to"
                value={formatMoney(money.monthlyMax, campaign.currencyCode)}
              />
            </dl>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="How the money will be spent"
            description="Every line here decides who sees the ads and what happens next."
            icon={<Target className="h-4 w-4" />}
          />
          <div className="divide-y divide-line">
            <Row icon={<Target className="h-3.5 w-3.5" />} label="What it is trying to do">
              <p className="text-[13.5px] text-ink">{objective.label}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{objective.summary}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
                {objective.biddingReason}
              </p>
            </Row>

            <Row icon={<MapPin className="h-3.5 w-3.5" />} label="Where the ads can show">
              <p className="break-words text-[13.5px] text-ink">
                {campaign.geoTargets.length > 0
                  ? listOf(campaign.geoTargets.map((g) => g.name))
                  : 'Nowhere chosen, which means everywhere'}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                People outside these places will not see the ads and cannot cost you anything.
              </p>
            </Row>

            <Row icon={<Languages className="h-3.5 w-3.5" />} label="In what language">
              <p className="text-[13.5px] text-ink">{languageNames(campaign.languages)}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                Google matches this against the language someone browses in, not the words they
                typed.
              </p>
            </Row>

            <Row icon={<Globe className="h-3.5 w-3.5" />} label="Where a click lands">
              {campaign.finalUrl ? (
                <a
                  href={campaign.finalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex max-w-full items-start gap-1.5 break-all text-[13.5px] text-brand-600 hover:underline"
                >
                  {campaign.finalUrl}
                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <p className="text-[13.5px] text-ink">No page set</p>
              )}
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                You are paying for people to arrive here, so it is worth opening it and reading it as
                a stranger would.
              </p>
            </Row>

            <Row icon={<Check className="h-3.5 w-3.5" />} label="What counts as a result">
              {campaign.conversionAction?.trim() ? (
                <>
                  <p className="break-words text-[13.5px] text-ink">{campaign.conversionAction}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                    Google will bid toward this, and it is what the reporting will be measured
                    against.
                  </p>
                </>
              ) : (
                <div className="rounded-lg border border-warn-fg/25 bg-warn-bg px-3 py-2.5">
                  <p className="text-[13px] font-semibold text-warn-fg">Nothing is being tracked</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink">
                    Google bids toward results it can measure, so without one it cannot optimise and
                    you cannot tell what worked. Setting this up before the campaign is turned on is
                    the single most valuable thing on this page.
                  </p>
                </div>
              )}
            </Row>

            {account && (
              <Row icon={<Info className="h-3.5 w-3.5" />} label="Which Google Ads account">
                <p className="break-words text-[13.5px] text-ink">{account.name}</p>
                <p className="mt-1 tnum text-[13px] text-ink-muted">{account.customerId}</p>
              </Row>
            )}
          </div>
        </Card>

        <LaunchPanel
          campaign={{
            id: campaign.id,
            status: campaign.status,
            currencyCode: campaign.currencyCode,
            dailyBudget: campaign.dailyBudget,
            externalCampaignId: campaign.externalCampaignId,
            lastError: campaign.lastError,
          }}
          blockReason={blockReason}
          approval={approval}
          account={
            account
              ? { name: account.name, connected: account.connected, testAccount: account.testAccount }
              : null
          }
          permissions={permissions}
        />
      </aside>

      {/* ------------------------------------------------------ main column */}
      <div className="min-w-0 flex-1 space-y-4 lg:order-1">
        {/* The queue sends reviewers here because a campaign cannot be judged
            from one piece of creative. Having brought them here, the decision
            has to be recordable here — sending them back to the queue would
            mean deciding with none of this in front of them. */}
        {decision && (
          <DecisionPanel
            campaignId={campaign.id}
            requestId={decision.requestId}
            chainName={decision.chainName}
            stepName={decision.stepName}
            stepIndex={decision.stepIndex}
            totalSteps={decision.totalSteps}
            stepRole={decision.stepRole}
            eligible={decision.eligible}
            canDecide={decision.canDecide}
            dailyBudget={campaign.dailyBudget}
            currencyCode={campaign.currencyCode}
            hasErrors={report.errors.length > 0}
          />
        )}

        {report.errors.length > 0 && (
          <Card className="border-danger-fg/30">
            <div className="flex items-start gap-3 border-b border-danger-fg/25 bg-danger-bg px-5 py-4">
              <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" aria-hidden />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-danger-fg">
                  {report.errors.length} thing{report.errors.length === 1 ? '' : 's'} would stop
                  Google accepting this
                </h2>
                <p className="mt-0.5 text-[13px] leading-snug text-ink">
                  Google accepts a campaign whole or not at all, so every one of these has to be
                  fixed before it can be sent.
                </p>
              </div>
            </div>
            <IssueList issues={report.errors} />
          </Card>
        )}

        {report.warnings.length > 0 && (
          <Card>
            <CardHeader
              title={`${report.warnings.length} thing${report.warnings.length === 1 ? '' : 's'} worth a look`}
              description="Advice, not blockers. The campaign can go to Google exactly as it is."
              icon={<AlertTriangle className="h-4 w-4" />}
              actions={<Badge tone="warn">Advice</Badge>}
            />
            <div className="px-5 py-4">
              <Disclosure summary={`Show all ${report.warnings.length}`}>
                <div className="-mx-5">
                  <IssueList issues={report.warnings} />
                </div>
              </Disclosure>
            </div>
          </Card>
        )}

        {report.ok && report.warnings.length === 0 && (
          <Card>
            <div className="flex items-start gap-3 p-5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok-fg" aria-hidden />
              <p className="min-w-0 text-[13.5px] leading-relaxed text-ink">
                Nothing in this campaign breaks a Google rule, and nothing is flagged as unwise. The
                copy, the searches and the budget are still worth reading before you approve it.
              </p>
            </div>
          </Card>
        )}

        {campaign.structure?.rationale && (
          <Card>
            <CardHeader
              title="Why the campaign is shaped this way"
              description="Written when the plan was built, in its own words."
              icon={<Sparkles className="h-4 w-4" />}
            />
            <div className="space-y-3.5 p-5">
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
                {campaign.structure.rationale}
              </p>
              {campaign.briefText && (
                <Disclosure summary="What was asked for">
                  <p className="whitespace-pre-wrap rounded-lg bg-bg-subtle px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted">
                    {campaign.briefText}
                  </p>
                </Disclosure>
              )}
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label="Sets of ads" value={report.counts.adGroups} />
          <Count label="Searches" value={report.counts.keywords} />
          <Count label="Adverts" value={report.counts.ads} />
          <Count label="Headlines" value={report.counts.headlines} />
        </div>

        <PlanView structure={campaign.structure} finalUrl={campaign.finalUrl} />

        <PushHistory entries={history} />
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- bits */

function IssueList({ issues }: { issues: AdIssue[] }) {
  return (
    <ul className="divide-y divide-line">
      {issues.map((issue, i) => (
        <li key={`${issue.path}-${i}`} className="px-5 py-3.5">
          <p className="break-words text-2xs font-semibold uppercase tracking-wider text-ink-faint">
            {issue.where}
          </p>
          <p className="mt-1 break-words text-[13.5px] leading-relaxed text-ink">{issue.message}</p>
          <p className="mt-1 break-words text-[13px] leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">What to do: </span>
            {issue.fix}
          </p>
          {issue.suggestion && (
            <div className="mt-2 min-w-0 rounded-lg border border-line bg-bg-subtle px-3 py-2">
              <p className="label mb-1">Suggested replacement</p>
              <p className="break-words font-mono text-[13px] leading-relaxed text-ink">
                {issue.suggestion}
              </p>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 shrink-0 text-ink-faint" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="label mb-1">{label}</p>
        {children}
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-bg-subtle px-3 py-2.5">
      <dt className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="tnum mt-1 break-words text-[15px] font-semibold text-ink">{value}</dd>
    </div>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="card min-w-0 px-4 py-3">
      <p className="tnum text-xl font-semibold leading-none tracking-tight text-ink">{value}</p>
      <p className="mt-1.5 break-words text-2xs font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------- helpers */

function languageNames(codes: string[]): string {
  if (codes.length === 0) return 'No language chosen'
  return listOf(
    codes.map(
      (code) =>
        LANGUAGE_PRESETS.find((l) => l.criterionId === code || l.code === code)?.name ?? code,
    ),
  )
}

/** "A", "A and B", "A, B and C" — read aloud rather than comma-separated. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
