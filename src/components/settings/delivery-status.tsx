'use client'

import * as React from 'react'
import { AlertTriangle, CheckCircle2, Globe, KeyRound, Mail, MessageSquare, Send } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, Input } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { checkWebsiteAction, sendTestEmailAction, sendTestSmsAction } from '@/app/actions/delivery'

/**
 * Whether email and SMS are real yet — and a way to prove it in ten seconds.
 *
 * The status alone is not worth a screen: "configured" only means the variables
 * are present, and the three failures people actually hit (a read-only API key,
 * an unverified sender address, a username that is not the login email) all
 * look exactly like "configured" until something is sent. So the test send is
 * the point of this panel and the badge is the context.
 */

export type DeliveryConfig = {
  configured: boolean
  missing: string[]
  /** Shown so the person can see what recipients will see in the From line. */
  from?: string | null
}

export function DeliveryStatus({
  email,
  sms,
  website,
  canManage,
}: {
  email: DeliveryConfig
  sms: DeliveryConfig
  website: DeliveryConfig & { goesLive?: boolean }
  canManage: boolean
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Channel
        kind="email"
        title="Email — SendGrid"
        icon={<Mail className="h-4 w-4" />}
        config={email}
        canManage={canManage}
        placeholder="you@yourcompany.co.uk"
        simulated="Emails are being written, approved and scheduled, and every send is recorded as simulated. Nothing reaches an inbox."
        live={
          email.from
            ? `Live. Recipients will see it from ${email.from}.`
            : 'Live.'
        }
      />
      <Channel
        kind="sms"
        title="SMS — ClickSend"
        icon={<MessageSquare className="h-4 w-4" />}
        config={sms}
        canManage={canManage}
        placeholder="07700 900123"
        simulated="Texts are being drafted and scheduled but never sent. No credit is being spent."
        live="Live. Every text is charged per message to your ClickSend balance."
      />
      <Channel
        kind="website"
        title="Website — WordPress"
        icon={<Globe className="h-4 w-4" />}
        config={website}
        canManage={canManage}
        placeholder=""
        simulated="Blog posts are being written and approved but never reach the website."
        live={
          website.goesLive
            ? `Connected${website.from ? ` to ${website.from}` : ''}. An approved post goes live straight away.`
            : `Connected${website.from ? ` to ${website.from}` : ''}. An approved post is saved as a draft for you to check and publish. Set WORDPRESS_POST_STATUS="publish" once you are happy with how they look.`
        }
      />
    </div>
  )
}

function Channel({
  kind,
  title,
  icon,
  config,
  canManage,
  placeholder,
  simulated,
  live,
}: {
  kind: 'email' | 'sms' | 'website'
  title: string
  icon: React.ReactNode
  config: DeliveryConfig
  canManage: boolean
  placeholder: string
  simulated: string
  live: string
}) {
  const [to, setTo] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const toast = useToast()

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (busy || (kind !== 'website' && !to.trim())) return
    setBusy(true)
    try {
      const res =
        kind === 'email'
          ? await sendTestEmailAction({ to })
          : kind === 'sms'
            ? await sendTestSmsAction({ to })
            : await checkWebsiteAction()
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? (kind === 'website' ? 'Website reachable' : 'Test sent') : 'Not sent',
        body: res.message,
      })
      if (res.ok) setTo('')
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Nothing was sent',
        body: 'The request did not complete. Check your connection and try again.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-8 w-8 place-items-center rounded-lg',
              config.configured ? 'bg-ok-bg text-ok-fg' : 'bg-bg-inset text-ink-muted',
            )}
          >
            {icon}
          </span>
          <div>
            <p className="text-[13px] font-medium text-ink">{title}</p>
            <p className="text-[11px] text-ink-muted">
              {config.configured
              ? kind === 'website'
                ? 'Posting to the real site'
                : 'Sending for real'
              : 'Running on the simulator'}
            </p>
          </div>
        </div>
        <Badge tone={config.configured ? 'ok' : 'neutral'}>
          {config.configured ? (
            <>
              <CheckCircle2 className="h-3 w-3" /> Live
            </>
          ) : (
            <>
              <KeyRound className="h-3 w-3" /> Simulated
            </>
          )}
        </Badge>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
        {config.configured ? live : simulated}
      </p>

      {!config.configured && config.missing.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-warn-bg p-2.5 text-[11px] leading-relaxed text-warn-fg">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Add {config.missing.map((m, i) => (
              <React.Fragment key={m}>
                {i > 0 && ' and '}
                <code className="font-mono">{m}</code>
              </React.Fragment>
            ))}{' '}
            to <code className="font-mono">.env.local</code>, then restart the app. Environment
            variables are read once at boot.
          </span>
        </div>
      )}

      {config.configured && canManage && kind === 'website' && (
        <form onSubmit={send} className="mt-3">
          <Button type="submit" variant="secondary" disabled={busy}>
            <Send className="h-3.5 w-3.5" />
            {busy ? 'Checking…' : 'Test the connection'}
          </Button>
        </form>
      )}

      {config.configured && canManage && kind !== 'website' && (
        <form onSubmit={send} className="mt-3 flex gap-2">
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={placeholder}
            aria-label={kind === 'email' ? 'Test email address' : 'Test mobile number'}
            className="flex-1"
            disabled={busy}
          />
          <Button type="submit" variant="secondary" disabled={busy || !to.trim()}>
            <Send className="h-3.5 w-3.5" />
            {busy ? 'Sending…' : 'Send test'}
          </Button>
        </form>
      )}

      {config.configured && canManage && kind === 'sms' && (
        <p className="mt-2 text-[11px] text-ink-faint">
          A test text costs the same as a real one.
        </p>
      )}
    </Card>
  )
}
