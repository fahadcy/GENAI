'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import { Topbar, type TopbarNotification } from '@/components/shell/topbar'
import type { Role } from '@/lib/db/schema'
import { activeSettingsItem, settingsNavForRole } from './nav'

/**
 * The settings shell.
 *
 * Product screens each own their topbar, but every settings screen shares one.
 * Deriving the title from the pathname here keeps that single header honest as
 * you move between sub-screens without every page re-declaring the same props.
 */
export function SettingsTopbar({
  user,
  role,
  notifications,
  workspaceName,
  planLabel,
}: {
  user: { name: string; email: string; avatarHue: number; jobTitle: string | null }
  role: Role
  notifications: TopbarNotification[]
  workspaceName: string
  planLabel: string
}) {
  const pathname = usePathname()
  const item = activeSettingsItem(pathname)

  return (
    <Topbar
      user={user}
      role={role}
      notifications={notifications}
      title={item?.title ?? 'Settings'}
      description={item?.description ?? `${workspaceName} · ${planLabel}`}
    />
  )
}

/** Horizontal strip for narrow viewports — a 232px rail would eat the page. */
export function SettingsNavStrip({ role }: { role: Role }) {
  const pathname = usePathname()
  const items = settingsNavForRole(role).flatMap((g) => g.items)
  const active = activeSettingsItem(pathname)

  return (
    <nav className="overflow-x-auto border-b border-line bg-bg px-5 lg:hidden">
      <ul className="flex items-center gap-1 py-2">
        {items.map((item) => {
          const on = active?.href === item.href
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                  on ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function SettingsNavRail({ role }: { role: Role }) {
  const pathname = usePathname()
  const groups = settingsNavForRole(role)
  const active = activeSettingsItem(pathname)

  return (
    <aside className="sticky top-[72px] hidden h-[calc(100vh-72px)] w-[232px] shrink-0 overflow-y-auto border-r border-line px-3 py-5 lg:block">
        {groups.map((group) => (
          <div key={group.section} className="mb-5">
            <p className="label px-2.5 pb-1.5">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const on = active?.href === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
                        on ? 'bg-bg-inset' : 'hover:bg-surface-hover',
                      )}
                    >
                      <item.icon
                        className={cn(
                          'mt-0.5 h-4 w-4 shrink-0',
                          on ? 'text-brand-600' : 'text-ink-faint group-hover:text-ink-muted',
                        )}
                      />
                      <span className="min-w-0">
                        <span
                          className={cn(
                            'block truncate text-[13px] font-medium',
                            on ? 'text-ink' : 'text-ink-muted group-hover:text-ink',
                          )}
                        >
                          {item.label}
                        </span>
                        <span className="mt-0.5 block truncate text-2xs text-ink-faint">{item.blurb}</span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
    </aside>
  )
}
