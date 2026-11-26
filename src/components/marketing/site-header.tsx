'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowRight, Menu, X } from 'lucide-react'
import { Wordmark } from '@/components/brand'
import { LinkButton } from '@/components/ui/primitives'
import { ThemeToggle } from '@/components/ui/client'
import { cn } from '@/lib/cn'
import { Container } from './bits'

export type HeaderSession = { workspaceName: string; homeHref: string } | null

const LINKS = [
  { href: '/#loop', label: 'The loop' },
  { href: '/#ideas', label: "What's different" },
  { href: '/#comparison', label: 'Comparison' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
]

export function SiteHeader({ session }: { session: HeaderSession }) {
  const [open, setOpen] = React.useState(false)
  const pathname = usePathname()

  // Any navigation closes the sheet, including in-page anchors on the same route.
  React.useEffect(() => setOpen(false), [pathname])

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-8">
          <Link href="/" className="shrink-0" aria-label="Aurea home">
            <Wordmark size="md" />
          </Link>
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                  pathname === l.href
                    ? 'text-ink'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          {session ? (
            <LinkButton href={session.homeHref} variant="primary" size="sm" className="hidden sm:inline-flex">
              Go to workspace
              <ArrowRight className="h-3.5 w-3.5" />
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm" className="hidden sm:inline-flex">
                Sign in
              </LinkButton>
              <LinkButton href="/signup" variant="primary" size="sm" className="hidden sm:inline-flex">
                Start free trial
              </LinkButton>
            </>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X className="h-[18px] w-[18px]" /> : <Menu className="h-[18px] w-[18px]" />}
          </button>
        </div>
      </Container>

      {open && (
        <div className="animate-fade-in border-t border-line bg-surface lg:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
              >
                {l.label}
              </Link>
            ))}
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-4">
              {session ? (
                <LinkButton href={session.homeHref} variant="primary" size="md" className="flex-1">
                  Go to workspace
                </LinkButton>
              ) : (
                <>
                  <LinkButton href="/login" variant="secondary" size="md" className="flex-1">
                    Sign in
                  </LinkButton>
                  <LinkButton href="/signup" variant="primary" size="md" className="flex-1">
                    Start free trial
                  </LinkButton>
                </>
              )}
              <ThemeToggle className="shrink-0 sm:hidden" />
            </div>
          </Container>
        </div>
      )}
    </header>
  )
}
