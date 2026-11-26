'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as React from 'react'
import { ChevronsUpDown, Menu, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Wordmark } from '@/components/brand'
import { Badge, Button } from '@/components/ui/primitives'
import { navForRole } from './nav'
import { switchWorkspaceAction } from '@/app/actions/auth'
import { ROLE_LABEL } from '@/lib/auth/rbac'
import type { Role } from '@/lib/db/schema'

export type SidebarProps = {
  role: Role
  workspace: { id: string; name: string; plan: string; trialEndsAt: string | null }
  workspaces: { id: string; name: string; role: Role }[]
  counts: { approvals: number; recommendations: number; deadLetter: number }
}

export function Sidebar(props: SidebarProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const pathname = usePathname()

  React.useEffect(() => setMobileOpen(false), [pathname])

  return (
    <>
      {/* Mobile bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <Wordmark size="sm" />
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-lg p-2 text-ink-muted hover:bg-surface-hover"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[rgb(8_9_14/0.5)]" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 animate-fade-in border-r border-line bg-surface">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-ink-muted hover:bg-surface-hover"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarBody {...props} pathname={pathname} />
          </div>
        </div>
      )}

      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-line bg-surface lg:block">
        <SidebarBody {...props} pathname={pathname} />
      </aside>
    </>
  )
}

function SidebarBody({ role, workspace, workspaces, counts, pathname }: SidebarProps & { pathname: string }) {
  const groups = navForRole(role)
  const trialDaysLeft = workspace.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(workspace.trialEndsAt).getTime() - Date.now()) / 86_400_000))
    : null

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-4">
        <Link href="/command-center" className="mb-4 inline-block">
          <Wordmark size="sm" />
        </Link>
        <WorkspaceSwitcher current={workspace} options={workspaces} />
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((group) => (
          <div key={group.section} className="mb-5">
            <p className="label mb-1.5 px-2">{group.section}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active =
                  pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href + '/'))
                const Icon = item.icon
                const badge =
                  item.href === '/approvals'
                    ? counts.approvals
                    : item.href === '/scheduler'
                      ? counts.deadLetter
                      : item.href === '/command-center'
                        ? counts.recommendations
                        : 0
                const badgeTone = item.href === '/scheduler' ? 'danger' : 'brand'
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={item.description}
                      className={cn(
                        'group flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13.5px] font-medium transition-colors',
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                      )}
                    >
                      <Icon
                        className={cn('h-4 w-4 shrink-0', active ? 'text-brand-600' : 'text-ink-faint')}
                        strokeWidth={active ? 2.2 : 1.9}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {badge > 0 && (
                        <Badge tone={badgeTone} className="px-1.5 py-0">
                          {badge}
                        </Badge>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        {trialDaysLeft !== null ? (
          <div className="rounded-lg border border-gold-600/25 bg-gold-100 p-3">
            <p className="text-[13px] font-semibold text-gold-600">
              {trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'} left in your trial
            </p>
            <p className="mt-0.5 text-xs leading-snug text-gold-600/85">
              Everything stays exactly as you left it when you upgrade.
            </p>
            <Link
              href="/settings/billing"
              className="mt-2.5 inline-flex h-7 items-center rounded-md bg-gold-400 px-2.5 text-xs font-semibold text-[rgb(28,22,4)] hover:brightness-95"
            >
              Choose a plan
            </Link>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-2xs text-ink-faint">
              {ROLE_LABEL[role]} · {workspace.plan[0].toUpperCase() + workspace.plan.slice(1)}
            </span>
            <Link
              href="/settings/billing"
              className="text-2xs font-medium text-ink-muted hover:text-brand-600"
            >
              Manage
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function WorkspaceSwitcher({
  current,
  options,
}: {
  current: { id: string; name: string }
  options: { id: string; name: string; role: Role }[]
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-solid text-[11px] font-bold text-brand-on">
          {current.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{current.name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 animate-fade-in overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
          <p className="label px-3 pb-1 pt-2.5">Your workspaces</p>
          {options.map((o) => (
            <form key={o.id} action={switchWorkspaceAction}>
              <input type="hidden" name="workspaceId" value={o.id} />
              <button
                type="submit"
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-hover',
                  o.id === current.id && 'bg-brand-50',
                )}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-bg-inset text-[10px] font-bold text-ink-muted">
                  {o.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{o.name}</span>
                <span className="shrink-0 text-2xs text-ink-faint">{ROLE_LABEL[o.role]}</span>
              </button>
            </form>
          ))}
        </div>
      )}
    </div>
  )
}

/** Small inline affordance used on empty screens to point at the copilot. */
export function CopilotHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-brand-600">
      <Sparkles className="h-3.5 w-3.5" />
      {children}
    </span>
  )
}

export { Button }
