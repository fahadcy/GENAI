'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, KeyRound, Link2, Plug } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AdAccount } from '@/lib/db/schema'
import { connectAdAccountAction } from '@/app/actions/ads'
import { Badge, Button, Card, Field, Input } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'

/**
 * The honest front door to Google.
 *
 * Two states, and the distinction is the whole point: everything on this
 * platform up to and including approval works without Google credentials, and
 * nothing past that does. Saying so up front is cheaper than letting someone
 * build six campaigns and discover at launch that the developer token they have
 * not applied for yet takes several working days to be granted.
 */

export type AdAccountView = Pick<
  AdAccount,
  | 'id'
  | 'customerId'
  | 'descriptiveName'
  | 'currencyCode'
  | 'timeZone'
  | 'status'
  | 'testAccount'
  | 'isManager'
  | 'lastError'
> & { lastSyncAt: string | null }

/** Google writes account numbers as 123-456-7890 everywhere in their own UI. */
function formatCustomerId(id: string): string {
  const digits = id.replace(/\D/g, '')
  if (digits.length !== 10) return id
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
}

const WHAT_YOU_NEED: { title: string; body: string }[] = [
  {
    title: 'A Google Ads manager account',
    body: 'Also called an MCC. It is free to create and it is the account the developer token belongs to.',
  },
  {
    title: 'A developer token from the API Center',
    body: 'You apply for this inside the manager account. Google reviews applications by hand, and it usually takes a few working days — start it before you need it.',
  },
  {
    title: 'An OAuth client id, secret and refresh token',
    body: 'Created in Google Cloud, then authorised once against the account that will manage the campaigns.',
  },
]

