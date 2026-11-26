'use client'

import * as React from 'react'
import { AlertOctagon, Check, FileClock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/primitives'
import { RelativeTime } from '@/components/domain'

export type PushLogEntry = {
  id: string
  action: string
  ok: boolean
  simulated: boolean
  requestId: string | null
  operationCount: number
  request: Record<string, unknown> | null
  response: Record<string, unknown> | null
  error: string | null
  createdAt: string
  actorName: string | null
}

/**
 * Google's words for what happened, translated once. Anything unrecognised
 * falls through as-is rather than being hidden — an unlabelled row still tells
 * you something happened at a time.
 */
const ACTION_LABEL: Record<string, string> = {
  validate: "Checked against Google's rules",
  create: 'Sent to Google',
  enable: 'Turned on',
  pause: 'Paused',
}

export function PushHistory({ entries }: { entries: PushLogEntry[] }) {
  return (
    <Card>
      <CardHeader
        title="Everything sent to Google"
        description="One row for every attempt, kept whether it worked or not. This is the record of what was sent, and when."
        icon={<FileClock className="h-4 w-4" />}
      />
      {entries.length === 0 ? (
        <EmptyState
          title="Nothing has been sent yet"
          description="Once the campaign is checked or created in Google, every attempt is recorded here with the exact request and reply."
        />
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function Row({ entry }: { entry: PushLogEntry }) {
  const [open, setOpen] = React.useState(false)
  const label = ACTION_LABEL[entry.action] ?? entry.action

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
            entry.ok ? 'bg-ok-bg text-ok-fg' : 'bg-danger-bg text-danger-fg',
          )}
          aria-hidden
        >
          {entry.ok ? <Check className="h-3.5 w-3.5" /> : <AlertOctagon className="h-3.5 w-3.5" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[13.5px] font-medium text-ink">{label}</p>
            <Badge tone={entry.ok ? 'ok' : 'danger'}>{entry.ok ? 'Succeeded' : 'Failed'}</Badge>
            {entry.simulated && <Badge tone="warn">Not sent to Google</Badge>}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
            <RelativeTime date={entry.createdAt} />
            <span aria-hidden>·</span>
            <span className="tnum">
              {entry.operationCount} change{entry.operationCount === 1 ? '' : 's'}
            </span>
            {entry.actorName && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">by {entry.actorName}</span>
              </>
            )}
          </p>

          {entry.requestId && (
            /* Google support asks for this reference before anything else, so it
               is copyable text rather than something buried in the payload. */
            <p className="mt-1 break-all font-mono text-2xs text-ink-faint">
              Google reference {entry.requestId}
            </p>
          )}

          {entry.simulated && (
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              This was handled by the built-in checker. Google Ads was not connected, so nothing
              reached Google.
            </p>
          )}

          {!entry.ok && entry.error && (
            <p className="mt-2 rounded-lg bg-danger-bg px-3 py-2 text-[13px] leading-relaxed text-danger-fg">
              {entry.error}
            </p>
          )}

          {(entry.request || entry.response) && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-2 text-xs font-medium text-brand-600 hover:underline"
              aria-expanded={open}
            >
              {open ? 'Hide what was sent' : 'Show exactly what was sent'}
            </button>
          )}

          {open && (
            <div className="mt-2.5 space-y-2.5">
              {entry.request && <Payload label="Sent" value={entry.request} />}
              {entry.response && <Payload label="Received" value={entry.response} />}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

function Payload({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div>
      <p className="label mb-1">{label}</p>
      {/* Scrolls in both directions inside its own box. A payload with a very
          long resource name must never widen the page on a phone. */}
      <div className="max-h-80 overflow-auto rounded-lg border border-line bg-bg-inset">
        <pre className="p-3 font-mono text-2xs leading-relaxed text-ink-muted">
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>
    </div>
  )
}
