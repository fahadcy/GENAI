'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  Facebook,
  KeyRound,
  Linkedin,
  Link2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SocialAccount } from '@/lib/db/schema'
import { Avatar, Badge, Button, Card } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { ChannelChip, RelativeTime } from '@/components/domain'
import {
  beginConnectAction,
  disconnectAccountAction,
  setDefaultAccountAction,
} from '@/app/actions/social'

/**
 * Connecting the accounts this workspace actually publishes to.
 *
 * The hard part of this screen is not the buttons, it is being straight about
 * what each platform will and will not allow. LinkedIn hands out personal
 * posting on sign-in and company-page posting only after a review measured in
 * months; Facebook refuses to post to a personal profile under any
 * circumstances. Someone who learns that from a failed publish three weeks into
 * a campaign has been let down by this screen, so it is all said here, before
 * anyone clicks anything.
 */

export type SocialAccountView = Pick<
  SocialAccount,
  | 'id'
  | 'provider'
  | 'channel'
  | 'kind'
  | 'externalId'
  | 'displayName'
  | 'avatarUrl'
  | 'tokenHint'
  | 'scopes'
  | 'status'
  | 'isDefault'
  | 'lastError'
> & {
  /** Serialised on the server: Dates do not survive the boundary as Dates. */
  expiresAt: string | null
  lastPublishAt: string | null
  createdAt: string
}

export type ProviderConfig = { configured: boolean; missing: string[] }

type ProviderKey = 'linkedin' | 'facebook'

const PROVIDER_META: Record<
  ProviderKey,
  { label: string; channel: string; icon: React.ComponentType<{ className?: string }>; hue: number }
> = {
  linkedin: { label: 'LinkedIn', channel: 'linkedin', icon: Linkedin, hue: 205 },
  facebook: { label: 'Facebook', channel: 'facebook', icon: Facebook, hue: 215 },
}

/* ------------------------------------------------------------------- utils */

/** What a connected row will post as, in the words someone would use out loud. */
function postsAs(account: SocialAccountView): string {
  if (account.provider === 'linkedin') {
    return account.kind === 'organization' ? 'Posts as this company page' : 'Posts as your profile'
  }
  return 'Posts as this Facebook Page'
}

type Expiry = { text: string; tone: 'plain' | 'warn' | 'danger' }

/**
 * A token that quietly expires is the most common way this stops working, and
 * the platform gives no warning of its own. Seven days is enough notice to
 * reconnect without it becoming background noise.
 */
function expiryNote(expiresAt: string | null): Expiry {
  if (!expiresAt) return { text: 'Does not expire', tone: 'plain' }
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (Number.isNaN(ms)) return { text: 'Unknown', tone: 'plain' }
  if (ms <= 0) return { text: 'Expired — reconnect before the next post', tone: 'danger' }
  const days = Math.floor(ms / 86_400_000)
  if (days <= 7) {
    return {
      text: days < 1 ? 'Expires within a day — reconnect soon' : `Expires in ${days} day${days === 1 ? '' : 's'} — reconnect soon`,
      tone: 'warn',
    }
  }
  return { text: `Expires in ${days} days`, tone: 'plain' }
}

/* ------------------------------------------------------------------- shell */

export function SocialConnect({
  accounts,
  linkedin,
  facebook,
  canManage,
  notice,
}: {
  accounts: SocialAccountView[]
  linkedin: ProviderConfig
  facebook: ProviderConfig
  canManage: boolean
  notice: { tone: 'ok' | 'error'; message: string } | null
}) {
  return (
    <div className="space-y-4">
      {notice && <ConnectNotice tone={notice.tone} message={notice.message} />}

      <WhatYouCanPostTo />

      <div className="grid gap-4 lg:grid-cols-2">
        <ProviderCard
          provider="linkedin"
          config={linkedin}
          accounts={accounts.filter((a) => a.provider === 'linkedin')}
          canManage={canManage}
        />
        <ProviderCard
          provider="facebook"
          config={facebook}
          accounts={accounts.filter((a) => a.provider === 'facebook')}
          canManage={canManage}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ notice */

function ConnectNotice({ tone, message }: { tone: 'ok' | 'error'; message: string }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(true)
  if (!open) return null

  const Icon = tone === 'ok' ? CheckCircle2 : AlertTriangle

  return (
    <div
      role="status"
      className={cn(
        'flex animate-fade-in items-start gap-2.5 rounded-lg border px-3.5 py-3',
        tone === 'ok' ? 'border-ok-fg/25 bg-ok-bg' : 'border-danger-fg/25 bg-danger-bg',
      )}
    >
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'ok' ? 'text-ok-fg' : 'text-danger-fg')}
      />
      <p
        className={cn(
          'min-w-0 flex-1 break-words text-[13px] leading-relaxed',
          tone === 'ok' ? 'text-ok-fg' : 'text-danger-fg',
        )}
      >
        {message}
      </p>
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          // Also drop the query string, so a refresh does not resurrect a
          // message about something that has already been dealt with.
          router.replace('/settings/connectors', { scroll: false })
        }}
        className={cn(
          'shrink-0 rounded p-0.5 transition-opacity hover:opacity-70',
          tone === 'ok' ? 'text-ok-fg' : 'text-danger-fg',
        )}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- explainer */

