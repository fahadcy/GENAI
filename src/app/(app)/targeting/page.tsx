import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Copy, ShieldCheck, Target, Users } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { describeRules } from '@/lib/targeting/engine'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Badge, Card, EmptyState, StatTile } from '@/components/ui/primitives'
import { ChannelChip, RelativeTime, formatCompact, formatPercent } from '@/components/domain'
import { AudienceBuilder } from '@/components/targeting/builder'
import { RefreshButton } from '@/components/targeting/sync'
import {
  audienceOverview,
  connectorStatuses,
  listSegments,
  suppressionReasons,
  type SegmentListItem,
} from './queries'

export const metadata: Metadata = { title: 'Audience Targeting' }

export default async function TargetingPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const [segments, overview, reasons, connectors, notifications] = await Promise.all([
    listSegments(wsId),
    audienceOverview(wsId),
    suppressionReasons(wsId),
    connectorStatuses(wsId),
    listNotifications(wsId, auth.user.id),
  ])

  const canCreate = can(auth.role, 'segment:create')
  const ruleCount = segments.filter((s) => s.sourceType !== 'lookalike').length
  const lookalikeCount = segments.length - ruleCount
  const largestReach = segments.reduce((a, s) => Math.max(a, s.reachableSize), 0)
  const emailShare = overview.total > 0 ? overview.consent.email / overview.total : 0

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Audience Targeting"
        description={`${segments.length} saved segment${segments.length === 1 ? '' : 's'} over ${overview.total.toLocaleString('en-GB')} contacts · consent and suppression enforced on every evaluation`}
        notifications={notifications}
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Saved segments"
            value={segments.length}
            hint={`${ruleCount} rule-based · ${lookalikeCount} lookalike`}
            icon={<Target className="h-4 w-4" />}
          />
          <StatTile
            label="Contacts on file"
            value={formatCompact(overview.total)}
            hint={`avg. engagement ${Math.round(overview.avgEngagement)}/100`}
            icon={<Users className="h-4 w-4" />}
          />
          <StatTile
            label="Largest reachable audience"
            value={formatCompact(largestReach)}
            hint={
              segments.length > 0
                ? `after consent, across ${segments.length} segment${segments.length === 1 ? '' : 's'}`
                : 'no segments yet'
            }
          />
          <StatTile
            label="Suppressed and excluded"
            value={formatCompact(overview.suppressed)}
            delta={{
              value: `${formatPercent(overview.total > 0 ? overview.suppressed / overview.total : 0, 1)} of file`,
              direction: 'flat',
            }}
            hint="never enters a segment"
            icon={<ShieldCheck className="h-4 w-4" />}
          />
        </div>

        <div className="mt-6">
          <AudienceBuilder
            connectors={connectors}
            suppressionReasons={reasons}
            canCreate={canCreate}
          />
        </div>

        {/* Consent held across the whole file — the ceiling every segment below
            is measured against. */}
        <Card className="mt-6 overflow-hidden">
          <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok-fg" />
              <div>
                <h2 className="text-sm font-semibold text-ink">Consent held across the file</h2>
                <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">
                  No segment can exceed these ceilings. {formatPercent(emailShare, 0)} of contacts have
                  given email consent and are not suppressed.
                </p>
              </div>
            </div>
            <dl className="grid shrink-0 grid-cols-4 gap-5">
              {(['email', 'sms', 'push', 'ads'] as const).map((key) => (
                <div key={key} className="text-right">
                  <dt className="label">{key === 'ads' ? 'Ads' : key.toUpperCase()}</dt>
                  <dd className="tnum mt-1 text-[15px] font-semibold text-ink">
                    {formatCompact(overview.consent[key])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>

        <div className="mt-8">
          <SectionHeading
            title="Saved segments"
            description="Sizes below were counted the last time each segment ran. Refresh to recount against today's contacts."
          />
          {segments.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Target className="h-5 w-5" />}
                title="No audiences saved yet"
                description="Describe the audience you want in the builder above. You will see the rules GenAI derived, its size and its reachability before you commit to anything."
              />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {segments.map((s) => (
                <SegmentCard key={s.id} segment={s} />
              ))}
            </div>
          )}
        </div>
      </PageBody>
    </>
  )
}

function SegmentCard({ segment: s }: { segment: SegmentListItem }) {
  const isLookalike = s.sourceType === 'lookalike'
  const channels = s.syncTargets.length > 0 ? s.syncTargets : Object.keys(s.reachability)
  const stale = s.lastRefreshedAt ? Date.now() - s.lastRefreshedAt.getTime() > 7 * 86_400_000 : true

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/targeting/${s.id}`}
              className="truncate text-sm font-semibold text-ink hover:text-brand-600"
            >
              {s.name}
            </Link>
            {isLookalike ? (
              <Badge tone="brand">
                <Copy className="h-3 w-3" />
                Lookalike
              </Badge>
            ) : (
              <Badge tone="neutral">Rule-based</Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink-muted">
            {s.description ??
              (isLookalike
                ? `Similar to ${s.seedName ?? 'a deleted seed segment'} at ${s.similarityThreshold.toFixed(2)}.`
                : describeRules(s.rules))}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isLookalike && <RefreshButton segmentId={s.id} />}
          <Link
            href={`/targeting/${s.id}`}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Open
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 px-5 py-4">
        <Figure label="Size" value={s.estimatedSize.toLocaleString('en-GB')} />
        <Figure label="Reachable" value={s.reachableSize.toLocaleString('en-GB')} tone="ok" />
        <Figure
          label="Predicted conv."
          value={s.predictedConversion !== null ? formatPercent(s.predictedConversion, 2) : '—'}
        />
      </div>

      {channels.length > 0 && (
        <ul className="space-y-1.5 px-5 pb-4">
          {channels.map((channel) => {
            const n = s.reachability[channel] ?? 0
            const share = s.estimatedSize > 0 ? n / s.estimatedSize : 0
            return (
              <li key={channel} className="flex items-center gap-2.5">
                <div className="w-24 shrink-0">
                  <ChannelChip channel={channel} size="sm" />
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                  <div
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${Math.min(100, share * 100)}%` }}
                  />
                </div>
                <span className="tnum w-14 shrink-0 text-right text-xs text-ink-muted">
                  {n.toLocaleString('en-GB')}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-subtle px-5 py-2.5 text-2xs text-ink-faint">
        {s.memberCount === 0 && s.estimatedSize > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-danger-fg">
            <ShieldCheck className="h-3 w-3" />
            no membership stored — rebuild before using
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-ok-fg" />
            {s.suppressedCount.toLocaleString('en-GB')} suppressed and excluded
          </span>
        )}
        <span className={stale ? 'text-warn-fg' : undefined}>
          {s.lastRefreshedAt ? (
            <>
              refreshed <RelativeTime date={s.lastRefreshedAt} />
            </>
          ) : (
            'never refreshed'
          )}
        </span>
      </div>
    </Card>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="min-w-0">
      <p className="label">{label}</p>
      <p
        className={`tnum mt-1 truncate text-lg font-semibold leading-none tracking-tight ${
          tone === 'ok' ? 'text-ok-fg' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  )
}
