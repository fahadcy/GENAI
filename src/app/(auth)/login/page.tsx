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
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in to GenAI</h1>
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

    </div>
  )
}