const REALITY: { title: string; body: string; tone: 'ok' | 'warn' }[] = [
  {
    title: 'Your own LinkedIn profile',
    tone: 'ok',
    body: 'Available immediately. LinkedIn grants personal posting on sign-in, with no review, so this works the moment you connect it.',
  },
  {
    title: 'A LinkedIn company page',
    tone: 'warn',
    body: 'Needs LinkedIn to approve this application for their Community Management API first. That review takes between four weeks and six months. Until it comes through, connecting a page will sign you in and then stop, because LinkedIn returns nothing that can be posted as.',
  },
  {
    title: 'A Facebook Page you administer',
    tone: 'warn',
    body: 'Works now for Pages your own Facebook account administers, while the app is in development. Posting to a client’s Page needs App Review and Business Verification from Meta before it will run.',
  },
]

function WhatYouCanPostTo() {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold text-ink">What you can post to</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
          The platforms decide this, not Aurea. Worth reading before you plan a campaign around a
          destination that is not available yet.
        </p>
      </div>
      <ul className="divide-y divide-line">
        {REALITY.map((item) => (
          <li key={item.title} className="flex items-start gap-3 px-5 py-3">
            <span
              className={cn(
                'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                item.tone === 'ok' ? 'bg-ok-fg' : 'bg-warn-fg',
              )}
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">{item.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-line bg-bg-subtle px-5 py-3 text-xs leading-relaxed text-ink-muted">
        There is no fourth option. Facebook does not allow any application to post to a personal
        profile, so a Page is the only Facebook destination that exists.
      </p>
    </Card>
  )
}

/* -------------------------------------------------------------- provider card */

function ProviderCard({
  provider,
  config,
  accounts,
  canManage,
}: {
  provider: ProviderKey
  config: ProviderConfig
  accounts: SocialAccountView[]
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const meta = PROVIDER_META[provider]
  const Icon = meta.icon

  /** Which control is mid-flight, so only that one spins. */
  const [busy, setBusy] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)

  const unhealthy = accounts.some((a) => a.status === 'error' || a.lastError)

  const connect = async (kind?: 'member' | 'organization') => {
    const key = `connect:${kind ?? 'page'}`
    setBusy(key)
    try {
      const res = await beginConnectAction({ provider, kind })
      if (res.ok && res.data?.url) {
        // A full navigation, not router.push: the destination belongs to
        // LinkedIn or Facebook, not to this app's router. Busy state is left on
        // deliberately — the page is on its way out.
        window.location.href = res.data.url
        return
      }
      toast.push({
        tone: 'danger',
        title: `Could not start the ${meta.label} connection`,
        body: res.message,
      })
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Nothing was changed',
        body: 'The request did not complete. Check your connection and try again.',
      })
    }
    setBusy(null)
  }

  const mutate = async (
    key: string,
    fn: () => Promise<{ ok: boolean; message: string }>,
    okTitle: string,
    failTitle: string,
  ) => {
    setBusy(key)
    try {
      const res = await fn()
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? okTitle : failTitle,
        body: res.message,
      })
      if (res.ok) {
        setConfirming(null)
        router.refresh()
      }
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Nothing was changed',
        body: 'The request did not complete. Check your connection and try again.',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Not CardHeader: its title truncates, and on a phone the badges leave so
          little room that the heading loses its own subject. */}
      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
          <h3 className="text-sm font-semibold text-ink">{meta.label}</h3>
          <ChannelChip channel={meta.channel} size="sm" />
          {!config.configured ? (
            <Badge tone="warn" dot>
              Not set up
            </Badge>
          ) : unhealthy ? (
            <Badge tone="danger" dot>
              Needs attention
            </Badge>
          ) : accounts.length > 0 ? (
            <Badge tone="ok" dot>
              Connected
            </Badge>
          ) : (
            <Badge tone="neutral" dot>
              Nothing connected
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {!config.configured
            ? `Nobody can connect a ${meta.label} account until the server has credentials for it.`
            : accounts.length > 0
              ? `Scheduled ${meta.label} posts publish to the destination marked below.`
              : `Until something is connected, scheduled ${meta.label} posts run through the simulator and are recorded as simulated.`}
        </p>
      </div>

      {!config.configured ? (
        <NotConfigured label={meta.label} missing={config.missing} />
      ) : (
        <>
          {accounts.length > 0 && (
            <ul className="divide-y divide-line">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  hue={meta.hue}
                  canManage={canManage}
                  busy={busy}
                  confirming={confirming}
                  onConfirm={setConfirming}
                  onSetDefault={() =>
                    void mutate(
                      `default:${account.id}`,
                      () => setDefaultAccountAction(account.id),
                      'Posts will go here from now on',
                      'Could not change where posts go',
                    )
                  }
                  onDisconnect={() =>
                    void mutate(
                      `disconnect:${account.id}`,
                      () => disconnectAccountAction(account.id),
                      'Disconnected',
                      'Could not disconnect that account',
                    )
                  }
                />
              ))}
            </ul>
          )}

          <ConnectOptions
            provider={provider}
            hasAccounts={accounts.length > 0}
            canManage={canManage}
            busy={busy}
            onConnect={connect}
          />
        </>
      )}
    </Card>
  )
}

