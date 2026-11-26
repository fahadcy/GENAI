import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Building2, ScrollText } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/lib/auth/rbac'
import { PageBody } from '@/components/shell/page'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'
import { PasswordCard, ProfileForm, SessionList } from '@/components/settings/profile'
import { auditLabel } from '@/components/settings/audit-labels'
import { accountProfile } from '../queries'

export const metadata: Metadata = { title: 'Your profile' }

export default async function ProfilePage() {
  const auth = await requireAuth()
  const data = await accountProfile(auth.user.id, auth.workspace.id, auth.sessionId)
  if (!data) notFound()

  const joined = data.memberships.find((m) => m.workspaceId === auth.workspace.id)

  return (
    <PageBody className="max-w-[1100px]">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <ProfileForm
            initial={{
              name: data.user.name,
              jobTitle: data.user.jobTitle ?? '',
              avatarHue: data.user.avatarHue,
              email: data.user.email,
            }}
          />

          <PasswordCard hasPassword={data.user.hasPassword} ssoSubject={data.user.ssoSubject} />

          <SessionList
            sessions={data.sessions.map((s) => ({
              id: s.id,
              userAgent: s.userAgent,
              ip: s.ip,
              createdAt: s.createdAt.toISOString(),
              expiresAt: s.expiresAt.toISOString(),
              current: s.current,
            }))}
          />
        </div>

        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader
              title="Your access"
              description="A role is granted per workspace, so the same account can hold different permissions in each."
              icon={<Building2 className="h-4 w-4" />}
            />
            <ul className="divide-y divide-line">
              {data.memberships.map((m) => (
                <li key={m.workspaceId} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{m.workspaceName}</span>
                    <Badge tone={m.workspaceId === auth.workspace.id ? 'brand' : 'neutral'}>
                      {ROLE_LABEL[m.role]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{ROLE_DESCRIPTION[m.role]}</p>
                  <p className="mt-1 text-2xs text-ink-faint">
                    member since{' '}
                    {m.joinedAt.toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          {/* Contribution counts, so "what have I actually done here" has an
              answer that is not a feeling. */}
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">
                Your work in {auth.workspace.name}
              </h2>
              {joined && (
                <p className="mt-0.5 text-[13px] text-ink-muted">
                  Since{' '}
                  {joined.joinedAt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
                  {data.user.lastLoginAt && (
                    <>
                      {' · last signed in '}
                      <RelativeTime date={data.user.lastLoginAt} />
                    </>
                  )}
                </p>
              )}
            </div>
            <dl className="grid grid-cols-2 divide-x divide-y divide-line">
              <Figure label="Assets created" value={data.contribution.assets} />
              <Figure label="Approval decisions" value={data.contribution.decisions} />
              <Figure label="Campaigns owned" value={data.contribution.campaigns} />
              <Figure label="Segments built" value={data.contribution.segments} />
            </dl>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Your last actions"
              description="Read from the audit trail. These entries cannot be edited or removed, including by you."
              icon={<ScrollText className="h-4 w-4" />}
              actions={
                <Link
                  href={`/settings/audit?actor=${data.user.id}`}
                  className="text-xs font-medium text-ink-muted transition-colors hover:text-ink"
                >
                  All of them
                </Link>
              }
            />
            {data.activity.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-ink-faint">
                Nothing recorded against your account in this workspace yet.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {data.activity.map((a) => (
                  <li key={a.seq} className="px-5 py-2.5">
                    <p className="text-[13px] leading-snug text-ink">
                      {auditLabel(a.action)}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-muted">{a.summary}</p>
                    <p className="mt-1 text-2xs text-ink-faint">
                      #{a.seq} · <RelativeTime date={a.createdAt} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </PageBody>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-5 py-3.5">
      <dt className="label">{label}</dt>
      <dd className="tnum mt-1 text-xl font-semibold leading-none tracking-tight text-ink">{value}</dd>
    </div>
  )
}
