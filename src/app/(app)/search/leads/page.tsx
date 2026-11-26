import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { latestRun, loadLeadRows, loadProfile } from '@/lib/search/service'
import { NOT_A_PROSPECT } from '@/lib/serptwin'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { Card, EmptyState } from '@/components/ui/primitives'
import { LeadsTable, type LeadRowView } from '@/components/search/leads-table'

export const metadata: Metadata = { title: 'Enquiries' }

export default async function SearchLeadsPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const [rows, run, profile, notifications] = await Promise.all([
    loadLeadRows(wsId),
    latestRun(wsId),
    loadProfile(wsId),
    listNotifications(wsId, auth.user.id),
  ])
  const byId = new Map((run?.report.leads?.classified ?? []).map((c) => [c.id, c]))
  const services = new Map((profile?.services ?? []).map((s) => [s.id, s.name]))
  const view: LeadRowView[] = rows.slice(0, 400).map((r) => {
    const c = byId.get(r.externalId)
    return {
      id: r.id,
      externalId: r.externalId,
      receivedAt: r.receivedAt.toISOString(),
      when: formatWhen(r.receivedAt),
      source: r.source,
      searchTerm: r.searchTerm,
      message: r.message,
      location: r.locationCountry
        ? `${r.locationCountry}${r.locationArea ? ` ${r.locationArea}` : ''}`
        : null,
      outcome: r.outcome,
      lostReason: r.lostReason,
      contactAttempts: r.contactAttempts,
      respondedAt: r.firstResponseAt?.toISOString() ?? null,
      simulated: r.simulated,
      category: c?.category ?? null,
      evidence: c?.evidence ?? [],
      service: c?.serviceId && !NOT_A_PROSPECT.has(c.category) ? (services.get(c.serviceId) ?? null) : null,
      stale: !!run && r.updatedAt > run.createdAt,
    }
  })

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Enquiries"
        description="Every enquiry and what became of it. Sales record the outcome in their own words; the next analysis reads it"
        notifications={notifications}
      />
      <PageBody>
        <Link
          href="/search"
          className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> PPC &amp; SEO
        </Link>
        {view.length === 0 ? (
          <Card>
            <EmptyState
              title="No enquiries yet"
              description="Run the PPC & SEO analysis once. Until your enquiry form and CRM are connected, it stores example enquiries so you can see how the outcomes work."
            />
          </Card>
        ) : (
          <LeadsTable rows={view} canEdit={can(auth.role, 'search:analyse')} total={rows.length} />
        )}
      </PageBody>
    </>
  )
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Tue 15 Sep, 11:00" in UK time, built by hand so it is identical on every runtime. */
function formatWhen(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  const local = new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!))
  return `${DAYS[local.getUTCDay()]} ${+parts.day!} ${MONTHS[+parts.month! - 1]}, ${parts.hour}:${parts.minute}`
}
