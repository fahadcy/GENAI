'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowUpRight, Clapperboard, FileText, Megaphone, PenLine, Plus, Quote } from 'lucide-react'
import { CLAIM_DEFINITION, CLAIM_LABEL } from '@/lib/serptwin/claims'
import { playHref } from '@/lib/competitors/plays'
import {
  CHANNEL_KEY_LABEL,
  DISCOVERY_SOURCE_LABEL,
  PLAY_DESTINATION_LABEL,
  type DiscoverySource,
  type LandscapeReport,
  type Play,
  type PlayDestination,
} from '@/lib/competitors/types'
import { addCompetitorAction, setCompetitorStatusAction } from '@/app/actions/competitors'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, type BadgeTone } from '@/components/ui/primitives'
import { Tabs, useToast } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { cn } from '@/lib/cn'
import { useRouter } from 'next/navigation'

export type CompetitorRow = {
  id: string
  name: string
  domain: string | null
  kind: string
  tier: string
  status: string
  relevance: number
  threat: number | null
  lastScannedAt: string | null
  rating: number | null
  reviews: number
  distanceKm: number | null
  simulated: boolean
  reasons: string[]
  sources: DiscoverySource[]
  advantage: string | null
  changes: string[]
}

/**
 * Three tabs, not seven.
 *
 * The old screen split one analysis across Plays, Competitors, Promises,
 * Search, Content, Complaints and Channels, which asked the reader to go
 * looking for the answer. There are really only three questions — who are
 * they, what should I do, and how do you know — so the five evidence tabs are
 * now sections stacked under one.
 */
type Tab = 'competitors' | 'plays' | 'evidence'

const THREAT_TONE = (n: number | null): BadgeTone => (n === null ? 'neutral' : n >= 60 ? 'danger' : n >= 35 ? 'warn' : 'ok')
const PRIORITY_TONE: Record<Play['priority'], BadgeTone> = { high: 'danger', medium: 'warn', low: 'neutral' }
const DEST_ICON: Record<PlayDestination, React.ComponentType<{ className?: string }>> = {
  blog: FileText,
  landing_page: FileText,
  google_ads: Megaphone,
  meta_ads: Megaphone,
  video: Clapperboard,
  social: PenLine,
  email: PenLine,
}
const pct = (x: number) => `${Math.round(x * 100)}%`

export function Landscape({
  report,
  rows,
  canAnalyse,
  businessType,
  selfName,
  maxTracked,
}: {
  report: LandscapeReport | null
  rows: CompetitorRow[]
  canAnalyse: boolean
  businessType: string
  selfName: string
  maxTracked: number
}) {
  const tracked = rows.filter((r) => r.status === 'tracked')
  const [tab, setTab] = React.useState<Tab>('competitors')
  const name = (id: string) => (id === 'us' ? selfName : report?.names[id] ?? rows.find((r) => r.id === id)?.name ?? id)

  return (
    <div className="space-y-5">
      {report && <Overview report={report} selfName={selfName} name={name} />}

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { value: 'competitors', label: 'Competitors', count: tracked.length },
          ...(report ? [{ value: 'plays', label: 'What to do', count: report.plays.length }] : []),
          ...(report ? [{ value: 'evidence', label: 'Evidence' }] : []),
        ]}
      />

      {tab === 'competitors' && <CompetitorList rows={rows} canAnalyse={canAnalyse} maxTracked={maxTracked} />}
      {tab === 'plays' && report && <Plays report={report} businessType={businessType} name={name} />}
      {tab === 'evidence' && report && (
        <div className="space-y-8">
          <Section title="What they promise" hint="The claims they make that you do not.">
            <Claims report={report} name={name} />
          </Section>
          <Section title="Search" hint="Who wins the searches you care about.">
            <SearchGrid report={report} name={name} />
          </Section>
          <Section title="Content gaps" hint="Topics they cover and you do not.">
            <Content report={report} name={name} />
          </Section>
          <Section title="Customer complaints" hint="What their customers say goes wrong.">
            <Customers report={report} name={name} />
          </Section>
          <Section title="Channels" hint="Where they show up.">
            <Channels report={report} />
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="text-xs text-ink-faint">{hint}</p>
      </div>
      {children}
    </section>
  )
}

/* -------------------------------------------------------------- overview */

