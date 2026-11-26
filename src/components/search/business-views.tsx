'use client'

import * as React from 'react'
import Link from 'next/link'
import { Copy, Download, FileText, Settings2, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { LEAD_CATEGORY_LABEL, TOPIC_LABEL, type LeadCategory, type SerpTwinReport } from '@/lib/serptwin'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'

/**
 * The three business-aware views: why leads fail, spend against profit and
 * capacity, and SEO chosen by real demand. Each shows its evidence first and
 * its recommendation below, so the number is never separated from the reason.
 */

const money = (n: number) => formatMoney(Math.round(n), 'GBP').replace(/\.00$/, '')
const money2 = (n: number) => formatMoney(n, 'GBP')
const pct = (n: number) => `${Math.round(n * 100)}%`
const SHORT: Partial<Record<LeadCategory, string>> = {
  spam: 'spam',
  wrong_service: 'wrong service',
  out_of_area: 'out of area',
  missed_follow_up: 'no reply in time',
}

/** Grouped so the bar reads as four stories: junk, lost, won, still unknown. */
const GROUPS: { label: string; tone: string; cats: LeadCategory[] }[] = [
  {
    label: 'Not real prospects',
    tone: 'rgb(var(--danger-fg))',
    cats: ['spam', 'wrong_service', 'out_of_area', 'unsuitable'],
  },
  { label: 'Not followed up in time', tone: 'rgb(var(--warn-fg))', cats: ['missed_follow_up'] },
  {
    label: 'Lost',
    tone: 'rgb(var(--ink-faint))',
    cats: ['lost_price', 'lost_timing', 'lost_competitor', 'lost_fit', 'lost_other'],
  },
  { label: 'Won', tone: 'rgb(var(--ok-fg))', cats: ['won'] },
  { label: 'Unknown yet', tone: 'rgb(var(--line-strong))', cats: ['unreachable', 'open'] },
]

export function NoBusinessData() {
  return (
    <Card className="p-5 text-[13px] leading-relaxed text-ink-muted">
      This view needs a business setup and enquiries with outcomes. Run the analysis again: the first run
      stores an example setup and example enquiries, which you can then edit in{' '}
      <Link className="font-medium text-brand-700 hover:underline" href="/search/setup">
        Business setup
      </Link>{' '}
      and{' '}
      <Link className="font-medium text-brand-700 hover:underline" href="/search/leads">
        Enquiries
      </Link>
      .
    </Card>
  )
}

export function BusinessLinks({ canExport }: { canExport: boolean }) {
  const cls =
    'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-hover'
  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/search/leads" className={cls}>
        <Users className="h-3.5 w-3.5" /> Enquiries and outcomes
      </Link>
      <Link href="/search/setup" className={cls}>
        <Settings2 className="h-3.5 w-3.5" /> Business setup
      </Link>
      {canExport && (
        <a href="/api/search/offline-conversions" className={cls}>
          <Download className="h-3.5 w-3.5" /> Verified conversions for Google Ads (CSV)
        </a>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- lead quality */

export function LeadQualityView({ report, recs }: { report: SerpTwinReport; recs: React.ReactNode }) {
  const l = report.leads
  if (!l) return <NoBusinessData />
  const total = Math.max(1, l.total)
  const groups = GROUPS.map((g) => ({ ...g, n: g.cats.reduce((s, c) => s + (l.counts[c] ?? 0), 0) }))

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Every enquiry, and what became of it. Google Ads counts every form sent as the same success. Here each
        one is sorted, with the evidence shown, into spam, wrong service, outside your area, not followed up
        in time, lost and why, or won. Someone who never answered the phone is marked unreachable, not bad.
      </p>

      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[14px] text-ink">
            Google counted <strong className="tnum">{l.paidEnquiries}</strong> paid enquiries as conversions.{' '}
            <strong className="tnum">{l.paidEnquiries - l.paidNotProspects}</strong> were real prospects.
          </p>
          <span className="text-xs text-ink-faint">{l.total} enquiries in total, paid and unpaid</span>
        </div>
        <div
          className="flex h-6 gap-0.5 overflow-hidden rounded"
          role="img"
          aria-label="Enquiries by outcome group"
        >
          {groups
            .filter((g) => g.n > 0)
            .map((g) => (
              <span
                key={g.label}
                title={`${g.label}: ${g.n}`}
                style={{ width: `${(g.n / total) * 100}%`, background: g.tone }}
              />
            ))}
        </div>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
          {groups.map((g) => (
            <div key={g.label} className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: g.tone }} />
                {g.label}
                <span className="tnum ml-auto text-ink-muted">{g.n}</span>
              </div>
              <ul className="mt-1 space-y-0.5 text-2xs text-ink-faint">
                {g.cats
                  .filter((c) => (l.counts[c] ?? 0) > 0)
                  .map((c) => (
                    <li key={c} className="flex justify-between gap-2">
                      <span className="truncate">{LEAD_CATEGORY_LABEL[c]}</span>
                      <span className="tnum">{l.counts[c]}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
        {l.winRateAnswered !== null && (
          <p className="text-[13px] text-ink-muted">
            Answered within the follow-up target:{' '}
            <strong className="text-ink">{pct(l.winRateAnswered)}</strong> became customers. Answered late or
            never: <strong className="text-ink">{pct(l.winRateMissed ?? 0)}</strong>.
          </p>
        )}
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {[
                'Where from',
                'Enquiries',
                'Real prospects',
                'Customers',
                'Spend',
                'Per enquiry',
                'Per real prospect',
                'Per customer',
                'Main problem',
              ].map((h, i) => (
                <th
                  key={h}
                  className={cn('label whitespace-nowrap px-3 py-2.5', i >= 1 && i <= 7 && 'text-right')}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {l.units.map((u) => {
              const problems = (
                ['spam', 'wrong_service', 'out_of_area', 'missed_follow_up'] as LeadCategory[]
              )
                .map((c) => ({ c, n: u.counts[c] ?? 0 }))
                .sort((a, b) => b.n - a.n)
              const main = problems[0]!
              const share = main.n / Math.max(1, u.enquiries)
              return (
                <tr key={u.key}>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">{u.label}</td>
                  <td className="tnum px-3 py-2 text-right">{u.enquiries}</td>
                  <td className="tnum px-3 py-2 text-right">{u.prospects}</td>
                  <td className="tnum px-3 py-2 text-right">{u.customers}</td>
                  <td className="tnum px-3 py-2 text-right">{u.cost > 0 ? money(u.cost) : '—'}</td>
                  <td className="tnum px-3 py-2 text-right">
                    {u.costPerEnquiry ? money(u.costPerEnquiry) : '—'}
                  </td>
                  <td className="tnum px-3 py-2 text-right font-semibold">
                    {u.costPerProspect ? money(u.costPerProspect) : '—'}
                  </td>
                  <td className="tnum px-3 py-2 text-right">
                    {u.costPerCustomer ? money(u.costPerCustomer) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {main.n > 0 && share >= 0.1 ? (
                      <Badge tone={main.c === 'missed_follow_up' ? 'warn' : 'danger'}>
                        {pct(share)} {SHORT[main.c]}
                      </Badge>
                    ) : (
                      <span className="text-xs text-ink-faint">none stands out</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <div className="space-y-2.5">{recs}</div>
    </div>
  )
}

/* ------------------------------------------------------- budget & capacity */

export function BudgetView({ report, recs }: { report: SerpTwinReport; recs: React.ReactNode }) {
  const plans = report.budgets
  if (!plans) return <NoBusinessData />
  const maxPpp = Math.max(2, ...plans.map((p) => p.profitPerPoundInterval?.[1] ?? 0))
  const x = (v: number) => `${Math.min(100, (v / maxPpp) * 100)}%`
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Spend set against what each service earns and what the team can take on this week. Close rates come
        from real outcomes, pulled toward the business-wide rate so a service with a handful of enquiries is
        not judged on luck. Moves stay within the weekly limit in Business setup, and each one goes through
        approval.
      </p>
      <div className="grid gap-3 lg:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.serviceId} className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">{p.name}</h3>
              <Badge tone={p.decision === 'increase' ? 'ok' : p.decision === 'reduce' ? 'warn' : 'neutral'}>
                {p.decision === 'increase' ? 'Test more' : p.decision === 'reduce' ? 'Ease off' : 'Hold'}
              </Badge>
            </div>
            <div className="tnum text-[13px] text-ink">
              {money(p.weeklySpend)}/wk
              {p.decision !== 'hold' && (
                <>
                  {' '}
                  → <strong>{money(p.proposedWeeklySpend)}/wk</strong>
                </>
              )}
            </div>
            <div>
              <div className="label mb-1">Profit per £1 of ad spend (90% range)</div>
              {p.profitPerPoundInterval ? (
                <>
                  <div
                    className="relative h-3 rounded bg-bg-inset"
                    role="img"
                    aria-label={`Between ${money2(p.profitPerPoundInterval[0])} and ${money2(p.profitPerPoundInterval[1])}`}
                  >
                    <span
                      className="absolute inset-y-0 w-px bg-ink-faint"
                      style={{ left: x(1) }}
                      title="Break-even: £1 back per £1"
                    />
                    <span
                      className="absolute inset-y-0.5 rounded bg-brand-600/70"
                      style={{
                        left: x(p.profitPerPoundInterval[0]),
                        width: `calc(${x(p.profitPerPoundInterval[1])} - ${x(p.profitPerPoundInterval[0])})`,
                      }}
                    />
                  </div>
                  <div className="tnum mt-1 flex justify-between text-2xs text-ink-faint">
                    <span>
                      {money2(p.profitPerPoundInterval[0])} – {money2(p.profitPerPoundInterval[1])}
                    </span>
                    <span>line = break-even</span>
                  </div>
                </>
              ) : (
                <span className="text-xs text-ink-faint">No spend</span>
              )}
            </div>
            <div>
              <div className="label mb-1">Capacity this week</div>
              {p.weeklyCapacity === null ? (
                <span className="text-xs text-ink-muted">No practical limit</span>
              ) : (
                <>
                  <div className="flex gap-0.5">
                    {Array.from({ length: p.weeklyCapacity }, (_, i) => (
                      <span
                        key={i}
                        className={cn(
                          'h-3 flex-1 rounded-sm',
                          i < p.bookedThisWeek ? 'bg-warn-fg' : 'bg-bg-inset',
                        )}
                      />
                    ))}
                  </div>
                  <div className="tnum mt-1 text-2xs text-ink-faint">
                    {p.bookedThisWeek} of {p.weeklyCapacity} booked · about{' '}
                    {p.expectedCustomersPerWeek.toFixed(1)} new customers a week from ads
                  </div>
                </>
              )}
            </div>
            <dl className="tnum grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-ink-faint">Outcomes known</dt>
              <dd className="text-right text-ink">{p.decided}</dd>
              <dt className="text-ink-faint">Close rate</dt>
              <dd className="text-right text-ink">
                {pct(p.closeRate)} ({pct(p.closeRateInterval[0])}–{pct(p.closeRateInterval[1])})
              </dd>
              <dt className="text-ink-faint">Profit per customer</dt>
              <dd className="text-right text-ink">{money(p.marginPerCustomer)}</dd>
            </dl>
            <p className="text-xs leading-relaxed text-ink-muted">{p.reason}</p>
          </Card>
        ))}
      </div>
      <div className="space-y-2.5">{recs}</div>
    </div>
  )
}

/* ---------------------------------------------------------- SEO priorities */

export function SeoPrioritiesView({
  report,
  briefLinks,
}: {
  report: SerpTwinReport
  briefLinks: Record<string, string | null>
}) {
  const toast = useToast()
  const items = report.seo
  if (!items) return <NoBusinessData />
  const top = items.slice(0, 3)
  const rest = items.slice(3, 9)
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
        Three pieces of SEO work for this week, picked from the questions people ask in enquiries, the reasons
        sales were lost, and the searches that bring paid and organic traffic, weighted by what each service
        earns and which ones you want to grow. Each comes with an outline to edit. A better page may not move
        rankings; measure qualified enquiries to it before and after, and do not read a later rise as proof.
      </p>
      {top.map((a, i) => (
        <SeoCard
          key={a.id}
          rank={i + 1}
          action={a}
          briefHref={briefLinks[a.id] ?? null}
          onCopy={(t) => copy(t, toast)}
        />
      ))}
      {rest.length > 0 && (
        <Card>
          <CardHeader
            title="Also considered"
            description="Ranked lower this week. They will move up if the evidence grows."
          />
          <ul className="divide-y divide-line">
            {rest.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5 text-[13px]">
                <span className="text-ink">
                  {TOPIC_LABEL[a.topic]} — {a.serviceName}
                </span>
                <span className="tnum text-xs text-ink-faint">
                  asked {a.askedInEnquiries} · lost over it {a.lostOverIt} · search impressions{' '}
                  {a.searchImpressions.toLocaleString('en-GB')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function SeoCard({
  rank,
  action: a,
  briefHref,
  onCopy,
}: {
  rank: number
  action: NonNullable<SerpTwinReport['seo']>[number]
  briefHref: string | null
  onCopy: (text: string) => void
}) {
  const [draft, setDraft] = React.useState(
    `${a.draft.title}\n\n${a.draft.outline.map((l) => `- ${l}`).join('\n')}`,
  )
  return (
    <Card>
      <CardHeader
        title={`${rank}. ${TOPIC_LABEL[a.topic]} — ${a.serviceName}`}
        description={
          a.page
            ? `Page: ${new URL(a.page).pathname}${a.pageAlreadyCovers ? ' (touches on it, does not answer it)' : ' (does not answer it)'}`
            : 'No page answers it yet'
        }
        actions={<Badge tone="warn">hypothesis</Badge>}
      />
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-3 text-[13px]">
          <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-faint">Asked in enquiries</dt>
            <dd className="text-ink">{a.askedInEnquiries}</dd>
            <dt className="text-ink-faint">Sales lost over it</dt>
            <dd className="text-ink">{a.lostOverIt}</dd>
            <dt className="text-ink-faint">Search impressions</dt>
            <dd className="text-ink">{a.searchImpressions.toLocaleString('en-GB')}</dd>
            <dt className="text-ink-faint">Profit in sales lost over it</dt>
            <dd className="text-ink">{money(a.monthlyAtStake)}/mo</dd>
          </dl>
          <div>
            <div className="label mb-1">In their words</div>
            <ul className="space-y-1">
              {a.quotes.map((q) => (
                <li key={q} className="rounded-md bg-bg-inset px-2.5 py-1.5 text-xs text-ink">
                  {q.startsWith('Lost:') ? q : `“${q}”`}
                </li>
              ))}
            </ul>
          </div>
          {a.searches.length > 0 && (
            <p className="text-xs text-ink-muted">
              Related searches: {a.searches.map((s) => `“${s}”`).join(', ')}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor={`draft-${a.id}`}>
            Draft outline — edit freely; bracketed parts need your facts
          </label>
          <textarea
            id={`draft-${a.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={9}
            className="w-full rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-ink"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onCopy(draft)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-hover"
            >
              <Copy className="h-3.5 w-3.5" /> Copy outline
            </button>
            {briefHref && (
              <Link
                href={briefHref}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-solid px-3 text-[13px] font-medium text-brand-on hover:brightness-110"
              >
                <FileText className="h-3.5 w-3.5" /> Write it in Content Studio
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function copy(text: string, toast: ReturnType<typeof useToast>) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.push({ tone: 'ok', title: 'Copied', body: 'The outline is on your clipboard.' }))
    .catch(() =>
      toast.push({ tone: 'danger', title: 'Could not copy', body: 'Select the text and copy it instead.' }),
    )
}
