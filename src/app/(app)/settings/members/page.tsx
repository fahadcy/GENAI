import type { Metadata } from 'next'
import { CheckCircle2, MailPlus, UserCog, Users } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { PageBody } from '@/components/shell/page'
import { StatTile } from '@/components/ui/primitives'
import { InvitePanel, MemberTable, RoleMatrix } from '@/components/settings/members'
import { ReadOnlyNotice } from '@/components/settings/bits'
import { memberDirectory, pendingInvitations } from '../queries'

export const metadata: Metadata = { title: 'People' }

export default async function MembersPage() {
  const auth = await requireAuth()
  const [members, invitations] = await Promise.all([
    memberDirectory(auth.workspace.id),
    pendingInvitations(auth.workspace.id),
  ])

  const canManage = can(auth.role, 'member:manage')
  const seats = auth.workspace.seats
  const pending = invitations.filter((i) => !i.acceptedAt && i.expiresAt > new Date())
  const seatsLeft = Math.max(0, seats - members.length - pending.length)

  const headcount: Record<string, number> = {}
  for (const m of members) headcount[m.role] = (headcount[m.role] ?? 0) + 1

  const active30 = members.filter(
    (m) => m.lastLoginAt && Date.now() - m.lastLoginAt.getTime() < 30 * 86_400_000,
  ).length
  const approvers = members.filter((m) => can(m.role, 'approval:decide')).length

  return (
    <PageBody className="max-w-[1240px]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="People with access"
          value={members.length}
          hint={`${seats} seat${seats === 1 ? '' : 's'} on the plan`}
          icon={<Users className="h-4 w-4" />}
        />
        <StatTile
          label="Signed in this month"
          value={active30}
          hint={
            members.length > 0
              ? `${members.length - active30} dormant`
              : 'nobody has signed in yet'
          }
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatTile
          label="Can approve work"
          value={approvers}
          hint={approvers === 0 ? 'no chain could ever complete' : 'eligible for approval steps'}
          icon={<UserCog className="h-4 w-4" />}
        />
        <StatTile
          label="Invitations outstanding"
          value={pending.length}
          hint={seatsLeft === 0 ? 'no seats left on the plan' : `${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} free`}
          icon={<MailPlus className="h-4 w-4" />}
        />
      </div>

      {!canManage && (
        <div className="mt-6">
          <ReadOnlyNotice what="the member list" />
        </div>
      )}

      <div className="mt-6">
        <MemberTable
          canManage={canManage}
          currentUserId={auth.user.id}
          seats={seats}
          members={members.map((m) => ({
            membershipId: m.membershipId,
            userId: m.userId,
            name: m.name,
            email: m.email,
            jobTitle: m.jobTitle,
            avatarHue: m.avatarHue,
            role: m.role,
            joinedAt: m.joinedAt.toISOString(),
            lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
            assetsCreated: m.assetsCreated,
            decisions: m.decisions,
            auditEvents: m.auditEvents,
          }))}
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <RoleMatrix headcount={headcount} />
        <InvitePanel
          canManage={canManage}
          seatsLeft={seatsLeft}
          invitations={invitations.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            invitedByName: i.invitedByName,
            createdAt: i.createdAt.toISOString(),
            expiresAt: i.expiresAt.toISOString(),
            acceptedAt: i.acceptedAt?.toISOString() ?? null,
          }))}
        />
      </div>

    </PageBody>
  )
}
