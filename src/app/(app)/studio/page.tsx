import type { Metadata } from 'next'
import Link from 'next/link'
import { FileText, PenLine, Sparkles, TriangleAlert } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, RequirementNote, SectionHeading } from '@/components/shell/page'
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  ScoreRing,
  StatTile,
} from '@/components/ui/primitives'
import { AssetStatusBadge, ChannelChip, RelativeTime, formatPercent } from '@/components/domain'
import { assetCounts, brandPassRate, listAssets, listBriefs } from './queries'
import { StudioFilterBar } from '@/components/studio/filter-bar'

export const metadata: Metadata = { title: 'Content Studio' }

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const auth = await requireAuth()
  const params = await searchParams
  const status = params.status ?? 'all'
  const channel = params.channel ?? 'all'
  const q = params.q ?? ''
  const view = params.view === 'briefs' ? 'briefs' : 'assets'

  const [items, counts, briefRows, pass, notifications] = await Promise.all([
    listAssets(auth.workspace.id, { status, channel, q }),
    assetCounts(auth.workspace.id),
    listBriefs(auth.workspace.id),
    brandPassRate(auth.workspace.id),
    listNotifications(auth.workspace.id, auth.user.id),
  ])

  const canCreate = can(auth.role, 'asset:create')
  const belowTarget = pass.rate !== null && pass.rate < 0.95

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Content Studio"
        description="Briefs become on-brand, scored variants — nothing reaches a reviewer unjudged"
        notifications={notifications}
        actions={
          canCreate && (
            <LinkButton href="/studio/new" variant="primary" size="sm">
              <PenLine className="h-3.5 w-3.5" />
              New brief
            </LinkButton>
          )
        }
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Assets"
            value={counts.all}
            hint={`${counts.needs_work} need work · ${counts.in_review} in review`}
          />
          <StatTile
            label="Brand check passed unedited"
            value={pass.rate === null ? '—' : formatPercent(pass.rate, 0)}
            delta={
              pass.rate !== null
                ? {
                    value: belowTarget ? 'below 95% target' : 'at or above target',
                    direction: belowTarget ? 'down' : 'up',
                    good: !belowTarget,
                  }
                : undefined
            }
            hint={`${pass.passedUnedited} of ${pass.generated} generated`}
            icon={belowTarget ? <TriangleAlert className="h-4 w-4 text-warn-fg" /> : undefined}
          />
          <StatTile
            label="Average score"
            value={pass.avgComposite ? Math.round(pass.avgComposite) : '—'}
            hint="Composite across every scored asset"
          />
          <StatTile
            label="Approved or live"
            value={counts.approved + counts.scheduled + counts.published}
            hint={`${counts.published} published`}
          />
        </div>

        <div className="mt-6">
          <StudioFilterBar counts={counts} status={status} channel={channel} q={q} view={view} />
        </div>

        {view === 'briefs' ? (
          <div className="mt-4">
            <SectionHeading
              title="Briefs"
              description="Each brief produced a set of channel-specific variants from one instruction."
            />
            {briefRows.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<FileText className="h-5 w-5" />}
                  title="No briefs yet"
                  description="A brief is the unit of work here: objective, audience and key messages in, channel-shaped variants out."
                  action={
                    canCreate && (
                      <LinkButton href="/studio/new" variant="primary" size="sm">
                        Write the first brief
                      </LinkButton>
                    )
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {briefRows.map((b) => (
                  <Link
                    key={b.id}
                    href={`/studio?view=assets&brief=${b.id}`}
                    className="card block p-4 transition-colors hover:bg-surface-hover"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-semibold text-ink">{b.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-muted">
                          {b.objective}
                        </p>
                      </div>
                      {b.avgScore !== null && <ScoreRing score={Math.round(b.avgScore)} size={38} />}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {b.channels.map((c) => (
                        <ChannelChip key={c} channel={c} size="sm" />
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-ink-faint">
                      <span className="flex items-center gap-1.5">
                        {b.authorName && <Avatar name={b.authorName} hue={b.authorHue ?? 250} size={18} />}
                        {b.campaignName ?? 'No campaign'}
                      </span>
                      <span className="tnum">
                        {b.variants} variant{b.variants === 1 ? '' : 's'} · {b.approved} approved ·{' '}
                        <RelativeTime date={b.createdAt} />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4">
            {items.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Sparkles className="h-5 w-5" />}
                  title={q || status !== 'all' || channel !== 'all' ? 'Nothing matches those filters' : 'No assets yet'}
                  description={
                    q || status !== 'all' || channel !== 'all'
                      ? 'Clear the filters to see everything in the workspace.'
                      : 'Write a brief and Aurea will produce channel-specific variants, each scored against your brand voice and legal rules before you read a word of it.'
                  }
                  action={
                    canCreate && (
                      <LinkButton href="/studio/new" variant="primary" size="sm">
                        Write a brief
                      </LinkButton>
                    )
                  }
                />
              </Card>
            ) : (
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line">
                  {items.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`/studio/${a.id}`}
                        className="flex items-start gap-3.5 px-4 py-3 transition-colors hover:bg-surface-hover"
                      >
                        <div className="pt-0.5">
                          <ScoreRing score={a.composite ?? 0} size={36} />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13.5px] font-medium text-ink">{a.title}</span>
                            <Badge tone="neutral">v{a.version}</Badge>
                            {a.editedByHuman && <Badge tone="info">Edited</Badge>}
                            {a.scoreDetail?.compliance.findings.some((f) => f.severity === 'high') && (
                              <Badge tone="danger" dot>
                                Blocking finding
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 line-clamp-1 text-[13px] text-ink-muted">
                            {a.body.subject ?? a.body.headline ?? a.body.body}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-faint">
                            <span>Variant {a.variantLabel}</span>
                            {a.briefTitle && <span className="truncate">· {a.briefTitle}</span>}
                            {a.campaignName && <span className="truncate">· {a.campaignName}</span>}
                            <span>
                              · updated <RelativeTime date={a.updatedAt} />
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <AssetStatusBadge status={a.status} />
                          <ChannelChip channel={a.channel} size="sm" />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        <RequirementNote>
          CS-1 multi-channel variants from one brief · CS-2 every asset scored against the brand voice
          profile and legal rules before review · CS-3 inline editing and one-click regeneration · CS-5
          approved assets flow straight to the scheduler
        </RequirementNote>
      </PageBody>
    </>
  )
}
