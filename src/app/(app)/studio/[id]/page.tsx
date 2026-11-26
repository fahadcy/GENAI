import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, GitBranch, Layers } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { publishBlockReason } from '@/lib/workflow/approvals'
import { db } from '@/lib/db'
import { segments } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Avatar, Badge, Card, CardHeader, LinkButton, ScoreRing } from '@/components/ui/primitives'
import { AssetStatusBadge, ChannelChip, RelativeTime } from '@/components/domain'
import { AssetWorkbench } from '@/components/studio/workbench'
import { getAssetDetail } from '../queries'

export const metadata: Metadata = { title: 'Asset' }

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params

  const detail = await getAssetDetail(auth.workspace.id, id)
  if (!detail) notFound()

  const [notifications, blockReason, segmentRows] = await Promise.all([
    listNotifications(auth.workspace.id, auth.user.id),
    publishBlockReason(auth.workspace.id, id),
    db
      .select({
        id: segments.id,
        name: segments.name,
        reachability: segments.reachability,
        reachable: segments.reachableSize,
      })
      .from(segments)
      .where(eq(segments.workspaceId, auth.workspace.id))
      .orderBy(desc(segments.reachableSize))
      .limit(30),
  ])

  const { asset, brief, campaign, author, versions, approval, siblings, profile, rules } = detail

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={asset.title}
        description={`Variant ${asset.variantLabel} · v${asset.version}${brief ? ` · from "${brief.title}"` : ''}`}
        notifications={notifications}
        actions={
          <LinkButton href="/studio" size="sm" variant="ghost">
            <ArrowLeft className="h-3.5 w-3.5" />
            All assets
          </LinkButton>
        }
      />

      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <AssetStatusBadge status={asset.status} />
          <ChannelChip channel={asset.channel} size="sm" />
          {campaign?.id && (
            <Link
              href={`/planner/${campaign.id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-bg-inset px-2 py-1 text-xs text-ink-muted transition-colors hover:text-brand-600"
            >
              <Layers className="h-3 w-3" />
              {campaign.name}
            </Link>
          )}
          {asset.replacesAssetId && (
            <Link href={`/studio/${asset.replacesAssetId}`}>
              <Badge tone="gold">Copilot replacement — see the original</Badge>
            </Link>
          )}
          <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
            {author?.name && <Avatar name={author.name} hue={author.avatarHue ?? 250} size={20} />}
            {author?.name ?? 'Unknown'} · updated <RelativeTime date={asset.updatedAt} />
          </span>
        </div>

        <AssetWorkbench
          asset={{
            id: asset.id,
            title: asset.title,
            channel: asset.channel,
            body: asset.body,
            status: asset.status,
            version: asset.version,
            scoreDetail: asset.scoreDetail,
            imagePrompt: asset.imagePrompt,
            editedByHuman: asset.editedByHuman,
          }}
          profile={
            profile
              ? { tone: profile.tone, passThreshold: profile.passThreshold, name: profile.name }
              : null
          }
          legalRuleCount={rules.filter((r) => r.active).length}
          versions={versions.map((v) => ({
            version: v.version,
            note: v.note,
            createdAt: v.createdAt.toISOString(),
            composite: v.scoreDetail?.composite ?? null,
          }))}
          approval={
            approval
              ? {
                  id: approval.request.id,
                  status: approval.request.status,
                  chainName: approval.chain.name,
                  currentStep: approval.request.currentStep,
                  steps: approval.chain.steps,
                  subjectVersion: approval.request.subjectVersion,
                  requestedAt: approval.request.requestedAt.toISOString(),
                  decisions: approval.decisions.map((d) => ({
                    decision: d.decision.decision,
                    comment: d.decision.comment,
                    step: d.decision.step,
                    createdAt: d.decision.createdAt.toISOString(),
                    userName: d.userName,
                    userHue: d.userHue,
                  })),
                }
              : null
          }
          segments={segmentRows.map((s) => ({
            id: s.id,
            name: s.name,
            reachable: s.reachability[asset.channel] ?? s.reachable,
          }))}
          blockReason={blockReason}
          permissions={{
            edit: can(auth.role, 'asset:edit'),
            submit: can(auth.role, 'asset:submit'),
            schedule: can(auth.role, 'schedule:create'),
          }}
        />

        {siblings.length > 0 && (
          <Card className="mt-6">
            <CardHeader
              title="Other variants from this brief"
              description="Different angles on the same substance — compare before choosing."
              icon={<GitBranch className="h-4 w-4" />}
            />
            <ul className="divide-y divide-line">
              {siblings.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/studio/${s.id}`}
                    className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-surface-hover"
                  >
                    <ScoreRing score={s.composite ?? 0} size={30} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{s.title}</span>
                    <span className="shrink-0 text-xs text-ink-faint">Variant {s.variantLabel}</span>
                    <ChannelChip channel={s.channel} size="sm" showLabel={false} />
                    <AssetStatusBadge status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </PageBody>
    </>
  )
}
