'use client'

import * as React from 'react'
import Link from 'next/link'
import { Bell, LogOut, Settings, UserRound } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar } from '@/components/ui/primitives'
import { ThemeToggle } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { ROLE_LABEL } from '@/lib/auth/rbac'
import { logoutAction } from '@/app/actions/auth'
import { markNotificationsRead } from '@/app/actions/notifications'
import type { Role } from '@/lib/db/schema'

export type TopbarNotification = {
  id: string
  title: string
  body: string | null
  href: string | null
  createdAt: string
  read: boolean
}

export function Topbar({
  user,
  role,
  title,
  description,
  actions,
  notifications,
}: {
  user: { name: string; email: string; avatarHue: number; jobTitle: string | null }
  role: Role
  title: string
  description?: string
  actions?: React.ReactNode
  notifications: TopbarNotification[]
}) {
  const unread = notifications.filter((n) => !n.read).length

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      {/* Wraps rather than overflows: on a phone the page title and the action
          cluster together exceed the viewport, and a topbar is the last thing
          that should introduce horizontal scroll. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5 lg:px-7">
        {/* Full width on a phone so the action cluster wraps to its own line.
            `flex-1` is avoided here: it resets flex-basis, which would let the
            title shrink and push the actions off-screen instead. */}
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h1 className="truncate text-[19px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {description && (
            <p className="mt-0.5 truncate text-[13px] text-ink-muted">{description}</p>
          )}
        </div>

        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {actions}
          <div className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <ThemeToggle />
          <NotificationBell notifications={notifications} unread={unread} />
          <UserMenu user={user} role={role} />
        </div>
      </div>
    </header>
  )
}

function NotificationBell({
  notifications,
  unread,
}: {
  notifications: TopbarNotification[]
  unread: number
}) {
  const [open, setOpen] = React.useState(false)
  const ref = useOutsideClose(() => setOpen(false), open)

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen((v) => !v)
          if (!open && unread > 0) void markNotificationsRead()
        }}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-600" />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-80 animate-fade-in overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-ink">Notifications</p>
            {unread > 0 && <span className="text-2xs text-ink-faint">{unread} new</span>}
          </div>
          {notifications.length === 0 ? (
            <p className="px-3.5 py-8 text-center text-[13px] text-ink-faint">Nothing needs you right now.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <Link
                    href={n.href ?? '#'}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'block px-3.5 py-3 transition-colors hover:bg-surface-hover',
                      !n.read && 'bg-brand-50/50',
                    )}
                  >
                    <p className="text-[13px] font-medium leading-snug text-ink">{n.title}</p>
                    {n.body && <p className="mt-0.5 text-xs leading-snug text-ink-muted">{n.body}</p>}
                    <p className="mt-1 text-2xs text-ink-faint">
                      <RelativeTime date={n.createdAt} />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function UserMenu({
  user,
  role,
}: {
  user: { name: string; email: string; avatarHue: number; jobTitle: string | null }
  role: Role
}) {
  const [open, setOpen] = React.useState(false)
  const ref = useOutsideClose(() => setOpen(false), open)

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="ml-0.5 rounded-full ring-offset-2 ring-offset-bg transition-shadow hover:ring-2 hover:ring-line-strong"
        aria-label="Account menu"
      >
        <Avatar name={user.name} hue={user.avatarHue} size={30} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-60 animate-fade-in overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line px-3.5 py-3">
            <p className="truncate text-[13px] font-semibold text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-muted">{user.email}</p>
            <p className="mt-1.5 text-2xs text-ink-faint">
              {ROLE_LABEL[role]}
              {user.jobTitle ? ` · ${user.jobTitle}` : ''}
            </p>
          </div>
          <div className="p-1">
            <MenuLink href="/settings/profile" icon={UserRound}>
              Your profile
            </MenuLink>
            <MenuLink href="/settings" icon={Settings}>
              Workspace settings
            </MenuLink>
          </div>
          <form action={logoutAction} className="border-t border-line p-1">
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-danger-fg"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function MenuLink({
  href,
  icon: Icon,
  children,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  )
}

function useOutsideClose(onClose: () => void, active: boolean) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!active) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, onClose])
  return ref
}
