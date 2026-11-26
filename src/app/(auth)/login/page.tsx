import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAuth } from '@/lib/auth/session'
import { LoginForm } from './form'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage() {
  if (await getAuth()) redirect('/command-center')

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in to Aurea</h1>
      <p className="mt-1.5 text-[14px] text-ink-muted">
        New here?{' '}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Start a 14-day trial
        </Link>
        .
      </p>

      <div className="mt-8">
        <LoginForm />
      </div>

      <DemoAccounts />
    </div>
  )
}

/**
 * Six roles, six different views of the same workspace. Being able to switch
 * between them in two clicks is the fastest way to show what role-aware
 * governance actually means.
 */
function DemoAccounts() {
  const accounts = [
    { email: 'fahad.ali@currieyoung.com', role: 'Owner', note: 'Everything, including billing' },
    { email: 'marcus@currieyoung.com', role: 'Content creator', note: 'Studio-first, cannot approve' },
    { email: 'elena@currieyoung.com', role: 'Reviewer / legal', note: 'Lands on the approvals queue' },
    { email: 'priya@currieyoung.com', role: 'Growth marketer', note: 'Planning, targeting, copilot' },
    { email: 'daniel@currieyoung.com', role: 'Marketing ops', note: 'Connectors, brand rules, access' },
    { email: 'grace@currieyoung.com', role: 'Analyst', note: 'Read-only with exports' },
  ]

  return (
    <div className="mt-10 rounded-card border border-line bg-bg-subtle p-4">
      <p className="text-[13px] font-semibold text-ink">Demo accounts</p>
      <p className="mt-0.5 text-xs text-ink-muted">
        All use the password{' '}
        <code className="rounded bg-bg-inset px-1.5 py-0.5 font-mono text-[11px] text-ink">Aurea2026!</code>
      </p>
      <ul className="mt-3 space-y-1.5">
        {accounts.map((a) => (
          <li key={a.email} className="flex items-baseline justify-between gap-3 text-xs">
            <code className="truncate font-mono text-[11px] text-ink-muted">{a.email}</code>
            <span className="shrink-0 text-ink-faint" title={a.note}>
              {a.role}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
