import Link from 'next/link'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAuth } from '@/lib/auth/session'
import { SignupForm } from './form'

export const metadata: Metadata = { title: 'Start a trial' }

export default async function SignupPage() {
  if (await getAuth()) redirect('/command-center')

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Start your 14-day trial</h1>
      <p className="mt-1.5 text-[14px] text-ink-muted">
        No card required. Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
        .
      </p>

      <div className="mt-8">
        <SignupForm />
      </div>

      <p className="mt-6 text-xs leading-relaxed text-ink-faint">
        Your workspace starts with a brand voice profile and an approval chain already in place, so
        the governance rules apply from your first asset rather than after a setup project.
      </p>
    </div>
  )
}
