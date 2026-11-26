import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowUpRight, ChevronLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { CLAIM_LABEL, type Claim } from '@/lib/serptwin/claims'
import { evidenceIndex } from '@/lib/competitors/analysis'
import { playHref } from '@/lib/competitors/plays'
import { latestScan, loadCompetitor, loadProfile, scanHistory } from '@/lib/competitors/service'
import {
  CHANNEL_KEY_LABEL,
  DISCOVERY_SOURCE_LABEL,
  PLAY_DESTINATION_LABEL,
  type ChannelKey,
  type Insight,
  type Play,
  type PlayDestination,
  type PresenceSnapshot,
  type SourceRun,
} from '@/lib/competitors/types'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader, EmptyState, type BadgeTone } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { ScanButton } from '@/components/competitors/scan-button'
import { StatusActions } from '@/components/competitors/landscape'

export const metadata: Metadata = { title: 'Competitor' }

const THREAT_TONE = (n: number): BadgeTone => (n >= 60 ? 'danger' : n >= 35 ? 'warn' : 'ok')
const STATUS_TONE: Record<SourceRun['status'], BadgeTone> = {
  ok: 'ok',
  skipped: 'neutral',
  blocked: 'warn',
  error: 'danger',
  simulated: 'warn',
}

export default async function CompetitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const competitor = await loadCompetitor(wsId, id)
  if (!competitor) notFound()

  const [scan, history, profile, notifications] = await Promise.all([
    latestScan(wsId, id),
    scanHistory(wsId, id),
    loadProfile(wsId),
    listNotifications(wsId, auth.user.id),
  ])
  const canAnalyse = can(auth.role, 'competitor:analyse')
  const s = scan?.snapshot ?? null
  const a = scan?.analysis ?? null
  const idx = s ? evidenceIndex(s) : new Map()

  // Turn "how to win" into things to make. Never names the competitor.
  const counterPlay: Play | null =
    a && profile && a.howToWin.length
      ? {
          id: `counter:${id}`,
          kind: 'counter',
          title: `Win customers who are comparing options`,
          why: '',
          evidence: [],
          destinations: ['landing_page', 'google_ads', 'video', 'social'],
          priority: 'high',
          brief: {
            title: `Why choose ${profile.companyName}`,
            objective: `Give people comparing ${profile.businessType}s a clear, verifiable reason to choose us. ${a.howToWin
              .map((h) => h.text)
              .join(' ')} Do not name or criticise any other firm; describe how we work and what customers get.`,
            keyMessages: a.howToWin.map((h) => h.text).slice(0, 4),
            keywords: profile.keywords.slice(0, 3),
          },
        }
      : null

  const links = s?.links ?? null
  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={competitor.name}
        description={competitor.domain ?? 'Competitor'}
        notifications={notifications}
      />
      <PageBody>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Link href="/competitors" className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink">
                <ChevronLeft className="h-3 w-3" />
                All competitors
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={competitor.kind === 'direct' ? 'brand' : 'neutral'}>{competitor.kind}</Badge>
                <Badge>{competitor.tier}</Badge>
                <Badge tone={competitor.status === 'tracked' ? 'ok' : 'neutral'}>{competitor.status}</Badge>
                {a && <Badge tone={THREAT_TONE(a.threat.score)}>Threat {a.threat.score}/100</Badge>}
                {(s?.simulated || competitor.simulated) && (
                  <Badge tone="warn" dot>
                    Simulated
                  </Badge>
                )}
              </div>
              <p className="max-w-3xl text-xs text-ink-faint">
                Found by: {competitor.candidate.sources.map((x) => DISCOVERY_SOURCE_LABEL[x]).join(', ')}.{' '}
                {competitor.candidate.reasons.join(' · ')}
              </p>
            </div>
            {canAnalyse && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusActions id={competitor.id} status={competitor.status} />
                {competitor.status === 'tracked' && <ScanButton id={competitor.id} label={scan ? 'Scan again' : 'Scan now'} />}
              </div>
            )}
          </div>

          {links && (
            <div className="flex flex-wrap gap-1.5">
              {[
                ['Website', links.website],
                ['Google ads they run', links.googleAdsTransparency],
                ['Meta ads they run', links.metaAdLibrary],
                ['Google Maps', links.googleMaps],
                ['Trustpilot', links.trustpilot],
                ['LinkedIn', links.linkedinSearch],
                ['TikTok', links.tiktokSearch],
              ]
                .filter(([, href]) => href && !String(href).includes('.example'))
                .map(([label, href]) => (
                  <a
                    key={label}
                    href={href!}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-muted hover:border-line-strong hover:text-ink"
                  >
                    {label}
                    <ArrowUpRight className="h-3 w-3" />
                  </a>
                ))}
            </div>
          )}

          {!s ? (
            <Card>
              <EmptyState
                title="Not scanned yet"
                description={
                  competitor.status === 'tracked'
                    ? 'Scan to read their website, blog, ads, rankings and reviews.'
                    : 'Track this competitor to scan it and include it in the analysis.'
                }
              />
            </Card>
          ) : (
            <>
              {a && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                  <Card>
                    <CardHeader
                      title="Their competitive advantage"
                      description={a.simulated ? 'Written from the evidence by built-in rules (no AI model).' : 'Written by the AI model; every point cites the evidence below.'}
                    />
                    <div className="space-y-4 p-5">
                      <div>
                        <p className="text-[15px] font-medium leading-snug text-ink">{a.advantage.text}</p>
                        <EvidenceChips ids={a.advantage.evidence} idx={idx} />
                      </div>
                      <p className="text-[13px] leading-relaxed text-ink-muted">
                        <span className="font-medium text-ink">Positioning:</span> {a.positioning}
                      </p>
                      <p className="text-[13px] leading-relaxed text-ink-muted">
                        <span className="font-medium text-ink">For:</span> {a.audience}
                        {a.tone ? (
                          <>
                            {' '}
                            · <span className="font-medium text-ink">Voice:</span> {a.tone}
                          </>
                        ) : null}
                      </p>
                      {a.valueProps.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {a.valueProps.map((v, i) => (
                            <Badge key={i} tone="info">
                              {v.text}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </Card>
                  <Card>
                    <CardHeader title="How active they are" description="Measured from what was found, 0 to 3." />
                    <div className="space-y-2 p-5">
                      {(Object.keys(a.channels) as ChannelKey[]).map((k) => (
                        <div key={k} className="flex items-center gap-3">
                          <span className="w-28 shrink-0 text-[13px] text-ink-muted">{CHANNEL_KEY_LABEL[k]}</span>
                          <div className="flex flex-1 gap-1">
                            {[1, 2, 3].map((n) => (
                              <span key={n} className={`h-2 flex-1 rounded-full ${a.channels[k] >= n ? 'bg-brand-600' : 'bg-bg-inset'}`} />
                            ))}
                          </div>
                        </div>
                      ))}
                      {a.threat.reasons.length > 0 && (
                        <p className="pt-2 text-xs leading-snug text-ink-faint">Threat: {a.threat.reasons.join(' · ')}</p>
                      )}
                    </div>
                  </Card>
                </div>
              )}

              {a && (
                <div className="grid gap-4 lg:grid-cols-3">
                  <InsightList title="Strengths" items={a.strengths} idx={idx} empty="No clear strengths in what was found." />
                  <InsightList title="Weaknesses" items={a.weaknesses} idx={idx} empty="No weaknesses showed up in the evidence." />
                  <InsightList title="How to win their customers" items={a.howToWin} idx={idx} empty="Scan more sources for specific advice." />
                </div>
              )}

              {counterPlay && profile && (
                <Card className="p-4">
                  <p className="text-[13px] font-medium text-ink">Make something from this</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Opens the composer with the “how to win” points as the brief. The competitor is never named in what is generated.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(counterPlay.destinations as PlayDestination[]).map((d) => (
                      <Link
                        key={d}
                        href={playHref(counterPlay, d, { businessType: profile.businessType })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink hover:border-line-strong hover:bg-surface-hover"
                      >
                        {PLAY_DESTINATION_LABEL[d]}
                      </Link>
                    ))}
                  </div>
                </Card>
              )}

              <Evidence s={s} />

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="What changed" description="Compared with the previous scan." />
                  <ul className="divide-y divide-line">
                    {history.length === 0 && <li className="px-5 py-3 text-[13px] text-ink-muted">No scans yet.</li>}
                    {history.map((h) => (
                      <li key={h.id} className="px-5 py-3">
                        <p className="text-xs text-ink-faint">
                          <RelativeTime date={h.createdAt} /> · <span className="font-mono">{h.snapshotHash.slice(0, 10)}</span>
                          {h.simulated && ' · simulated'}
                        </p>
                        {h.changes.length === 0 ? (
                          <p className="text-[13px] text-ink-muted">No changes{history[history.length - 1].id === h.id ? ' (first scan)' : ''}.</p>
                        ) : (
                          <ul className="mt-1 space-y-1">
                            {h.changes.map((c, i) => (
                              <li key={i} className="text-[13px] text-ink">
                                {c.significant && <Badge tone="warn">notable</Badge>} {c.summary}
                                {c.detail.length > 0 && <span className="block text-xs text-ink-muted">{c.detail.join(' · ')}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card>
                  <CardHeader
                    title="Where this came from"
                    description={`Scanned ${scan!.createdAt.toISOString().slice(0, 16).replace('T', ' ')} in ${Math.round((scan!.durationMs ?? 0) / 100) / 10}s.`}
                  />
                  <ul className="divide-y divide-line">
                    {s.sources.map((r, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 px-5 py-2.5">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-ink">{r.provider}</p>
                          {r.note && <p className="text-xs leading-snug text-ink-muted">{r.note}</p>}
                        </div>
                        <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </>
          )}
        </div>
      </PageBody>
    </>
  )
}

function EvidenceChips({ ids, idx }: { ids: string[]; idx: Map<string, { label: string; text: string; url: string | null }> }) {
  const items = ids.map((id) => [id, idx.get(id)] as const).filter(([, v]) => v)
  if (!items.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.map(([id, v]) =>
        v!.url ? (
          <a
            key={id}
            href={v!.url}
            target="_blank"
            rel="noreferrer noopener"
            title={v!.text}
            className="rounded bg-bg-inset px-1.5 py-0.5 text-2xs text-ink-muted hover:text-ink hover:underline"
          >
            {v!.label}
          </a>
        ) : (
          <span key={id} title={v!.text} className="rounded bg-bg-inset px-1.5 py-0.5 text-2xs text-ink-muted">
            {v!.label}
          </span>
        ),
      )}
    </div>
  )
}

function InsightList({
  title,
  items,
  idx,
  empty,
}: {
  title: string
  items: Insight[]
  idx: Map<string, { label: string; text: string; url: string | null }>
  empty: string
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <ul className="space-y-3 p-5">
        {items.length === 0 && <li className="text-[13px] text-ink-muted">{empty}</li>}
        {items.map((i, n) => (
          <li key={n}>
            <p className="text-[13px] leading-snug text-ink">{i.text}</p>
            <EvidenceChips ids={i.evidence} idx={idx} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Evidence({ s }: { s: PresenceSnapshot }) {
  const google = s.reviews.find((r) => r.source === 'google')
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Their search ads" description="Ads they ran on your searches when scanned." />
        <div className="space-y-3 p-5">
          {s.ads.length === 0 && (
            <p className="text-[13px] text-ink-muted">
              {s.sources.find((x) => x.source === 'serp')?.status === 'skipped'
                ? 'Not read: no search provider with ad data is connected. Use “Google ads they run” above to see them in Google’s Ads Transparency Center.'
                : 'None found on your searches.'}
            </p>
          )}
          {s.ads.map((ad, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <p className="text-2xs text-ink-faint">
                Sponsored · {ad.displayUrl ?? s.domain} · on “{ad.keyword}”
              </p>
              <p className="mt-0.5 text-[14px] font-medium text-info-fg">{ad.headline}</p>
              <p className="text-[13px] text-ink-muted">{ad.description}</p>
              {ad.claims.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {ad.claims.map((c: Claim) => (
                    <Badge key={c}>{CLAIM_LABEL[c]}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Their website" description={s.pages.length ? `${s.pages.length} page${s.pages.length === 1 ? '' : 's'} read; extracts only.` : undefined} />
        <div className="space-y-3 p-5">
          {s.pages.length === 0 && <p className="text-[13px] text-ink-muted">{s.sources.find((x) => x.source === 'website')?.note || 'Not read.'}</p>}
          {s.pages.map((p, i) => (
            <div key={i}>
              <p className="text-2xs uppercase tracking-wide text-ink-faint">{p.kind}</p>
              <p className="text-[13px] font-medium text-ink">{p.h1[0] ?? p.title}</p>
              {p.description && <p className="text-xs leading-snug text-ink-muted">{p.description}</p>}
              {(p.ctas.length > 0 || p.prices.length > 0) && (
                <p className="mt-0.5 text-xs text-ink-faint">
                  {p.prices.length > 0 && <>Prices: {p.prices.join(', ')}. </>}
                  {p.ctas.length > 0 && <>Asks visitors to: {p.ctas.slice(0, 4).join(', ')}.</>}
                </p>
              )}
            </div>
          ))}
          {s.trustSignals.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {s.trustSignals.map((t) => (
                <Badge key={t} tone="info">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          {(s.structured.foundingYear || s.company?.incorporatedOn) && (
            <p className="text-xs text-ink-faint">
              {s.structured.foundingYear && `Founded ${s.structured.foundingYear}. `}
              {s.company?.incorporatedOn && `Incorporated ${s.company.incorporatedOn} (${s.company.status ?? 'status unknown'}).`}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Where they rank" description="Google positions on your searches, and their biggest keywords." />
        <div className="p-5">
          {s.organic.length === 0 && s.topKeywords.length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              {s.sources.find((x) => x.source === 'serp')?.status === 'skipped' ? 'Not read: no search provider connected.' : 'Not on page two or better for your searches.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {s.organic.map((o, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-ink">{o.keyword}</span>
                  <span className="tnum shrink-0 text-ink-muted">#{o.position}</span>
                </li>
              ))}
              {s.topKeywords.slice(0, 10).map((k, i) => (
                <li key={`k${i}`} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-ink-muted">{k.keyword}</span>
                  <span className="tnum shrink-0 text-ink-faint">
                    #{k.position}
                    {k.volume ? ` · ${k.volume.toLocaleString('en-GB')}/mo` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Their blog"
          description={s.blog.posts.length ? `${s.blog.postsLast90Days} posts in the last 90 days${s.blog.feedUrl ? ', from their feed' : ''}.` : undefined}
        />
        <div className="p-5">
          {s.blog.posts.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No blog or feed found.</p>
          ) : (
            <ul className="space-y-1.5">
              {s.blog.posts.slice(0, 10).map((p) => (
                <li key={p.url} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <a href={p.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-ink hover:underline">
                    {p.title}
                  </a>
                  <span className="tnum shrink-0 text-xs text-ink-faint">{p.publishedAt?.slice(0, 10) ?? ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="What customers say"
          description={google?.rating ? `${google.rating}★ from ${google.count.toLocaleString('en-GB')} Google reviews.` : 'Google reviews.'}
        />
        <div className="space-y-3 p-5">
          {!google || google.samples.length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              {s.sources.find((x) => x.source === 'reviews')?.note || 'No reviews read.'}
            </p>
          ) : (
            google.samples.map((r, i) => (
              <div key={i} className="text-[13px]">
                <span className={r.rating <= 3 ? 'font-semibold text-danger-fg' : 'font-semibold text-ok-fg'}>{r.rating}★</span>{' '}
                <span className="text-ink-muted">{r.text}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Social and video" description="Profiles linked from their own site." />
        <div className="space-y-3 p-5">
          {s.social.length === 0 && <p className="text-[13px] text-ink-muted">No social profiles linked from their site.</p>}
          {s.social.map((p) => (
            <div key={p.network}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <a href={p.url} target="_blank" rel="noreferrer noopener" className="font-medium capitalize text-ink hover:underline">
                  {p.network === 'x' ? 'X' : p.network}
                </a>
                <span className="text-xs text-ink-faint">
                  {p.followers !== null ? `${p.followers.toLocaleString('en-GB')} followers` : p.depth === 'link' ? 'link only' : ''}
                </span>
              </div>
              {p.recent.slice(0, 3).map((r) => (
                <a key={r.url} href={r.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-ink-muted hover:underline">
                  {r.title}
                  {r.views !== null ? ` · ${r.views.toLocaleString('en-GB')} views` : ''}
                </a>
              ))}
            </div>
          ))}
          {s.news.length > 0 && (
            <div className="border-t border-line pt-3">
              <p className="label mb-1.5">In the news</p>
              {s.news.map((n) => (
                <a key={n.url} href={n.url} target="_blank" rel="noreferrer noopener" className="block text-xs text-ink-muted hover:underline">
                  {n.source}: {n.title}
                </a>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
