import type { Metadata } from 'next'
import { Ban, Mail, MessageSquare, Users } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { hasClickSend, hasSendGrid } from '@/lib/env'
import { BASIS_BY_VALUE, type ConsentBasis } from '@/lib/contacts/consent'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, SectionHeading } from '@/components/shell/page'
import { Card, StatTile } from '@/components/ui/primitives'
import { ContactList } from '@/components/contacts/list'
import { ContactImport } from '@/components/contacts/import'
import { basisBreakdown, contactStats, listContacts, type ContactFilter } from './queries'

export const metadata: Metadata = { title: 'Contacts' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function ContactsPage({ searchParams }: { searchParams: SearchParams }) {
  const auth = await requireAuth()
  const params = await searchParams

  const q = one(params.q)?.slice(0, 120)
  const filter = (one(params.filter) ?? 'all') as ContactFilter
  const page = Math.max(1, Number(one(params.page)) || 1)

  const [list, stats, bases, notifications] = await Promise.all([
    listContacts(auth.workspace.id, { q, filter, page }),
    contactStats(auth.workspace.id),
    basisBreakdown(auth.workspace.id),
    listNotifications(auth.workspace.id, auth.user.id),
  ])

  const canManage = can(auth.role, 'contact:manage')

  /* The number worth leading with is not how many contacts there are, but how
     many of them a campaign would actually reach. */
  const unreachable = stats.total - stats.emailable
  const unexplained = bases.find((b) => b.basis === 'unknown')?.n ?? 0

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Contacts"
        description={`${stats.total.toLocaleString('en-GB')} on the list · ${stats.emailable.toLocaleString('en-GB')} can be emailed · consent recorded against every one`}
        notifications={notifications}
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="On the list"
            value={stats.total.toLocaleString('en-GB')}
            hint={`${stats.withPhone.toLocaleString('en-GB')} with a mobile number`}
            icon={<Users className="h-4 w-4" />}
          />
          <StatTile
            label="Can be emailed"
            value={stats.emailable.toLocaleString('en-GB')}
            hint={
              unreachable > 0
                ? `${unreachable.toLocaleString('en-GB')} cannot be — no permission or unsubscribed`
                : 'everyone on the list'
            }
            icon={<Mail className="h-4 w-4" />}
          />
          <StatTile
            label="Can be texted"
            value={stats.textable.toLocaleString('en-GB')}
            hint={
              stats.textable === 0
                ? 'needs an explicit opt-in and a mobile number'
                : 'opted in, with a usable number'
            }
            icon={<MessageSquare className="h-4 w-4" />}
          />
          <StatTile
            label="Unsubscribed"
            value={stats.suppressed.toLocaleString('en-GB')}
            hint={stats.suppressed === 0 ? 'nobody has opted out' : 'permanently excluded from every send'}
            icon={<Ban className="h-4 w-4" />}
          />
        </div>

        {(stats.noConsent > 0 || unexplained > 0) && (
          <Card className="mt-4 border-warn-fg/25 bg-warn-bg p-4">
            <p className="text-[13px] font-medium text-warn-fg">
              {stats.noConsent.toLocaleString('en-GB')} contact
              {stats.noConsent === 1 ? '' : 's'} cannot be sent anything yet
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-warn-fg/90">
              They are stored and can be segmented and reported on, but no campaign will go to them until
              somebody records why you are allowed to contact them. Filter the list by "No permission yet"
              to see who they are.
            </p>
          </Card>
        )}

        {!hasSendGrid() && !hasClickSend() && stats.total > 0 && (
          <Card className="mt-4 p-4">
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Email and text delivery are not connected yet, so campaigns to this list are recorded as
              simulated rather than sent. Settings → Integrations has the two keys it needs and a test
              send to prove they work.
            </p>
          </Card>
        )}

        <section className="mt-8">
          <SectionHeading
            title="The list"
            description="Everyone this workspace holds, and what you are permitted to send each of them."
          />
          <ContactList
            rows={list.rows}
            total={list.total}
            page={list.page}
            pages={list.pages}
            canManage={canManage}
          />
        </section>

        {canManage && (
          <section className="mt-8">
            <SectionHeading
              title="Import a spreadsheet"
              description="A CSV from Excel, Google Sheets, your CRM or your practice management system. Nothing is written until you have seen what will happen."
            />
            <ContactImport />
          </section>
        )}

        {bases.length > 0 && (
          <section className="mt-8">
            <SectionHeading
              title="Where the list came from"
              description="Kept because it is the answer to the only question that matters if anyone ever complains."
            />
            <Card className="p-4">
              <ul className="grid gap-2 sm:grid-cols-2">
                {bases.map((b) => {
                  const option = BASIS_BY_VALUE.get(b.basis as ConsentBasis)
                  return (
                    <li key={b.basis} className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="text-ink">{option?.label ?? 'Not recorded'}</span>
                      <span className="tabular-nums text-ink-muted">{b.n.toLocaleString('en-GB')}</span>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </section>
        )}
      </PageBody>
    </>
  )
}