/* --------------------------------------------------------- not configured */

function NotConfigured({ label, missing }: { label: string; missing: string[] }) {
  return (
    <div className="space-y-3.5 px-5 py-4">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        These are application credentials rather than anything you can type in here. A developer
        registers the app with {label}, puts the values in the server environment and restarts it.
        After that this card turns into a connect button.
      </p>

      <div className="rounded-lg border border-line bg-bg-subtle p-3.5">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          Missing from the server configuration
        </p>
        {missing.length > 0 ? (
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {missing.map((key) => (
              <li
                key={key}
                className="max-w-full break-all rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-ink-muted"
              >
                {key}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Both values are set. If this panel is still showing, restart the server so it picks them
            up.
          </p>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------- connect options */

function ConnectOptions({
  provider,
  hasAccounts,
  canManage,
  busy,
  onConnect,
}: {
  provider: ProviderKey
  hasAccounts: boolean
  canManage: boolean
  busy: string | null
  onConnect: (kind?: 'member' | 'organization') => void | Promise<void>
}) {
  if (!canManage) {
    return (
      <div className={cn('px-5 py-4', hasAccounts && 'border-t border-line')}>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Connecting or changing an account needs an owner or marketing ops. You can see what is
          connected here and ask one of them if it needs to move.
        </p>
      </div>
    )
  }

  const options =
    provider === 'linkedin'
      ? [
          {
            key: 'connect:member',
            title: 'Connect my profile',
            body: 'Posts go out on your own feed, under your name. LinkedIn grants this without review, so it works from the moment you sign in.',
            action: 'Connect my profile',
            variant: 'primary' as const,
            onClick: () => onConnect('member'),
            caveat: null,
          },
          {
            key: 'connect:organization',
            title: 'Connect a company page',
            body: 'Posts go out as the organisation rather than a person.',
            action: 'Connect a company page',
            variant: 'secondary' as const,
            onClick: () => onConnect('organization'),
            caveat:
              'This needs LinkedIn to approve the app for their Community Management API, which takes four weeks to six months. Before that approval you can still complete the sign-in, but LinkedIn will return no page to post as and the connection will fail at the last step.',
          },
        ]
      : [
          {
            key: 'connect:page',
            title: 'Connect a Facebook Page',
            body: 'You pick from the Pages your Facebook account administers, and each one becomes its own destination here.',
            action: 'Connect a Facebook Page',
            variant: 'primary' as const,
            onClick: () => onConnect(),
            caveat:
              'Facebook does not allow applications to post to personal profiles at all — only to Pages. Pages you administer yourself work now; a client’s Page needs App Review and Business Verification from Meta first.',
          },
        ]

  return (
    <div className={cn('space-y-4 px-5 py-4', hasAccounts && 'border-t border-line')}>
      {hasAccounts && <p className="label">Add another destination</p>}
      {options.map((option) => (
        <div key={option.key}>
          <p className="text-[13px] font-medium text-ink">{option.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{option.body}</p>
          {option.caveat && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-warn-fg">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{option.caveat}</span>
            </p>
          )}
          <Button
            className="mt-2.5"
            size="sm"
            variant={option.variant}
            loading={busy === option.key}
            disabled={busy !== null && busy !== option.key}
            onClick={() => void option.onClick()}
          >
            {busy !== option.key && <Link2 className="h-3.5 w-3.5" />}
            {option.action}
          </Button>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- account row */

function AccountRow({
  account,
  hue,
  canManage,
  busy,
  confirming,
  onConfirm,
  onSetDefault,
  onDisconnect,
}: {
  account: SocialAccountView
  hue: number
  canManage: boolean
  busy: string | null
  confirming: string | null
  onConfirm: (id: string | null) => void
  onSetDefault: () => void
  onDisconnect: () => void
}) {
  const expiry = expiryNote(account.expiresAt)
  const broken = account.status === 'error'
  const awaitingConfirm = confirming === account.id

  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <AccountAvatar account={account} hue={hue} />

        {/* min-w-0 so a long page name truncates rather than widening the card
            past the viewport on a phone. */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 max-w-full truncate text-[13.5px] font-semibold text-ink">
              {account.displayName}
            </span>
            {account.isDefault && (
              <Badge tone="ok" dot>
                Posts go here
              </Badge>
            )}
            {account.status !== 'connected' && (
              <Badge tone={broken ? 'danger' : 'warn'} dot>
                {broken ? 'Not working' : 'Degraded'}
              </Badge>
            )}
          </div>

          <p className="mt-0.5 text-xs text-ink-muted">{postsAs(account)}</p>

          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            {account.tokenHint && (
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0 text-ink-faint">Token</dt>
                <dd className="truncate font-mono">····{account.tokenHint}</dd>
              </div>
            )}
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-ink-faint">Expires</dt>
              <dd
                className={cn(
                  'min-w-0',
                  expiry.tone === 'warn' && 'font-medium text-warn-fg',
                  expiry.tone === 'danger' && 'font-medium text-danger-fg',
                )}
              >
                {expiry.text}
              </dd>
            </div>
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-ink-faint">Last published</dt>
              <dd className="min-w-0 truncate">
                <RelativeTime date={account.lastPublishAt} />
              </dd>
            </div>
          </dl>

          {account.scopes.length > 0 && (
            <p className="mt-1.5 break-words font-mono text-2xs text-ink-faint">
              {account.scopes.join(' · ')}
            </p>
          )}

          {/* A revoked token is invisible until a post fails, so when the
              platform has told us something is wrong it gets the loudest
              treatment on the row. */}
          {account.lastError && (
            <p
              className={cn(
                'mt-2.5 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs leading-relaxed',
                broken ? 'bg-danger-bg text-danger-fg' : 'bg-warn-bg text-warn-fg',
              )}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{account.lastError}</span>
            </p>
          )}

          {canManage &&
            (awaitingConfirm ? (
              <div className="mt-3 rounded-lg border border-danger-fg/25 bg-danger-bg px-3 py-2.5">
                <p className="text-xs leading-relaxed text-danger-fg">
                  Disconnect {account.displayName}? Anything already scheduled to this destination
                  falls back to the simulator, and nobody is told when it does.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="danger"
                    loading={busy === `disconnect:${account.id}`}
                    onClick={onDisconnect}
                  >
                    Yes, disconnect
                  </Button>
                  {/* Secondary rather than ghost: a ghost button sitting on the
                      tinted warning panel loses its edges in both themes. */}
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy === `disconnect:${account.id}`}
                    onClick={() => onConfirm(null)}
                  >
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {!account.isDefault && (
                  <Button
                    size="xs"
                    variant="secondary"
                    loading={busy === `default:${account.id}`}
                    disabled={busy !== null && busy !== `default:${account.id}`}
                    onClick={onSetDefault}
                  >
                    Post from this one instead
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => onConfirm(account.id)}
                >
                  Disconnect
                </Button>
              </div>
            ))}
        </div>
      </div>
    </li>
  )
}

function AccountAvatar({ account, hue }: { account: SocialAccountView; hue: number }) {
  const [failed, setFailed] = React.useState(false)

  // A plain img rather than next/image: these URLs live on LinkedIn and Meta
  // CDNs that are not in the image allowlist, and they expire, so a broken one
  // falls back to initials rather than leaving a hole in the row.
  if (account.avatarUrl && !failed) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        width={32}
        height={32}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-8 w-8 shrink-0 rounded-full border border-line object-cover"
      />
    )
  }
  return <Avatar name={account.displayName} size={32} hue={hue} />
}