function Overview({ report, selfName, name }: { report: LandscapeReport; selfName: string; name: (id: string) => string }) {
  const sov = report.shareOfVoice.slice(0, 8)
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Where the market stands" description="Written over the measured facts below; every figure is from them." />
        <div className="space-y-4 p-5">
          <p className="text-[14px] leading-relaxed text-ink">{report.summary}</p>
          {report.differentiators.length > 0 && (
            <div>
              <p className="label mb-2">What {selfName} can own</p>
              <ul className="space-y-2">
                {report.differentiators.map((d, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    {d.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Share of your searches"
          description="Estimated share of clicks across your searches, from organic positions and ads."
        />
        <div className="space-y-2.5 p-5">
          {sov.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No search data. Connect a search provider to see who wins your searches.</p>
          ) : (
            sov.map((s) => (
              <div key={s.competitorId} className="flex items-center gap-3">
                <span className={cn('w-36 shrink-0 truncate text-[13px]', s.competitorId === 'us' ? 'font-semibold text-ink' : 'text-ink-muted')}>
                  {s.competitorId === 'us' ? `${selfName} (you)` : name(s.competitorId)}
                </span>
                <div className="relative h-2 flex-1 rounded-full bg-bg-inset">
                  <div
                    className={cn('absolute inset-y-0 left-0 rounded-full', s.competitorId === 'us' ? 'bg-brand-600' : 'bg-ink-faint/60')}
                    style={{ width: `${Math.max(2, s.share * 100)}%` }}
                  />
                </div>
                <span className="tnum w-10 shrink-0 text-right text-xs text-ink-muted">{pct(s.share)}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  )
}

/* ----------------------------------------------------------------- plays */

function Plays({ report, businessType, name }: { report: LandscapeReport; businessType: string; name: (id: string) => string }) {
  const [filter, setFilter] = React.useState<PlayDestination | 'all'>('all')
  const all = Object.keys(PLAY_DESTINATION_LABEL) as PlayDestination[]
  const counts = Object.fromEntries(all.map((d) => [d, report.plays.filter((p) => p.destinations.includes(d)).length]))
  const shown = filter === 'all' ? report.plays : report.plays.filter((p) => p.destinations.includes(filter))
  if (report.plays.length === 0) {
    return (
      <Card>
        <EmptyState title="No plays yet" description="Track and scan more competitors; plays come from the gaps between them and you." />
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-muted">
        Each play opens the right composer prefilled. What you make there is scored and approved like anything else — nothing here publishes.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(['all', ...all.filter((d) => counts[d] > 0)] as const).map((d) => (
          <button
            key={d}
            onClick={() => setFilter(d)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              filter === d ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            {d === 'all' ? 'All' : PLAY_DESTINATION_LABEL[d]} <span className="tnum text-ink-faint">{d === 'all' ? report.plays.length : counts[d]}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {shown.map((p) => (
          <Card key={p.id} className="flex flex-col p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[14px] font-semibold leading-snug text-ink">{p.title}</h3>
              <Badge tone={PRIORITY_TONE[p.priority]}>{p.priority}</Badge>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{p.why}</p>
            {p.evidence.some((e) => e.startsWith('http')) && (
              <ul className="mt-2 space-y-0.5">
                {p.evidence
                  .filter((e) => e.startsWith('http'))
                  .slice(0, 3)
                  .map((u) => (
                    <li key={u} className="truncate text-xs">
                      <a href={u} target="_blank" rel="noreferrer noopener" className="text-ink-faint hover:text-ink hover:underline">
                        {u.replace(/^https?:\/\//, '')}
                      </a>
                    </li>
                  ))}
              </ul>
            )}
            {p.evidence.some((e) => !e.startsWith('http')) && (
              <p className="mt-2 text-xs text-ink-faint">
                From:{' '}
                {Array.from(new Set(p.evidence.filter((e) => !e.startsWith('http')).map((e) => e.split(':')[0])))
                  .slice(0, 5)
                  .map((id) => name(id))
                  .join(', ')}
              </p>
            )}
            <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
              {p.destinations.map((d) => {
                const Icon = DEST_ICON[d]
                return (
                  <Link
                    key={d}
                    href={playHref(p, d, { businessType })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink hover:border-line-strong hover:bg-surface-hover"
                  >
                    <Icon className="h-3.5 w-3.5 text-ink-faint" />
                    {PLAY_DESTINATION_LABEL[d]}
                  </Link>
                )
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- competitors */

/**
 * The competitor list.
 *
 * The old table had seven columns and three status pills, and gave a verified
 * rival and a mis-matched accountant exactly the same row. This shows the
 * three groups that mean different things — the ones you track, the ones
 * offered to you, and the ones ruled out — and puts the reason each business
 * is in its group where it can be read.
 */
function CompetitorList({
  rows,
  canAnalyse,
  maxTracked,
}: {
  rows: CompetitorRow[]
  canAnalyse: boolean
  maxTracked: number
}) {
  const [showRuledOut, setShowRuledOut] = React.useState(false)
  const tracked = rows.filter((r) => r.status === 'tracked')
  const suggested = rows.filter((r) => r.status === 'suggested' && r.kind !== 'referral')
  const ruledOut = rows.filter((r) => r.status === 'dismissed' || (r.status === 'suggested' && r.kind === 'referral'))
  const full = tracked.length >= maxTracked

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- tracked */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              Your competitors{' '}
              <span className={cn('tnum text-sm font-normal', full ? 'text-warn-fg' : 'text-ink-faint')}>
                {tracked.length} of {maxTracked}
              </span>
            </h2>
            <p className="text-xs text-ink-faint">
              {full
                ? 'All slots used. Stop tracking one to make room for another.'
                : 'These are scanned, scored and compared. Every slot costs one scan.'}
            </p>
          </div>
          {canAnalyse && <AddCompetitor full={full} maxTracked={maxTracked} />}
        </div>
        {tracked.length === 0 ? (
          <Card>
            <EmptyState
              title="Not tracking anyone yet"
              description="Track one of the suggestions below, or add a competitor by its web address."
            />
          </Card>
        ) : (
          <div className="grid gap-2">
            {tracked.map((r) => (
              <CompetitorCard key={r.id} r={r} canAnalyse={canAnalyse} />
            ))}
          </div>
        )}
      </section>

      {/* ----------------------------------------------------- suggested */}
      {suggested.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              Suggested <span className="tnum text-sm font-normal text-ink-faint">{suggested.length}</span>
            </h2>
            <p className="text-xs text-ink-faint">
              Found by searching and then confirmed by reading their website. Track the ones that matter.
            </p>
          </div>
          <div className="grid gap-2">
            {suggested.map((r) => (
              <CompetitorCard key={r.id} r={r} canAnalyse={canAnalyse} disabled={full} />
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------ ruled out */}
      {ruledOut.length > 0 && (
        <section className="space-y-3">
          <button
            onClick={() => setShowRuledOut((v) => !v)}
            className="text-[13px] font-medium text-ink-muted hover:text-ink"
          >
            {showRuledOut ? 'Hide' : 'Show'} the {ruledOut.length} ruled out
            <span className="ml-1 font-normal text-ink-faint">— the trade next door, and ones you dismissed</span>
          </button>
          {showRuledOut && (
            <div className="grid gap-2">
              {ruledOut.map((r) => (
                <CompetitorCard key={r.id} r={r} canAnalyse={canAnalyse} disabled={full} muted />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function CompetitorCard({
  r,
  canAnalyse,
  disabled,
  muted,
}: {
  r: CompetitorRow
  canAnalyse: boolean
  disabled?: boolean
  muted?: boolean
}) {
  const why = r.reasons[0] ?? r.sources.map((s) => DISCOVERY_SOURCE_LABEL[s]).join(', ')
  return (
    <Card className={cn('p-3.5', muted && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/competitors/${r.id}`} className="text-[14px] font-semibold text-ink hover:underline">
              {r.name}
            </Link>
            {r.kind === 'referral' && <Badge tone="neutral">Referral partner</Badge>}
            {r.tier === 'local' && r.kind !== 'referral' && <Badge tone="neutral">Local</Badge>}
            {r.simulated && <Badge tone="warn">Simulated</Badge>}
          </div>
          <p className="text-xs text-ink-faint">
            {r.domain ?? 'no website'}
            {r.distanceKm !== null && ` · ${r.distanceKm} km away`}
            {r.rating !== null && ` · ${r.rating.toFixed(1)}★ ${r.reviews}`}
          </p>
          {why && <p className="mt-1.5 max-w-[60ch] text-xs leading-snug text-ink-muted">{why}</p>}
          {r.advantage && <p className="mt-1 max-w-[60ch] text-xs leading-snug text-ink-muted">{r.advantage}</p>}
          {r.changes.length > 0 && (
            <p className="mt-1 text-xs font-medium text-warn-fg">Changed: {r.changes.join('; ').toLowerCase()}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="tnum text-[13px] font-semibold text-ink">{r.relevance}</div>
            <div className="label text-[10px] text-ink-faint">match</div>
          </div>
          {r.threat !== null && (
            <div className="text-right">
              <Badge tone={THREAT_TONE(r.threat)}>{r.threat}</Badge>
              <div className="label mt-0.5 text-[10px] text-ink-faint">threat</div>
            </div>
          )}
          {canAnalyse && <StatusActions id={r.id} status={r.status} disabled={disabled} />}
        </div>
      </div>
    </Card>
  )
}

export function StatusActions({ id, status, disabled }: { id: string; status: string; disabled?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const act = async (next: 'tracked' | 'suggested' | 'dismissed') => {
    setBusy(next)
    try {
      const r = await setCompetitorStatusAction(id, next)
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Updated' : 'Not updated', body: r.message })
      if (r.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }
  return (
    <span className="inline-flex gap-1">
      {status !== 'tracked' && (
        <Button
          size="xs"
          variant="secondary"
          loading={busy === 'tracked'}
          disabled={disabled}
          title={disabled ? 'All tracking slots are used' : undefined}
          onClick={() => act('tracked')}
        >
          Track
        </Button>
      )}
      {status === 'tracked' && (
        <Button size="xs" variant="ghost" loading={busy === 'suggested'} onClick={() => act('suggested')}>
          Stop tracking
        </Button>
      )}
      {status !== 'dismissed' && (
        <Button size="xs" variant="ghost" loading={busy === 'dismissed'} onClick={() => act('dismissed')}>
          Not a competitor
        </Button>
      )}
    </span>
  )
}

function AddCompetitor({ full, maxTracked }: { full: boolean; maxTracked: number }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [domain, setDomain] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled={full}
        title={full ? `You are already tracking ${maxTracked}` : undefined}
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        Add your own
      </Button>
    )
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await addCompetitorAction({ name, domain })
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Added' : 'Not added', body: r.message })
      if (r.ok) {
        setName('')
        setDomain('')
        setOpen(false)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Begbies Traynor" autoFocus />
        </Field>
        <Field label="Website" hint="Their public site is read even with no API keys.">
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="begbies-traynorgroup.com" />
        </Field>
        <div className="flex gap-2 pb-5">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={name.trim().length < 2}>
            Add and track
          </Button>
        </div>
      </form>
    </Card>
  )
}

/* ---------------------------------------------------------------- claims */

function Claims({ report, name }: { report: LandscapeReport; name: (id: string) => string }) {
  const ids = report.competitorIds
  const n = Math.max(1, ids.length)
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-muted">
        The promises each business makes in its ads and on its site, read with the same claim taxonomy as PPC &amp; SEO. A promise
        everyone makes no longer sets anyone apart; one nobody makes is an opening.
      </p>
      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="label px-3 py-2.5">Promise</th>
              <th className="label px-3 py-2.5 text-center">You</th>
              {ids.map((id) => (
                <th key={id} className="label max-w-[110px] truncate px-2 py-2.5 text-center" title={name(id)}>
                  {name(id).split(' ').slice(0, 2).join(' ')}
                </th>
              ))}
              <th className="label px-3 py-2.5 text-right">Used by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {report.claims.map((c) => (
              <tr key={c.claim}>
                <td className="min-w-[200px] px-3 py-2">
                  <span className="font-medium text-ink">{CLAIM_LABEL[c.claim]}</span>
                  <span className="block text-xs text-ink-faint">{CLAIM_DEFINITION[c.claim]}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  {c.us === null ? <span className="text-ink-faint">?</span> : c.us ? <Dot on /> : <Dot />}
                </td>
                {ids.map((id) => (
                  <td key={id} className="px-2 py-2 text-center">
                    <Dot on={Boolean(c.byCompetitor[id])} />
                  </td>
                ))}
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Badge tone={c.competitorsUsing / n >= 0.5 ? 'neutral' : c.competitorsUsing === 0 ? 'ok' : 'info'}>
                    {c.competitorsUsing}/{ids.length}
                    {c.competitorsUsing / n >= 0.5 ? ' crowded' : c.competitorsUsing <= 1 ? ' open' : ''}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function Dot({ on }: { on?: boolean }) {
  return (
    <span
      className={cn('inline-block h-2.5 w-2.5 rounded-full', on ? 'bg-brand-600' : 'bg-bg-inset ring-1 ring-inset ring-line')}
      aria-label={on ? 'yes' : 'no'}
    />
  )
}

/* ---------------------------------------------------------------- search */

function SearchGrid({ report, name }: { report: LandscapeReport; name: (id: string) => string }) {
  const ids = report.competitorIds
  const hasData = report.search.some((r) => r.usOrganic !== null || r.usPaid || r.cells.some((c) => c.organic !== null || c.paid))
  if (!hasData) {
    return (
      <Card>
        <EmptyState
          title="No search data"
          description="Add a search provider (DataForSEO, SerpApi or Serper) to see who ranks and who advertises on each of your searches."
        />
      </Card>
    )
  }
  const cell = (organic: number | null, paid: boolean) => (
    <span className="inline-flex items-center gap-1">
      {organic !== null ? (
        <span className={cn('tnum rounded px-1.5 py-0.5 text-2xs font-semibold', organic <= 3 ? 'bg-ok-bg text-ok-fg' : organic <= 10 ? 'bg-info-bg text-info-fg' : 'bg-bg-inset text-ink-faint')}>
          #{organic}
        </span>
      ) : (
        <span className="text-ink-faint">·</span>
      )}
      {paid && <span className="rounded bg-warn-bg px-1 py-0.5 text-2xs font-semibold text-warn-fg">Ad</span>}
    </span>
  )
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="label px-3 py-2.5">Search</th>
            <th className="label px-3 py-2.5 text-center">You</th>
            {ids.map((id) => (
              <th key={id} className="label max-w-[110px] truncate px-2 py-2.5 text-center" title={name(id)}>
                {name(id).split(' ').slice(0, 2).join(' ')}
              </th>
            ))}
            <th className="label px-3 py-2.5 text-right">On page one</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.search.map((r) => (
            <tr key={r.keyword}>
              <td className="min-w-[180px] px-3 py-2 font-medium text-ink">{r.keyword}</td>
              <td className="px-3 py-2 text-center">{cell(r.usOrganic, r.usPaid)}</td>
              {r.cells.map((c) => (
                <td key={c.competitorId} className="px-2 py-2 text-center">
                  {cell(c.organic, c.paid)}
                </td>
              ))}
              <td className="tnum px-3 py-2 text-right text-ink-muted">{r.crowding}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/* --------------------------------------------------------------- content */

function Content({ report, name }: { report: LandscapeReport; name: (id: string) => string }) {
  if (report.content.length === 0) {
    return (
      <Card>
        <EmptyState title="No competitor content found" description="None of the tracked competitors publishes a blog or feed we could read." />
      </Card>
    )
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {report.content.map((t) => (
        <Card key={t.topic} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-[14px] font-semibold text-ink">{t.topic}</h3>
            {t.weCover ? <Badge tone="ok">You cover this</Badge> : <Badge tone="warn">Gap</Badge>}
          </div>
          <p className="mt-1 text-xs text-ink-faint">Published by {t.competitors.map(name).join(', ')}</p>
          <ul className="mt-3 space-y-1.5">
            {t.examples.map((e) => (
              <li key={e.url} className="text-[13px] leading-snug">
                <a href={e.url} target="_blank" rel="noreferrer noopener" className="group inline-flex items-start gap-1 text-ink hover:underline">
                  {e.title}
                  <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint group-hover:text-ink" />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- customers */

function Customers({ report, name }: { report: LandscapeReport; name: (id: string) => string }) {
  if (report.painPoints.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No complaints found"
          description="Complaints come from competitors' low-star Google reviews. Connect Google Places to read them."
        />
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-muted">
        What competitors&rsquo; customers complain about in 1–3 star reviews. Each one is a promise you can make and keep — without
        mentioning anyone else.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {report.painPoints.map((p) => (
          <Card key={p.theme} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-ink">{p.label}</h3>
              <Badge tone={p.competitors.length >= 2 ? 'danger' : 'warn'}>
                {p.mentions} review{p.mentions === 1 ? '' : 's'}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-ink-faint">About {p.competitors.map(name).join(', ')}</p>
            <ul className="mt-3 space-y-2">
              {p.quotes.map((q, i) => (
                <li key={i} className="flex gap-2 text-[13px] italic leading-snug text-ink-muted">
                  <Quote className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
                  {q}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- channels */

function Channels({ report }: { report: LandscapeReport }) {
  const n = Math.max(1, report.competitorIds.length)
  const LEVEL = ['None', 'Present', 'Active', 'Strong']
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="label px-3 py-2.5">Channel</th>
            <th className="label px-3 py-2.5">Competitors active</th>
            <th className="label px-3 py-2.5">You</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.channels.map((c) => (
            <tr key={c.channel}>
              <td className="px-3 py-2.5 font-medium text-ink">{CHANNEL_KEY_LABEL[c.channel]}</td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="relative h-2 w-40 rounded-full bg-bg-inset">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-ink-faint/60" style={{ width: `${(c.competitorsActive / n) * 100}%` }} />
                  </div>
                  <span className="tnum text-xs text-ink-muted">
                    {c.competitorsActive} of {report.competitorIds.length}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <Badge tone={c.us >= 2 ? 'ok' : c.competitorsActive / n >= 0.5 ? 'warn' : 'neutral'}>{LEVEL[c.us]}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
