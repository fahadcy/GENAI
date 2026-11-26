'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Link2, MailPlus, ShieldQuestion, UserMinus, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar, Badge, Button, Card, CardHeader, Input, Select } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { PERMISSIONS, ROLE_DESCRIPTION, ROLE_LABEL, can, type Permission } from '@/lib/auth/rbac'
import type { Role } from '@/lib/db/schema'
import {
  changeMemberRole,
  inviteMember,
  removeMember,
  revokeInvitation,
} from '@/app/(app)/settings/actions'
import { CopyButton } from './bits'

const ROLES: Role[] = ['owner', 'admin', 'strategist', 'creator', 'approver', 'analyst']

export type MemberView = {
  membershipId: string
  userId: string
  name: string
  email: string
  jobTitle: string | null
  avatarHue: number
  role: Role
  joinedAt: string
  lastLoginAt: string | null
  assetsCreated: number
  decisions: number
  auditEvents: number
}

export type InviteView = {
  id: string
  email: string
  role: Role
  invitedByName: string | null
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
}

export function MemberTable({
  members,
  currentUserId,
  canManage,
  seats,
}: {
  members: MemberView[]
  currentUserId: string
  canManage: boolean
  seats: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<MemberView | null>(null)

  const setRole = async (member: MemberView, role: Role) => {
    setBusy(member.membershipId)
    try {
      const result = await changeMemberRole(member.membershipId, role)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const drop = async (member: MemberView) => {
    setBusy(member.membershipId)
    try {
      const result = await removeMember(member.membershipId)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setRemoving(null)
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  const overSeats = members.length > seats

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Members"
          description={`${members.length} of ${seats} seat${seats === 1 ? '' : 's'} in use. A role decides what someone can do everywhere in the product, including which approval steps they can clear.`}
          actions={
            overSeats && <Badge tone="warn">{members.length - seats} over plan</Badge>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-2 font-semibold">Person</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 text-right font-semibold">Assets</th>
                <th className="px-3 py-2 text-right font-semibold">Decisions</th>
                <th className="px-3 py-2 font-semibold">Last seen</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {members.map((m) => (
                <tr key={m.membershipId}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.name} hue={m.avatarHue} size={30} />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                          {m.name}
                          {m.userId === currentUserId && <Badge tone="neutral">You</Badge>}
                        </p>
                        <p className="truncate text-xs text-ink-muted">
                          {m.jobTitle ? `${m.jobTitle} · ` : ''}
                          {m.email}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {canManage ? (
                      <Select
                        value={m.role}
                        disabled={busy === m.membershipId}
                        aria-label={`Role for ${m.name}`}
                        className="h-8 w-44 py-1 text-[13px]"
                        onChange={(e) => void setRole(m, e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-[13px] text-ink">{ROLE_LABEL[m.role]}</span>
                    )}
                  </td>
                  <td className="tnum px-3 py-3 text-right text-[13px] text-ink-muted">
                    {m.assetsCreated}
                  </td>
                  <td className="tnum px-3 py-3 text-right text-[13px] text-ink-muted">{m.decisions}</td>
                  <td className="px-3 py-3 text-xs text-ink-muted">
                    {m.lastLoginAt ? <RelativeTime date={m.lastLoginAt} /> : 'never signed in'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {canManage && m.userId !== currentUserId && (
                      <button
                        type="button"
                        onClick={() => setRemoving(m)}
                        className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
                        aria-label={`Remove ${m.name}`}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {removing && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          size="sm"
          title={`Remove ${removing.name}?`}
          description="They lose access immediately. Everything they created, approved or changed stays on the record — the audit trail is append-only."
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={busy === removing.membershipId}
                onClick={() => void drop(removing)}
              >
                Remove access
              </Button>
            </>
          }
        >
          <ul className="space-y-1.5 text-[13px] text-ink-muted">
            <li>· {removing.assetsCreated} assets they created stay with their name on them.</li>
            <li>· {removing.decisions} approval decisions remain attributed to them.</li>
            <li>· {removing.auditEvents} audit events keep their actor id.</li>
          </ul>
        </Modal>
      )}
    </>
  )
}

/* ---------------------------------------------------------- invitations */

export function InvitePanel({
  invitations,
  canManage,
  seatsLeft,
}: {
  invitations: InviteView[]
  canManage: boolean
  seatsLeft: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [email, setEmail] = React.useState('')
  const [role, setRole] = React.useState<Role>('creator')
  const [busy, setBusy] = React.useState(false)
  const [link, setLink] = React.useState<string | null>(null)

  const pending = invitations.filter((i) => !i.acceptedAt && new Date(i.expiresAt) > new Date())

  const send = async () => {
    setBusy(true)
    try {
      const result = await inviteMember({ email, role })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEmail('')
        setLink(result.data?.link ?? null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    const result = await revokeInvitation(id)
    toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
    if (result.ok) router.refresh()
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Invitations"
        description="An invitation is a signed link with a role already attached. It expires after 14 days."
        icon={<MailPlus className="h-4 w-4" />}
        actions={
          seatsLeft <= 0 ? (
            <Badge tone="warn">No seats left</Badge>
          ) : (
            <Badge tone="neutral">{seatsLeft} seat{seatsLeft === 1 ? '' : 's'} free</Badge>
          )
        }
      />

      {canManage && (
        <div className="space-y-3 border-b border-line px-5 py-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <label htmlFor="invite-email" className="label block">
                Email address
              </label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                placeholder="name@company.com"
                className="h-8 py-1 text-[13px]"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && email.includes('@')) void send()
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="invite-role" className="label block">
                Role
              </label>
              <Select
                id="invite-role"
                value={role}
                className="h-8 w-44 py-1 text-[13px]"
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="primary" loading={busy} disabled={!email.includes('@')} onClick={send}>
              Invite
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">{ROLE_DESCRIPTION[role]}</p>

          {link && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-subtle px-3 py-2">
              <Link2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">{link}</code>
              <CopyButton value={link} label="Copy link" />
            </div>
          )}
        </div>
      )}

      {pending.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-ink-faint">
          No invitations outstanding.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {pending.map((inv) => (
            <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">{inv.email}</p>
                <p className="text-xs text-ink-muted">
                  {ROLE_LABEL[inv.role]}
                  {inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ''} ·{' '}
                  <span className="text-ink-faint">
                    expires <RelativeTime date={inv.expiresAt} />
                  </span>
                </p>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => void revoke(inv.id)}
                  className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
                  aria-label={`Revoke the invitation for ${inv.email}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ------------------------------------------------------ permission matrix */

/**
 * The permission matrix, rendered from the same `can()` the server enforces
 * with. It cannot drift from the real rules because it is the real rules.
 */
export function RoleMatrix({ headcount }: { headcount: Record<string, number> }) {
  const [open, setOpen] = React.useState(false)

  const groups: { label: string; permissions: Permission[] }[] = [
    { label: 'Content', permissions: PERMISSIONS.filter((p) => p.startsWith('asset:')) },
    {
      label: 'Planning and audiences',
      permissions: PERMISSIONS.filter((p) => p.startsWith('campaign:') || p.startsWith('segment:')),
    },
    {
      label: 'Governance',
      permissions: PERMISSIONS.filter(
        (p) => p.startsWith('approval:') || p === 'brand:manage' || p === 'audit:export',
      ),
    },
    {
      label: 'Delivery',
      permissions: PERMISSIONS.filter((p) => p.startsWith('schedule:') || p === 'recommendation:apply'),
    },
    {
      label: 'Administration',
      permissions: PERMISSIONS.filter(
        (p) => p === 'member:manage' || p === 'billing:manage' || p === 'connector:manage',
      ),
    },
  ]

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="What each role can do"
        description="Checks are deny-by-default. This table is generated from the permission matrix the server enforces, not maintained separately."
        icon={<ShieldQuestion className="h-4 w-4" />}
        actions={
          <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide detail' : 'Show every permission'}
          </Button>
        }
      />

      <div className="grid gap-px bg-line sm:grid-cols-2">
        {ROLES.map((role) => (
          <div key={role} className="bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold text-ink">{ROLE_LABEL[role]}</p>
              <Badge tone={headcount[role] ? 'neutral' : 'warn'} className="whitespace-nowrap">
                {headcount[role] ?? 0} {headcount[role] === 1 ? 'person' : 'people'}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{ROLE_DESCRIPTION[role]}</p>
          </div>
        ))}
      </div>

      {open && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[700px] text-left">
            <thead>
              <tr className="border-b border-line">
                <th className="px-5 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                  Permission
                </th>
                {ROLES.map((r) => (
                  <th
                    key={r}
                    className="px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-ink-faint"
                  >
                    {ROLE_LABEL[r].split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {groups.map((group) => (
                <React.Fragment key={group.label}>
                  <tr className="bg-bg-subtle">
                    <td colSpan={ROLES.length + 1} className="px-5 py-1.5">
                      <span className="label">{group.label}</span>
                    </td>
                  </tr>
                  {group.permissions.map((permission) => (
                    <tr key={permission}>
                      <td className="px-5 py-1.5 font-mono text-2xs text-ink-muted">{permission}</td>
                      {ROLES.map((r) => (
                        <td key={r} className="px-2 py-1.5 text-center">
                          {can(r, permission) ? (
                            <Check className="mx-auto h-3.5 w-3.5 text-ok-fg" />
                          ) : (
                            <span className={cn('mx-auto block h-1 w-1 rounded-full bg-line-strong')} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
