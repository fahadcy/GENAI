'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Laptop, LogOut, UserRound } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar, Badge, Button, Card, CardHeader, Input } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { changeOwnPassword, revokeSession, updateOwnProfile } from '@/app/(app)/settings/actions'
import { SaveBar, SettingRow } from './bits'

/** A spread of hues that all read correctly against both themes' tint tokens. */
const HUES = [258, 210, 172, 128, 32, 348, 300, 15]

export function ProfileForm({
  initial,
}: {
  initial: { name: string; jobTitle: string; avatarHue: number; email: string }
}) {
  const router = useRouter()
  const toast = useToast()
  const [form, setForm] = React.useState(initial)
  const [baseline, setBaseline] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)

  const save = async () => {
    setSaving(true)
    try {
      const result = await updateOwnProfile({
        name: form.name,
        jobTitle: form.jobTitle,
        avatarHue: form.avatarHue,
      })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setBaseline(form)
        router.refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Your details"
          description="Your name appears on everything you create, approve or change — including entries in the audit trail that cannot be edited afterwards."
          icon={<UserRound className="h-4 w-4" />}
        />

        <SettingRow label="Name" htmlFor="profile-name">
          <Input
            id="profile-name"
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </SettingRow>

        <SettingRow
          label="Job title"
          hint="Shown next to your name in approval queues, so reviewers know who is asking."
          htmlFor="profile-title"
        >
          <Input
            id="profile-title"
            value={form.jobTitle}
            maxLength={80}
            placeholder="Head of Marketing"
            onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
          />
        </SettingRow>

        <SettingRow label="Email" hint="Used to sign in. Contact an owner to change it.">
          <div className="flex h-9 items-center rounded-lg border border-line bg-bg-subtle px-3 text-sm text-ink-muted">
            {form.email}
          </div>
        </SettingRow>

        <SettingRow label="Avatar colour" hint="Only the colour is yours to pick; the initials come from your name.">
          <div className="flex flex-wrap items-center gap-2">
            <Avatar name={form.name || '?'} hue={form.avatarHue} size={32} />
            <div className="flex flex-wrap gap-1.5">
              {HUES.map((hue) => (
                <button
                  key={hue}
                  type="button"
                  onClick={() => setForm({ ...form, avatarHue: hue })}
                  aria-label={`Avatar hue ${hue}`}
                  className={cn(
                    'tint h-6 w-6 rounded-full transition-transform',
                    form.avatarHue === hue ? 'ring-2 ring-brand-500 ring-offset-2 ring-offset-bg' : 'hover:scale-110',
                  )}
                  style={{ '--h': hue } as React.CSSProperties}
                />
              ))}
            </div>
          </div>
        </SettingRow>
      </Card>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        onReset={() => setForm(baseline)}
        summary="Your profile has changed."
      />
    </>
  )
}

/* -------------------------------------------------------------- password */

export function PasswordCard({ hasPassword, ssoSubject }: { hasPassword: boolean; ssoSubject: string | null }) {
  const toast = useToast()
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const mismatch = confirm.length > 0 && next !== confirm
  const ready = current.length > 0 && next.length >= 10 && next === confirm

  const submit = async () => {
    setBusy(true)
    try {
      const result = await changeOwnPassword(current, next)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setCurrent('')
        setNext('')
        setConfirm('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!hasPassword) {
    return (
      <Card className="overflow-hidden">
        <CardHeader title="Password" icon={<KeyRound className="h-4 w-4" />} />
        <p className="px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          This account signs in through your identity provider
          {ssoSubject ? ` (subject ${ssoSubject})` : ''}, so there is no password held here. Password
          policy, rotation and multi-factor are managed by that provider.
        </p>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Password"
        description="Changing it signs out every other session immediately."
        icon={<KeyRound className="h-4 w-4" />}
      />
      <div className="space-y-3 px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor="pw-current" className="text-[13px] font-medium text-ink">
            Current password
          </label>
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="pw-next" className="text-[13px] font-medium text-ink">
            New password
          </label>
          <Input
            id="pw-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <p className="text-xs text-ink-faint">
            At least 10 characters, mixed case, with a number.
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="pw-confirm" className="text-[13px] font-medium text-ink">
            Confirm new password
          </label>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="text-xs text-danger-fg">Those two do not match.</p>}
        </div>
        <Button size="sm" variant="primary" loading={busy} disabled={!ready} onClick={submit}>
          Change password
        </Button>
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------- sessions */

export function SessionList({
  sessions,
}: {
  sessions: { id: string; userAgent: string | null; ip: string | null; createdAt: string; expiresAt: string; current: boolean }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)

  const revoke = async (id: string) => {
    setBusy(id)
    try {
      const result = await revokeSession(id)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Where you are signed in"
        description="Sessions last 30 days. Ending one takes effect on that device's next request."
        icon={<Laptop className="h-4 w-4" />}
      />
      <ul className="divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                {describeAgent(s.userAgent)}
                {s.current && <Badge tone="ok">This device</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {s.ip ? `${s.ip} · ` : ''}started <RelativeTime date={s.createdAt} /> · expires{' '}
                <RelativeTime date={s.expiresAt} />
              </p>
            </div>
            {!s.current && (
              <Button size="xs" variant="ghost" loading={busy === s.id} onClick={() => void revoke(s.id)}>
                <LogOut className="h-3 w-3" />
                End
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Enough of the user-agent to recognise a device, without pretending to parse it. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua) && !/Chrome/.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : 'Browser'
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS'
  return `${browser} on ${os}`
}
