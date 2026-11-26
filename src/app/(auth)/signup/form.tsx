'use client'

import { useActionState } from 'react'
import { AlertCircle } from 'lucide-react'
import { signupAction, type FormState } from '@/app/actions/auth'
import { Button, Field, Input } from '@/components/ui/primitives'

export function SignupForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signupAction, null)

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

      <Field label="Your name" error={state?.fieldErrors?.name}>
        <Input name="name" required autoComplete="name" placeholder="Alex Morgan" />
      </Field>

      <Field label="Work email" error={state?.fieldErrors?.email}>
        <Input name="email" type="email" required autoComplete="username" placeholder="you@company.com" />
      </Field>

      <Field
        label="Password"
        error={state?.fieldErrors?.password}
        hint="At least 10 characters, mixed case, with a number."
      >
        <Input name="password" type="password" required autoComplete="new-password" />
      </Field>

      <Field label="Workspace name" error={state?.fieldErrors?.workspaceName} hint="Usually your company or team name.">
        <Input name="workspaceName" required placeholder="Acme Marketing" />
      </Field>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={pending}>
        {pending ? 'Creating your workspace…' : 'Create workspace'}
      </Button>
    </form>
  )
}
