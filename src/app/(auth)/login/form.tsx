'use client'

import { useActionState } from 'react'
import { AlertCircle } from 'lucide-react'
import { loginAction, type FormState } from '@/app/actions/auth'
import { Button, Field, Input } from '@/components/ui/primitives'

export function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, null)

  return (
    <form action={action} className="space-y-4">
      {state?.error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-danger-fg/25 bg-danger-bg px-3 py-2.5 text-[13px] text-danger-fg"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {state.error}
        </div>
      )}

      <Field label="Work email" error={state?.fieldErrors?.email}>
        <Input
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="you@company.com"
          defaultValue="fahad.ali@currieyoung.com"
        />
      </Field>

      <Field label="Password" error={state?.fieldErrors?.password}>
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••••"
          defaultValue="Aurea2026!"
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-center text-xs text-ink-faint">
        Single sign-on (SAML/OIDC) is available on the Scale and Enterprise plans.
      </p>
    </form>
  )
}
