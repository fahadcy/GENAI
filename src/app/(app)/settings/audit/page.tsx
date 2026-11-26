import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { PageBody } from '@/components/shell/page'
import { Avatar, Card, EmptyState } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { ActorBadge, AuditFilters, HashCell, IntegrityPanel } from '@/components/settings/audit-viewer'
import { auditLabel } from '@/components/settings/audit-labels'
import { AUDIT_PAGE_SIZE, auditFacets, auditFeed, governanceSummary } from '../queries'

export const metadata: Metadata = { title: 'Audit trail' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v || undefined

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const auth = await requireAuth()
  const params = await searchParams

  const filters = {
    action: one(params.action),
    actorId: one(params.actor),
    subjectType: one(params.subject),
    q: one(params.q),
    page: Number(one(params.page) ?? 1) || 1,
  }

  const [feed, facets, summary] = await Promise.all([
    auditFeed(auth.workspace.id, filters),
    auditFacets(auth.workspace.id),
    governanceSummary(auth.workspace.id),
  ])

  const canExport = can(auth.role, 'audit:export')
  const query = (page: number) => {
    const next = new URLSearchParams()
    if (filters.action) next.set('action', filters.action)
    if (filters.actorId) next.set('actor', filters.actorId)
    if (filters.subjectType) next.set('subject', filters.subjectType)
    if (filters.q) next.set('q', filters.q)
    if (page > 1) next.set('page', String(page))
    const s = next.toString()
    return s ? `/settings/audit?${s}` : '/settings/audit'
  }

  const from = (feed.page - 1) * AUDIT_PAGE_SIZE + 1
  const to = Math.min(feed.total, feed.page * AUDIT_PAGE_SIZE)

  return (
    <PageBody className="max-w-[1240px]">
      <IntegrityPanel
        totalEvents={summary.auditEvents}
        firstEventAt={summary.firstEventAt?.toISOString() ?? null}
        lastEventAt={summary.lastEventAt?.toISOString() ?? null}
        canExport={canExport}
      />

      <div className="mt-6">
        <AuditFilters
          actions={facets.actions.map((a) => ({
            ...a,
            label: auditLabel(a.action),
          }))}
          actors={facets.actors}
          subjects={facets.subjects}
          total={feed.total}
        />
      </div>

      <Card className="mt-3 overflow-hidden">
        {feed.rows.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-5 w-5" />}
            title={summary.auditEvents === 0 ? 'Nothing recorded yet' : 'No events match those filters'}
            description={
              summary.auditEvents === 0
                ? 'The trail fills itself. Generating an asset, requesting an approval, changing a brand rule or publishing anything all append an event automatically.'
                : 'Widen the filters, or clear them to see the whole trail.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead>
                <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-faint">
                  <th className="w-16 px-5 py-2 text-right font-semibold">Seq</th>
                  <th className="w-44 px-3 py-2 font-semibold">Actor</th>
                  <th className="w-48 px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">What happened</th>
                  <th className="w-32 px-3 py-2 font-semibold">When</th>
                  <th className="w-24 px-5 py-2 font-semibold">Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {feed.rows.map((row) => {
                  const payloadKeys = Object.keys(row.payload ?? {})
                  return (
                    <tr key={row.id} className="align-top">
                      <td className="tnum px-5 py-2.5 text-right text-xs text-ink-faint">{row.seq}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {row.actorName ? (
                            <>
                              <Avatar name={row.actorName} hue={row.actorHue ?? 250} size={20} />
                              <span className="truncate text-[13px] text-ink">{row.actorName}</span>
                            </>
                          ) : (
                            <span className="text-[13px] text-ink-faint">—</span>
                          )}
                          <ActorBadge actorType={row.actorType} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-[13px] font-medium text-ink">
                          {auditLabel(row.action)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-2xs text-ink-faint">
                          {row.subjectType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-[13px] leading-snug text-ink-muted">{row.summary}</p>
                        {payloadKeys.length > 0 && (
                          /* Native details — the payload is rarely opened and
                             does not justify shipping JS for every row. */
                          <details className="group mt-1">
                            <summary className="cursor-pointer list-none text-2xs text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
                              {payloadKeys.length} payload field
                              {payloadKeys.length === 1 ? '' : 's'} · show
                            </summary>
                            <pre className="mt-1 max-w-2xl overflow-x-auto rounded-lg bg-bg-inset p-2.5 font-mono text-2xs leading-relaxed text-ink-muted">
                              {JSON.stringify(row.payload, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-ink-muted">
                        <RelativeTime date={row.createdAt} />
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <HashCell hash={row.hash} prevHash={row.prevHash} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {feed.pages > 1 && (
          <div className="flex items-center justify-between border-t border-line bg-bg-subtle px-5 py-2.5">
            <p className="tnum text-2xs text-ink-faint">
              {from}–{to} of {feed.total.toLocaleString('en-GB')}
            </p>
            <div className="flex items-center gap-1">
              <PageLink href={query(feed.page - 1)} disabled={feed.page === 1} label="Previous">
                <ChevronLeft className="h-3.5 w-3.5" />
                Newer
              </PageLink>
              <span className="tnum px-2 text-2xs text-ink-faint">
                page {feed.page} of {feed.pages}
              </span>
              <PageLink href={query(feed.page + 1)} disabled={feed.page === feed.pages} label="Next">
                Older
                <ChevronRight className="h-3.5 w-3.5" />
              </PageLink>
            </div>
          </div>
        )}
      </Card>

      <p className="mt-4 max-w-3xl text-2xs leading-relaxed text-ink-faint">
        Audit events are append-only. GenAI has no code path that updates or deletes a recorded event, and
        the workspace advisory lock taken on every append means concurrent writers cannot fork the chain.
        Retention follows your plan; on Enterprise it follows your contract.
      </p>
    </PageBody>
  )
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  if (disabled) {
    return (
      <span className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-faint opacity-50">
        {children}
      </span>
    )
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {children}
    </Link>
  )
}
