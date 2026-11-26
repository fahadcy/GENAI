import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { db } from '@/lib/db'
import {
  adAccounts,
  adCampaigns,
  approvalChains,
  approvalRequests,
  users,
  type AdCampaignStatus,
  type AdCampaignStructure,
} from '@/lib/db/schema'
import { listNotifications } from '@/lib/notifications'
import { pushHistory } from '@/lib/ads/push'
import { pushBlockReason } from '@/lib/workflow/approvals'
import { objectiveDef, fromMicros } from '@/lib/ads/objectives'
import { validateCampaign } from '@/lib/ads/validate'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, LinkButton, type BadgeTone } from '@/components/ui/primitives'
import { ChannelChip, RelativeTime } from '@/components/domain'
import { CampaignView } from '@/components/ads/campaign-view'

export const metadata: Metadata = { title: 'Campaign' }

/*
 * Deliberately duplicated from the launch panel rather than imported from it.
 * A 'use client' module's plain exports are client references on the server, so
 * reading one here would render "undefined" — which it did, before this.
 */
const STATUS_LABEL: Record<AdCampaignStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  publishing: 'Sending',
  live: 'Running',
  paused: 'Paused in Google',
  ended: 'Ended',
  failed: 'Failed',
}

const STATUS_TONE: Record<AdCampaignStatus, BadgeTone> = {
  draft: 'neutral',
  in_review: 'warn',
  changes_requested: 'danger',
  approved: 'ok',
  publishing: 'info',
  live: 'gold',
  paused: 'info',
  ended: 'neutral',
  failed: 'danger',
}

/** A campaign can be saved before a plan exists; the validator needs a shape either way. */
const EMPTY_STRUCTURE: AdCampaignStructure = {
  adGroups: [],
  negativeKeywords: [],
  sitelinks: [],
  callouts: [],
  rationale: '',
}

export default async function AdCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ request?: string }>
}) {
  const auth = await requireAuth()
  const { id } = await params
  const { request } = await searchParams

  const [row] = await db
    .select({ campaign: adCampaigns, account: adAccounts })
    .from(adCampaigns)
    .leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId))
    .where(and(eq(adCampaigns.workspaceId, auth.workspace.id), eq(adCampaigns.id, id)))
    .limit(1)

  if (!row) notFound()

  const { campaign, account } = row

  const [notifications, log, blockReason, approvalRow] = await Promise.all([
    listNotifications(auth.workspace.id, auth.user.id),
    pushHistory(auth.workspace.id, id),
    pushBlockReason(auth.workspace.id, id),
    db
      .select({ request: approvalRequests, chain: approvalChains })
      .from(approvalRequests)
      .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
      .where(
        and(
          eq(approvalRequests.workspaceId, auth.workspace.id),
          eq(approvalRequests.subjectType, 'ad_campaign'),
          eq(approvalRequests.subjectId, id),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(1)
      .then((r) => r[0] ?? null),
  ])

  const currentStep = approvalRow?.chain.steps[approvalRow.request.currentStep] ?? null

  // Who did what, for the push log. Separate rather than joined because the log
  // query is shared with the rest of the ads surface.
  const actorIds = Array.from(
    new Set(log.map((entry) => entry.actorId).filter((v): v is string => Boolean(v))),
  )
  const actors = actorIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, actorIds))
    : []
  const actorName = new Map(actors.map((a) => [a.id, a.name]))

  const objective = objectiveDef(campaign.objective)
  const dailyBudget = fromMicros(campaign.dailyBudgetMicros)
  const structure = campaign.structure ?? EMPTY_STRUCTURE

  /* Pure over the plan, so it belongs on the server: the client gets a verdict
     rather than re-deriving one, and the same report backs the push path. */
  const report = validateCampaign({
    name: campaign.name,
    finalUrl: campaign.finalUrl ?? '',
    dailyBudget,
    currencyCode: campaign.currencyCode,
    geoTargets: campaign.geoTargets.map((g) => g.criterionId),
    languages: campaign.languages,
    structure,
    suggestedMinDailyBudget: objective.suggestedMinDailyBudget,
    conversionAction: campaign.conversionAction,
    objectiveKey: campaign.objective,
  })

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={campaign.name}
        description={`${objective.label} · ${STATUS_LABEL[campaign.status]}`}
        notifications={notifications}
        actions={
          <LinkButton href="/ads" size="sm" variant="ghost">
            <ArrowLeft className="h-3.5 w-3.5" />
            All campaigns
          </LinkButton>
        }
      />

      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[campaign.status]} dot>
            {STATUS_LABEL[campaign.status]}
          </Badge>
          <ChannelChip channel="google_ads" size="sm" />
          <Badge tone="neutral">v{campaign.version}</Badge>
          {account && (
            <span className="min-w-0 truncate text-xs text-ink-muted">
              {account.descriptiveName ?? `Account ${account.customerId}`}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-ink-faint">
            updated <RelativeTime date={campaign.updatedAt} />
          </span>
        </div>

        <CampaignView
          campaign={{
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            objective: campaign.objective,
            dailyBudget,
            currencyCode: campaign.currencyCode,
            finalUrl: campaign.finalUrl,
            conversionAction: campaign.conversionAction,
            geoTargets: campaign.geoTargets,
            languages: campaign.languages,
            briefText: campaign.briefText,
            structure: campaign.structure,
            externalCampaignId: campaign.externalCampaignId,
            lastError: campaign.lastError,
          }}
          account={
            account
              ? {
                  name: account.descriptiveName ?? `Account ${account.customerId}`,
                  customerId: account.customerId,
                  connected: account.status === 'connected',
                  testAccount: account.testAccount,
                }
              : null
          }
          report={report}
          history={log.map((entry) => ({
            id: entry.id,
            action: entry.action,
            ok: entry.ok,
            simulated: entry.simulated,
            requestId: entry.requestId,
            operationCount: entry.operationCount,
            request: entry.request,
            response: entry.response,
            error: entry.error,
            createdAt: entry.createdAt.toISOString(),
            actorName: entry.actorId ? (actorName.get(entry.actorId) ?? null) : null,
          }))}
          blockReason={blockReason}
          approval={
            approvalRow
              ? {
                  chainName: approvalRow.chain.name,
                  steps: approvalRow.chain.steps,
                  currentStep: approvalRow.request.currentStep,
                }
              : null
          }
          decision={
            approvalRow
              ? {
                  requestId: approvalRow.request.id,
                  chainName: approvalRow.chain.name,
                  stepName: currentStep?.name ?? 'Review',
                  stepIndex: approvalRow.request.currentStep,
                  totalSteps: approvalRow.chain.steps.length,
                  stepRole: currentStep?.role ?? 'reviewer',
                  // An owner can act on any step; otherwise the step either
                  // names its approvers explicitly or falls back to a role.
                  eligible:
                    auth.role === 'owner' ||
                    (currentStep?.approverIds?.length
                      ? currentStep.approverIds.includes(auth.user.id)
                      : currentStep?.role === auth.role),
                  canDecide: can(auth.role, 'approval:decide'),
                }
              : null
          }
          permissions={{
            create: can(auth.role, 'ads:create'),
            push: can(auth.role, 'ads:push'),
            golive: can(auth.role, 'ads:golive'),
          }}
        />
      </PageBody>
    </>
  )
}
