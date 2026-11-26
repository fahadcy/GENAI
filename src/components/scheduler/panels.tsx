'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertOctagon,
  CalendarCheck2,
  CalendarX2,
  GripVertical,
  Lock,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, EmptyState, ProgressBar } from '@/components/ui/primitives'
import { Disclosure, useToast } from '@/components/ui/client'
import { ChannelChip, RelativeTime, ScheduleStatusBadge, channelLabel } from '@/components/domain'
import { replayAction } from '@/app/actions/scheduler'
import type { AttentionView, BlackoutView, CandidateView, CapView, Capabilities, DragPayload } from './types'

/* ---------------------------------------------------- SC-3: the gate tray */

export function ReadyTray({
  ready,
  blocked,
  caps,
  onDragStateChange,
  onPlace,
}: {
  ready: CandidateView[]
  blocked: CandidateView[]
  caps: Capabilities
  onDragStateChange: (d: DragPayload | null) => void
  onPlace: (candidate: CandidateView) => void
}) {
  return (
    <Card>
      <CardHeader
        title="Ready to schedule"
        description={
          ready.length > 0
            ? 'Fully approved and unplaced. Drag one onto the calendar, or place it with the model’s slot.'
            : 'Only assets that cleared every approval step reach this tray.'
        }
        actions={<Badge tone={ready.length > 0 ? 'ok' : 'neutral'}>{ready.length}</Badge>}
      />

      {ready.length === 0 ? (
        <EmptyState
          className="py-8"
          icon={<CalendarCheck2 className="h-5 w-5" />}
          title="Nothing is waiting for a slot"
          description="Every approved asset is already on the calendar. New work appears here the moment it clears its last approval step."
        />
      ) : (
        <ul className="divide-y divide-line">
          {ready.map((c) => (
            <li
              key={c.assetId}
              draggable={caps.create}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy'
                e.dataTransfer.setData('text/plain', c.assetId)
                onDragStateChange({ kind: 'candidate', assetId: c.assetId })
              }}
              onDragEnd={() => onDragStateChange(null)}
              className={cn(
                'group flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-surface-hover',
                caps.create && 'cursor-grab active:cursor-grabbing',
              )}
            >
              {caps.create && (
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
              )}
              <ChannelChip channel={c.channel} size="sm" showLabel={false} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">{c.title}</p>
                <p className="truncate text-2xs text-ink-faint">
                  {c.campaignName ?? 'No campaign'} · approved v{c.version}
                  {c.compositeScore !== null && ` · score ${c.compositeScore}`}
                </p>
              </div>
              {caps.create && (
                <Button size="xs" variant="secondary" onClick={() => onPlace(c)} className="shrink-0">
                  Place
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <div className="border-t border-line px-3 py-3">
          <Disclosure
            /* When there is nothing to place, the reason why is the whole point
               of the panel — open it rather than hiding it behind a chevron. */
            defaultOpen={ready.length === 0}
            summary={
              <span className="inline-flex items-center gap-1.5">
                <Lock className="h-3 w-3" />
                {blocked.length} asset{blocked.length === 1 ? '' : 's'} the gate is holding back
              </span>
            }
          >
            <ul className="space-y-2">
              {blocked.map((b) => (
                <li key={b.assetId} className="rounded-lg bg-bg-subtle p-2.5">
                  <div className="flex items-center gap-2">
                    <ChannelChip channel={b.channel} size="sm" showLabel={false} />
                    <Link
                      href={`/studio/${b.assetId}`}
                      className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink hover:text-brand-600"
                    >
                      {b.title}
                    </Link>
                    <Badge tone={b.status === 'changes_requested' ? 'danger' : b.status === 'in_review' ? 'warn' : 'neutral'}>
                      {b.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{b.blockedReason}</p>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------ SC-4: the failure queue */

export function AttentionPanel({
  items,
  caps,
  onOpen,
}: {
  items: AttentionView[]
  caps: Capabilities
  onOpen: (scheduleItemId: string) => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)

  async function replay(id: string) {
    setBusy(id)
    try {
      const r = await replayAction(id)
      toast.push({
        tone: r.ok ? 'ok' : 'danger',
        title: r.ok ? 'Replayed' : 'Still failing',
        body: r.message,
      })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const dead = items.filter((i) => i.status === 'dead_letter').length

  return (
    <Card>
      <CardHeader
        title="Needs attention"
        description="Failed publishes are held, never dropped. Replay one once the channel is back."
        actions={
          items.length > 0 ? (
            <Badge tone={dead > 0 ? 'danger' : 'warn'} dot>
              {items.length}
            </Badge>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck2 className="h-5 w-5" />}
          title="The publish queue is clean"
          description="No item is retrying and nothing has been dead-lettered. Failures would show here with the provider's own error text."
        />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <ChannelChip channel={i.channel} size="sm" showLabel={false} />
                <button
                  onClick={() => onOpen(i.id)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:text-brand-600"
                >
                  {i.assetTitle}
                </button>
                <ScheduleStatusBadge status={i.status} />
              </div>
              <p className="mt-1 font-mono text-2xs leading-relaxed text-ink-muted">{i.lastError}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className="text-2xs text-ink-faint">
                  {i.attempts} attempt{i.attempts === 1 ? '' : 's'} · due <RelativeTime date={i.scheduledAt} />
                  {i.nextRetryAt && (
                    <>
                      {' '}
                      · retry <RelativeTime date={i.nextRetryAt} />
                    </>
                  )}
                </p>
                {caps.publish && (
                  <Button size="xs" variant="secondary" loading={busy === i.id} onClick={() => replay(i.id)}>
                    <RotateCcw className="h-3 w-3" />
                    Replay
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ---------------------------------------- SC-5: blackouts and frequency caps */

export function ConstraintsPanel({
  blackouts,
  caps,
  tz,
  onJump,
}: {
  blackouts: BlackoutView[]
  caps: CapView[]
  tz: string
  onJump: (iso: string) => void
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader
          title="Blackout windows"
          description="Shaded on the calendar. Placing inside one needs a deliberate override."
          icon={<CalendarX2 className="h-4 w-4" />}
        />
        {blackouts.length === 0 ? (
          <EmptyState
            icon={<CalendarX2 className="h-5 w-5" />}
            title="No windows ahead"
            description="Add one in workspace settings before a holiday shutdown or a quiet period."
          />
        ) : (
          <ul className="divide-y divide-line">
            {blackouts.map((b) => {
              const start = new Date(b.startsAt)
              const end = new Date(b.endsAt)
              const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000))
              return (
                <li key={b.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-ink">{b.name}</p>
                      <p className="tnum mt-0.5 text-xs text-ink-muted">
                        {start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz })}
                        {' → '}
                        {end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz })}
                        <span className="text-ink-faint"> · {days} day{days === 1 ? '' : 's'}</span>
                      </p>
                    </div>
                    <button
                      onClick={() => onJump(b.startsAt)}
                      className="shrink-0 text-xs font-semibold text-brand-600 underline-offset-2 hover:underline"
                    >
                      Show
                    </button>
                  </div>
                  {b.reason && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{b.reason}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {b.channels.length === 0 ? (
                      <Badge tone="warn">Every channel</Badge>
                    ) : (
                      b.channels.map((c) => (
                        <Badge key={c} tone="warn">
                          {channelLabel(c)}
                        </Badge>
                      ))
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Frequency caps"
          description="Headroom left per channel, measured over the same window the scheduler enforces."
        />
        {caps.length === 0 ? (
          <EmptyState
            icon={<AlertOctagon className="h-5 w-5" />}
            title="No caps configured"
            description="Without a cap, nothing stops the same segment receiving several messages in a row on one channel."
          />
        ) : (
          <ul className="divide-y divide-line">
            {caps.map((c) => {
              const pct = c.maxPerContact > 0 ? c.peakCount / c.maxPerContact : 0
              return (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <ChannelChip channel={c.channel} size="sm" />
                    </div>
                    <span
                      className={cn(
                        'tnum text-xs font-semibold',
                        pct >= 1 ? 'text-danger-fg' : pct >= 0.67 ? 'text-warn-fg' : 'text-ink-muted',
                      )}
                    >
                      {c.peakCount} / {c.maxPerContact}
                    </span>
                  </div>
                  <ProgressBar
                    className="mt-2"
                    value={Math.min(c.peakCount, c.maxPerContact)}
                    max={c.maxPerContact}
                    tone={pct >= 1 ? 'danger' : pct >= 0.67 ? 'warn' : 'ok'}
                  />
                  <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                    {c.peakSegment
                      ? `"${c.peakSegment}" is the busiest audience — ${c.peakCount} send${c.peakCount === 1 ? '' : 's'} inside the ±${c.windowDays}-day window, against a cap of ${c.maxPerContact} per contact.`
                      : `Nothing placed on this channel inside the ±${c.windowDays}-day window. Cap is ${c.maxPerContact} per contact.`}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------- SC-2: model coverage */

export function SendTimePanel({
  summary,
}: {
  summary: { total: number; ai: number; manual: number; avgLift: number | null; aiUpcoming: number }
}) {
  const share = summary.total > 0 ? summary.ai / summary.total : 0
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label">AI send times</p>
          <p className="tnum mt-1 text-2xl font-semibold leading-none tracking-tight text-ink">
            {Math.round(share * 100)}%
          </p>
        </div>
        {summary.avgLift !== null && (
          <div className="shrink-0 text-right">
            <p className="label whitespace-nowrap">Avg. lift</p>
            <p className="tnum mt-1 text-2xl font-semibold leading-none tracking-tight text-ok-fg">
              +{Math.round(summary.avgLift * 100)}%
            </p>
          </div>
        )}
      </div>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-bg-inset">
        <span className="bg-brand-600" style={{ width: `${share * 100}%` }} />
        <span className="flex-1 bg-line-strong" />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">
        {summary.ai} of {summary.total} placed items use a model-chosen slot; {summary.manual} were set by hand.
        {summary.aiUpcoming > 0 && ` ${summary.aiUpcoming} model slot${summary.aiUpcoming === 1 ? ' is' : 's are'} still ahead and can be overridden.`}
      </p>
    </Card>
  )
}

/* ------------------------------------------------------------- legend bits */

export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <RefreshCw className="h-3 w-3 text-warn-fg" /> retrying
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AlertOctagon className="h-3 w-3 text-danger-fg" /> dead letter
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded-sm"
          style={{
            backgroundImage:
              'repeating-linear-gradient(135deg, rgb(var(--warn-fg) / 0.4) 0 3px, transparent 3px 7px)',
          }}
        />
        blackout window
      </span>
      <span>Faded chips have already published.</span>
    </div>
  )
}
