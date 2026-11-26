import type { Metadata } from 'next'
import Link from 'next/link'
import { Gauge, Radar, Settings2, Swords, Target } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { MAX_TRACKED, latestLandscape, latestScan, listCompetitors, loadProfile } from '@/lib/competitors/service'
import { configured, providerStatus } from '@/lib/competitors/sources/config'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, EmptyState, LinkButton, StatTile } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { ProfileSetup } from '@/components/competitors/setup'
import { RefreshControls } from '@/components/competitors/refresh'
import { Landscape, type CompetitorRow } from '@/components/competitors/landscape'
import { SourcesPanel } from '@/components/competitors/sources-panel'

export const metadata: Metadata = { title: 'Competitors' }

/**
 * Discovery reads up to 45 candidate websites before it will call anything a
 * competitor, which takes longer than a serverless function's default life.
 * Server actions inherit this segment's budget, so "Find competitors" needs
 * it set here as well as on the cron route.
 *
 * Vercel allows 300s on Pro; on Hobby the ceiling is 60s and a large
 * discovery run may be cut short, in which case fewer websites are read and
 * the unread ones stay unconfirmed rather than being wrongly promoted.
 */
export const maxDuration = 300

/**
 * Competitor intelligence. Three states: no profile yet (set up), a profile
 * but no analysis (find and scan), and the landscape itself. Everything on
 * the landscape comes from the latest stored report; scans and changes come
 * from the latest stored scan of each competitor.
 */
export default async function CompetitorsPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const canAnalyse = can(auth.role, 'competitor:analyse')

  const [profile, notifications, all, landscape] = await Promise.all([
    loadProfile(wsId),
    listNotifications(wsId, auth.user.id),
    listCompetitors(wsId),
    latestLandscape(wsId),
  ])

  const topbar = (
    <Topbar
      user={auth.user}
      role={auth.role}
      title="Competitors"
      description="Who competes for your customers, what they promise, and where they leave room — turned into content, ads and video"
      notifications={notifications}
      actions={
        profile && canAnalyse ? (
          <LinkButton href="/competitors/setup" size="sm" variant="ghost">
            <Settings2 className="h-3.5 w-3.5" />
            Profile and sources
          </LinkButton>
        ) : undefined
      }
    />
  )

  if (!profile) {
    return (
      <>
        {topbar}
        <PageBody width="narrow">
          {canAnalyse ? (
            <div className="space-y-4">
              <ProfileSetup companiesHouse={configured('companies_house')} initial={null} firstRun />
              <SourcesPanel providers={providerStatus()} />
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<Radar className="h-5 w-5" />}
                title="Competitor analysis has not been set up"
                description="Owners, marketing ops and growth marketers can set it up. Once they have, you can read everything here."
              />
            </Card>
          )}
        </PageBody>
      </>
    )
  }

  // Latest scan per tracked competitor, for advantage, rating and changes.
  const tracked = all.filter((c) => c.status === 'tracked')
  const scans = new Map(await Promise.all(tracked.map(async (c) => [c.id, await latestScan(wsId, c.id)] as const)))
  const rows: CompetitorRow[] = all.map((c) => {
    const s = scans.get(c.id) ?? null
    const g = s?.snapshot.reviews.find((r) => r.source === 'google')
    return {
      id: c.id,
      name: c.name,
      domain: c.domain,
      kind: c.kind,
      tier: c.tier,
      status: c.status,
      relevance: c.relevance,
      threat: c.threatScore,
      lastScannedAt: c.lastScannedAt?.toISOString() ?? null,
      rating: g?.rating ?? c.candidate.rating,
      reviews: g?.count ?? c.candidate.reviewCount,
      distanceKm: c.candidate.distanceKm,
      simulated: c.simulated,
      reasons: c.candidate.reasons,
      sources: c.candidate.sources,
      advantage: s?.analysis?.advantage.text ?? null,
      changes: (s?.changes ?? []).filter((x) => x.significant).map((x) => x.summary),
    }
  })

  const report = landscape?.report ?? null
  const threats = tracked.map((c) => c.threatScore).filter((x): x is number => x !== null)
  const high = threats.filter((t) => t >= 60).length
  const changed = rows.filter((r) => r.status === 'tracked' && r.changes.length > 0).length
  const usShare = report?.shareOfVoice.find((s) => s.competitorId === 'us')?.share ?? null

  return (
    <>
      {topbar}
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              {(report?.simulated || tracked.some((c) => c.simulated)) && (
                <Badge tone="warn" dot>
                  {tracked.every((c) => c.simulated) ? 'Simulated market' : 'Partly simulated'}
                </Badge>
              )}
              <span>
                {profile.companyName} · {profile.businessType} · {profile.scope === 'hybrid' ? 'local and national' : profile.scope}
                {profile.locality ? ` · ${profile.locality}` : ''} · {profile.keywords.length} searches
              </span>
              {landscape && (
                <>
                  <span>·</span>
                  <span>
                    analysed <RelativeTime date={landscape.createdAt} />
                  </span>
                  <span className="font-mono" title="sha256 of the stored analysis">
                    · {landscape.reportHash.slice(0, 12)}
                  </span>
                </>
              )}
            </div>
            <RefreshControls trackedIds={tracked.map((c) => ({ id: c.id, name: c.name }))} canAnalyse={canAnalyse} />
          </div>

          {report?.simulated && (
            <p className="rounded-md bg-warn-bg px-3 py-2 text-[13px] text-ink-muted ring-1 ring-warn-fg/20">
              Some competitors and evidence on this page are simulated, because no discovery or search source is connected yet. Simulated
              businesses are fictional and live on <code className="font-mono text-xs">.example</code> addresses. Add real competitors by web
              address (their public sites are read with no keys), or connect sources in{' '}
              <Link href="/competitors/setup" className="font-medium text-ink underline">
                Profile and sources
              </Link>
              .
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Tracked competitors"
              value={`${tracked.length} / ${MAX_TRACKED}`}
              hint={`${all.filter((c) => c.status === 'suggested' && c.kind !== 'referral').length} more suggested`}
              icon={<Swords className="h-4 w-4" />}
            />
            <StatTile label="High threat" value={high} hint={threats.length ? `average ${Math.round(threats.reduce((a, b) => a + b, 0) / threats.length)}/100` : 'scan to score'} icon={<Gauge className="h-4 w-4" />} />
            <StatTile
              label="Your share of searches"
              value={usShare === null ? '—' : `${Math.round(usShare * 100)}%`}
              hint={report?.shareOfVoice[0] && report.shareOfVoice[0].competitorId !== 'us' ? `leader: ${report.shareOfVoice[0].name}` : usShare !== null ? 'you lead' : 'needs search data'}
              icon={<Target className="h-4 w-4" />}
            />
            <StatTile label="Plays" value={report?.plays.length ?? 0} hint={changed ? `${changed} competitor${changed === 1 ? '' : 's'} changed` : 'from the latest analysis'} icon={<Radar className="h-4 w-4" />} />
          </div>

          {tracked.length === 0 && !report && (
            <Card>
              <EmptyState
                icon={<Radar className="h-5 w-5" />}
                title="No competitors tracked yet"
                description="Find competitors from your profile, or add one by its web address in the Competitors tab below."
              />
            </Card>
          )}

          <Landscape
            report={report}
            rows={rows}
            canAnalyse={canAnalyse}
            businessType={profile.businessType}
            selfName={profile.companyName}
            maxTracked={MAX_TRACKED}
          />
        </div>
      </PageBody>
    </>
  )
}