export function ConnectAccount({
  accounts,
  configured,
  missing,
  canManage,
}: {
  accounts: AdAccountView[]
  configured: boolean
  missing: string[]
  canManage: boolean
}) {
  const connected = accounts.length > 0

  // Once an account is on file the connection is settled business, so it drops
  // to a single line and gives the page back to the campaigns.
  if (configured && connected) {
    return <StatusStrip accounts={accounts} canManage={canManage} />
  }

  return (
    <Card className="overflow-hidden">
      {/* Not CardHeader: it truncates its title, and on a phone the status badge
          leaves so little room that the headline loses its own subject. */}
      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Plug className="h-4 w-4 shrink-0 text-ink-faint" />
          <h2 className="text-sm font-semibold text-ink">
            {configured ? 'Connect your Google Ads account' : 'Google Ads is not connected yet'}
          </h2>
          {configured ? (
            <Badge tone="ok" dot>
              Credentials in place
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              Built-in builder only
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {configured
            ? 'Campaigns are built and approved here, then sent to this account.'
            : 'You can build, check and approve campaigns now. Nothing reaches Google until the credentials below are in place.'}
        </p>
      </div>

      {!configured && <NotConfigured missing={missing} />}

      {accounts.length > 0 && (
        <div className={cn('px-5 py-4', !configured && 'border-t border-line')}>
          <p className="label mb-2.5">Accounts on file</p>
          <AccountList accounts={accounts} />
        </div>
      )}

      {configured && <ConnectForm canManage={canManage} />}
    </Card>
  )
}

/* ------------------------------------------------------------ not configured */

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <div className="space-y-4 px-5 py-4">
      <p className="max-w-2xl text-[13px] leading-relaxed text-ink-muted">
        GenAI is running its built-in campaign builder and checker. Every campaign you make here is
        real work — the ad groups, keywords, headlines and budgets are the ones that would be
        created — and it can be reviewed and approved in the normal way. What it cannot do yet is
        create anything inside Google, so no money can be spent.
      </p>

      <div className="rounded-lg border border-line bg-bg-subtle p-4">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <KeyRound className="h-3.5 w-3.5 text-ink-faint" />
          Missing from the server configuration
        </p>
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {missing.map((key) => (
            <li
              key={key}
              className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-ink-muted"
            >
              {key}
            </li>
          ))}
        </ul>
        {missing.length === 0 && (
          <p className="mt-2 text-xs text-ink-faint">
            All four values are set. If this panel is still showing, restart the server so it picks
            them up.
          </p>
        )}
      </div>

      <div>
        <p className="text-[13px] font-semibold text-ink">What you need from Google</p>
        <ol className="mt-2.5 space-y-2.5">
          {WHAT_YOU_NEED.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-inset text-2xs font-semibold text-ink-muted">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium leading-snug text-ink">{step.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-warn-fg">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          The developer token is the long pole. Apply for it as soon as you know you will want live
          campaigns, rather than on the day you want to launch one.
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- form */

function ConnectForm({ canManage }: { canManage: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [customerId, setCustomerId] = React.useState('')
  const [managerCustomerId, setManagerCustomerId] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  const digits = customerId.replace(/\D/g, '')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (digits.length !== 10) {
      // Same sentence the action returns, so the message does not change
      // depending on whether the check happened here or on the server.
      setError(
        'A Google Ads account number is ten digits — you will find it at the top right of your Google Ads screen, written like 123-456-7890.',
      )
      return
    }
    setError(null)
    setPending(true)
    try {
      const res = await connectAdAccountAction({
        customerId: digits,
        managerCustomerId: managerCustomerId.replace(/\D/g, '') || undefined,
        label: label.trim() || undefined,
      })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Account saved' : 'Could not connect that account',
        body: res.message,
      })
      if (res.ok) {
        setCustomerId('')
        setManagerCustomerId('')
        setLabel('')
        router.refresh()
      } else {
        setError(res.message)
      }
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Nothing was saved',
        body: 'The request did not complete. Check your connection and try again.',
      })
    } finally {
      setPending(false)
    }
  }

  if (!canManage) {
    return (
      <div className="border-t border-line px-5 py-4">
        <p className="text-[13px] text-ink-muted">
          Connecting an account needs an owner or marketing ops. Ask one of them to add it, and you
          can carry on building campaigns meanwhile.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 border-t border-line px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Google Ads account number"
          hint="Ten digits, shown at the top right of your Google Ads screen — like 123-456-7890."
          error={error}
          required
          className="min-w-0"
        >
          <Input
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="123-456-7890"
            inputMode="numeric"
            autoComplete="off"
            className="tnum"
          />
        </Field>
        <Field
          label="Manager account number"
          hint="Only if you reach this account through a manager (MCC) account. Leave it blank otherwise."
          className="min-w-0"
        >
          <Input
            value={managerCustomerId}
            onChange={(e) => setManagerCustomerId(e.target.value)}
            placeholder="Optional"
            inputMode="numeric"
            autoComplete="off"
            className="tnum"
          />
        </Field>
      </div>
      <Field
        label="What to call it here"
        hint="Only affects what you see in GenAI. Left blank, we use the name Google has."
      >
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Optional"
          maxLength={80}
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          {!pending && <Link2 className="h-3.5 w-3.5" />}
          Connect account
        </Button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ status */

function StatusStrip({ accounts, canManage }: { accounts: AdAccountView[]; canManage: boolean }) {
  const [open, setOpen] = React.useState(false)
  const primary = accounts[0]
  const healthy = accounts.some((a) => a.status === 'connected')
  const anyTest = accounts.some((a) => a.testAccount)

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3 text-left transition-colors hover:bg-surface-hover"
        aria-expanded={open}
      >
        {healthy ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-ok-fg" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-warn-fg" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          <span className="font-medium">{primary.descriptiveName ?? 'Google Ads account'}</span>
          <span className="tnum text-ink-muted"> · {formatCustomerId(primary.customerId)}</span>
          <span className="text-ink-muted"> · {primary.currencyCode}</span>
          {accounts.length > 1 && (
            <span className="text-ink-faint"> · {accounts.length - 1} more</span>
          )}
        </span>
        {anyTest && <Badge tone="warn">Test account</Badge>}
        <span className="shrink-0 text-xs text-ink-faint">{open ? 'Hide' : 'Details'}</span>
      </button>

      {open && (
        <div className="animate-fade-in border-t border-line px-5 py-4">
          <AccountList accounts={accounts} />
          <div className="mt-4 border-t border-line pt-4">
            <ConnectForm canManage={canManage} />
          </div>
        </div>
      )}
    </Card>
  )
}

function AccountList({ accounts }: { accounts: AdAccountView[] }) {
  return (
    <ul className="space-y-2.5">
      {accounts.map((a) => (
        <li key={a.id} className="rounded-lg border border-line bg-bg-subtle px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
              {a.descriptiveName ?? `Account ${formatCustomerId(a.customerId)}`}
            </span>
            <Badge
              tone={a.status === 'connected' ? 'ok' : a.status === 'error' ? 'danger' : 'neutral'}
              dot
            >
              {a.status === 'connected'
                ? 'Connected'
                : a.status === 'error'
                  ? 'Not verified'
                  : 'Waiting on credentials'}
            </Badge>
            {a.isManager && <Badge tone="neutral">Manager account</Badge>}
          </div>

          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
            <div className="flex min-w-0 gap-1.5">
              <dt className="text-ink-faint">Account</dt>
              <dd className="tnum truncate">{formatCustomerId(a.customerId)}</dd>
            </div>
            <div className="flex min-w-0 gap-1.5">
              <dt className="text-ink-faint">Currency</dt>
              <dd>{a.currencyCode}</dd>
            </div>
            <div className="flex min-w-0 gap-1.5">
              <dt className="text-ink-faint">Time zone</dt>
              <dd className="truncate">{a.timeZone}</dd>
            </div>
            {a.lastSyncAt && (
              <div className="flex min-w-0 gap-1.5">
                <dt className="text-ink-faint">Checked</dt>
                <dd>
                  <RelativeTime date={a.lastSyncAt} />
                </dd>
              </div>
            )}
          </dl>

          {a.testAccount && (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-warn-fg">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              This is a Google test account. Campaigns created in it never actually run, never show
              to anyone and never spend money — useful for practice, not for launching.
            </p>
          )}
          {a.lastError && (
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">{a.lastError}</p>
          )}
        </li>
      ))}
    </ul>
  )
}
