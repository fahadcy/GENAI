import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { and, asc, desc, eq, lt } from 'drizzle-orm'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can, ROLE_LABEL } from '@/lib/auth/rbac'
import { db } from '@/lib/db'
import {
  approvalChains,
  approvalDecisions,
  approvalRequests,
  assets,
  assetVersions,
  brandProfiles,
  briefs,
  campaigns,
  legalRules,
  memberships,
  users,
} from '@/lib/db/schema'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Avatar, Badge, LinkButton } from '@/components/ui/primitives'
import { ChannelChip, RelativeTime } from '@/components/domain'
import { ReviewPanel } from '@/components/approvals/review-panel'

export const metadata: Metadata = { title: 'Review' }

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params

  /**
   * A paid campaign is reviewed on its own surface, where the ad groups,
   * keywords, budget and the literal Google payload are laid out properly. This
   * page is built around a single piece of creative and would have to hide most
   * of what a reviewer needs to see before committing a budget.
   */
  const [pending] = await db
    .select({ subjectType: approvalRequests.subjectType, subjectId: approvalRequests.subjectId })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workspaceId, auth.workspace.id), eq(approvalRequests.id, id)))
    .limit(1)
  if (pending?.subjectType === 'ad_campaign') {
    redirect(`/ads/${pending.subjectId}?request=${id}`)
  }
  /**
   * A clip is reviewed where it can be played, with the delivery checks and
   * provenance beside it. This page is built around a single piece of text
   * creative and would have to hide most of what a video reviewer needs.
   */
  if (pending?.subjectType === 'video') {
    redirect(`/studio/video/${pending.subjectId}?request=${id}`)
  }
  /** A search change is reviewed beside the evidence and assumptions it rests on. */
  if (pending?.subjectType === 'search_action') {
    redirect(`/search/actions/${pending.subjectId}?request=${id}`)
  }
  /** A budget plan is reviewed line by line, beside the allocator's evidence. */
  if (pending?.subjectType === 'budget_plan') {
    redirect(`/budget/plans/${pending.subjectId}?request=${id}`)
  }

  const [row] = await db
    .select({
      request: approvalRequests,
      chain: approvalChains,
      asset: assets,
      brief: briefs,
      campaign: { id: campaigns.id, name: campaigns.name },
      requester: { name: users.name, avatarHue: users.avatarHue },
    })
    .from(approvalRequests)
    .innerJoin(approvalChains, eq(approvalChains.id, approvalRequests.chainId))
    .innerJoin(assets, eq(assets.id, approvalRequests.subjectId))
    .leftJoin(briefs, eq(briefs.id, assets.briefId))
    .leftJoin(campaigns, eq(campaigns.id, assets.campaignId))
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(and(eq(approvalRequests.workspaceId, auth.workspace.id), eq(approvalRequests.id, id)))
    .limit(1)

  if (!row) notFound()

  const [decisions, profile, rules, priorVersion, delegates, notifications] = await Promise.all([
    db
      .select({
        decision: approvalDecisions,
        userName: users.name,
        userHue: users.avatarHue,
      })
      .from(approvalDecisions)
      .leftJoin(users, eq(users.id, approvalDecisions.userId))
      .where(eq(approvalDecisions.requestId, id))
      .orderBy(asc(approvalDecisions.createdAt)),
    db
      .select()
      .from(brandProfiles)
      .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
      .limit(1)
      .then((r) => r[0] ?? null),
    db.select().from(legalRules).where(eq(legalRules.workspaceId, auth.workspace.id)),
    // The version immediately before this one, so a re-review shows a real diff
    // rather than asking the reviewer to remember what changed (AP-2).
    db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.assetId, row.asset.id), lt(assetVersions.version, row.asset.version)))
      .orderBy(desc(assetVersions.version))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({ id: users.id, name: users.name, role: memberships.role, avatarHue: users.avatarHue })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, auth.workspace.id)),
    listNotifications(auth.workspace.id, auth.user.id),
  ])

  const step = row.chain.steps[row.request.currentStep]
  const eligible =
    auth.role === 'owner' ||
    (step?.approverIds?.length ? step.approverIds.includes(auth.user.id) : step?.role === auth.role)

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Review"
        description={`${row.chain.name} · step ${row.request.currentStep + 1} of ${row.chain.steps.length}`}
        notifications={notifications}
        actions={
          <LinkButton href="/approvals" size="sm" variant="ghost">
            <ArrowLeft className="h-3.5 w-3.5" />
            Queue
          </LinkButton>
        }
      />

      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ChannelChip channel={row.asset.channel} size="sm" />
          <Badge tone="neutral">v{row.asset.version}</Badge>
          {row.campaign?.id && (
            <Link
              href={`/planner/${row.campaign.id}`}
              className="text-xs text-ink-muted hover:text-brand-600"
            >
              {row.campaign.name}
            </Link>
          )}
          <Link
            href={`/studio/${row.asset.id}`}
            className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand-600"
          >
            Open in Studio
            <ExternalLink className="h-3 w-3" />
          </Link>
          <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
            {row.requester?.name && (
              <Avatar name={row.requester.name} hue={row.requester.avatarHue ?? 250} size={20} />
            )}
            submitted by {row.requester?.name ?? 'someone'} <RelativeTime date={row.request.requestedAt} />
          </span>
        </div>

        <ReviewPanel
          requestId={row.request.id}
          status={row.request.status}
          asset={{
            id: row.asset.id,
            title: row.asset.title,
            channel: row.asset.channel,
            body: row.asset.body,
            version: row.asset.version,
            scoreDetail: row.asset.scoreDetail,
            editedByHuman: row.asset.editedByHuman,
          }}
          priorBody={priorVersion?.body ?? null}
          priorVersion={priorVersion?.version ?? null}
          brief={
            row.brief
              ? {
                  title: row.brief.title,
                  objective: row.brief.objective,
                  audienceNote: row.brief.audienceNote,
                  keyMessages: row.brief.keyMessages,
                  callToAction: row.brief.callToAction,
                  mustInclude: row.brief.mustInclude,
                  mustAvoid: row.brief.mustAvoid,
                }
              : null
          }
          profile={profile ? { tone: profile.tone, passThreshold: profile.passThreshold, name: profile.name } : null}
          legalRuleCount={rules.filter((r) => r.active).length}
          chain={{
            name: row.chain.name,
            steps: row.chain.steps,
            currentStep: row.request.currentStep,
            dueAt: row.request.dueAt?.toISOString() ?? null,
          }}
          decisions={decisions.map((d) => ({
            decision: d.decision.decision,
            comment: d.decision.comment,
            step: d.decision.step,
            createdAt: d.decision.createdAt.toISOString(),
            userName: d.userName,
            userHue: d.userHue,
          }))}
          delegates={delegates
            .filter((d) => d.id !== auth.user.id)
            .map((d) => ({ id: d.id, name: d.name, role: ROLE_LABEL[d.role], avatarHue: d.avatarHue }))}
          viewer={{ eligible: Boolean(eligible), canDecide: can(auth.role, 'approval:decide'), role: auth.role }}
        />
      </PageBody>
    </>
  )
}
