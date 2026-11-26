'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, RotateCcw, Send, Sparkles } from 'lucide-react'
import { Modal, ConfirmButton, useToast } from '@/components/ui/client'
import { Button, Field, Input, KeyValue } from '@/components/ui/primitives'
import { ChannelChip, RelativeTime, ScheduleStatusBadge, formatCompact } from '@/components/domain'
import {
  cancelScheduleAction,
  conflictsForAction,
  publishNowAction,
  replayAction,
  rescheduleAction,
  suggestSendTimeAction,
} from '@/app/actions/scheduler'
import type { Capabilities, ConflictView, ItemView } from './types'
import { ConflictList, SendTimeHistogram, SourceBadge } from './bits'
import { addDays, dayKeyIn, fromLocalInput, fromZoned, hourIn, toLocalInput, weekdayOf } from './time'

type Suggestion = {
  weekday: number
  hour: number
  predictedLift: number
  rationale: string
  distribution: { hour: number; weight: number }[]
}

export function ItemDetailModal({
  item,
  tz,
  caps,
  onClose,
}: {
  item: ItemView
  tz: string
  caps: Capabilities
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()

  const [local, setLocal] = React.useState(() => toLocalInput(item.scheduledAt, tz))
  const [conflicts, setConflicts] = React.useState<ConflictView[] | null>(null)
  const [suggestion, setSuggestion] = React.useState<Suggestion | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const iso = fromLocalInput(local, tz)
  const moved = iso !== null && iso !== new Date(item.scheduledAt).toISOString()
  const settled = item.status === 'published'

  /**
   * The conflict preview only runs once a different time is chosen. The shared
   * `conflictsForAction` cannot be told to exclude the item being moved, so at
   * the item's own slot it would always report a collision with itself. The
   * reschedule action does exclude it, so previewing only real moves keeps the
   * dialog and the action telling the same story.
   */
  React.useEffect(() => {
    if (settled || !iso || !moved) {
      setConflicts(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      conflictsForAction({
        assetId: item.assetId,
        channel: item.channel,
        segmentId: item.segmentId,
        scheduledAt: iso,
      }).then((c) => live && setConflicts(c as ConflictView[]))
    }, 280)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [iso, moved, item.assetId, item.channel, item.segmentId, settled])

  // A collision inside the hour this item already occupies is this item.
  const sameHour =
    iso !== null &&
    dayKeyIn(new Date(iso), tz) === dayKeyIn(new Date(item.scheduledAt), tz) &&
    hourIn(new Date(iso), tz) === hourIn(new Date(item.scheduledAt), tz)

  const shown = (conflicts ?? []).filter((c) => !(c.kind === 'collision' && sameHour))
  const soft = shown.filter((c) => c.kind !== 'approval')
  const hard = shown.filter((c) => c.kind === 'approval')

  const canReplay = caps.publish && (item.status === 'dead_letter' || item.status === 'failed')
  const canAct = caps.edit && !settled
  const hasFooter = canAct || canReplay || (caps.publish && !settled)

  async function run(key: string, fn: () => Promise<{ ok: boolean; message: string }>, closeOnOk = true) {
    setBusy(key)
    try {
      const r = await fn()
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Done' : 'Blocked', body: r.message })
      router.refresh()
      if (r.ok && closeOnOk) onClose()
    } finally {
      setBusy(null)
    }
  }

  async function reoptimise() {
    setBusy('suggest')
    try {
      const s = (await suggestSendTimeAction(item.channel, item.segmentId)) as Suggestion
      setSuggestion(s)
      setLocal(toLocalInput(nextSlot(s.weekday, s.hour, tz), tz))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="lg"
      title={item.assetTitle}
      description={`${item.campaignName ?? 'No campaign'} · ${item.segmentName ?? 'no segment'}`}
      footer={
        !hasFooter ? undefined : (
        <>
          {canAct && (
            <ConfirmButton
              size="sm"
              variant="ghost"
              className="mr-auto text-danger-fg"
              title="Cancel this scheduled send?"
              description="The slot is released and the asset returns to the approved pool, still approved."
              confirmLabel="Cancel send"
              onConfirm={() => run('cancel', () => cancelScheduleAction(item.id))}
            >
              Cancel send
            </ConfirmButton>
          )}
          {canReplay && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'replay'}
              onClick={() => run('replay', () => replayAction(item.id), false)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Replay
            </Button>
          )}
          {caps.publish && !settled && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'publish'}
              onClick={() => run('publish', () => publishNowAction(item.id), false)}
            >
              <Send className="h-3.5 w-3.5" />
              Publish now
            </Button>
          )}
          {canAct && (
            <Button
              size="sm"
              variant="primary"
              disabled={!moved || hard.length > 0}
              loading={busy === 'move'}
              onClick={() => run('move', () => rescheduleAction(item.id, iso!, soft.length > 0))}
            >
              {soft.length > 0 ? 'Move anyway' : 'Move'}
            </Button>
          )}
        </>
        )
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <ScheduleStatusBadge status={item.status} />
          <ChannelChip channel={item.channel} />
          <SourceBadge source={item.sendTimeSource} lift={item.predictedLift} />
          {item.compositeScore !== null && (
            <span className="text-xs text-ink-muted">Composite {item.compositeScore}</span>
          )}
        </div>

        <KeyValue
          items={[
            {
              label: 'Asset',
              value: (
                <Link
                  href={`/studio/${item.assetId}`}
                  className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline"
                >
                  {item.assetTitle}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              ),
            },
            {
              label: 'Audience',
              value: item.segmentName
                ? `${item.segmentName}${item.reach !== null ? ` · ${formatCompact(item.reach)} reachable` : ''}`
                : 'No segment — broadcast, so frequency caps do not apply',
            },
            {
              label: 'Slot',
              value: (
                <span className="tnum">
                  {new Date(item.scheduledAt).toLocaleString('en-GB', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: tz,
                  })}{' '}
                  <span className="text-ink-faint">
                    ({item.timezone})
                    {item.status === 'scheduled' && (
                      <>
                        {' · '}
                        <RelativeTime date={item.scheduledAt} />
                      </>
                    )}
                  </span>
                </span>
              ),
            },
            { label: 'Placed by', value: item.createdByName ?? 'System' },
            {
              label: 'Attempts',
              value: `${item.attempts}${item.attempts >= 5 ? ' — retry budget exhausted' : ''}`,
            },
            ...(item.publishedAt
              ? [
                  {
                    label: 'Published',
                    value: (
                      <span>
                        <RelativeTime date={item.publishedAt} />
                        {item.externalRef && <span className="ml-1.5 font-mono text-xs text-ink-faint">{item.externalRef}</span>}
                      </span>
                    ),
                  },
                ]
              : []),
            ...(item.nextRetryAt
              ? [{ label: 'Next retry', value: <RelativeTime date={item.nextRetryAt} /> }]
              : []),
          ]}
        />

        {item.lastError && (
          <div className="rounded-lg bg-danger-bg p-3">
            <p className="text-[13px] font-semibold text-danger-fg">
              {item.status === 'dead_letter' ? 'Dead-lettered after every retry' : 'Last attempt failed'}
            </p>
            <p className="mt-1 font-mono text-xs leading-relaxed text-ink-muted">{item.lastError}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              Nothing was lost — the item is held in the queue and can be replayed once the channel recovers.
            </p>
          </div>
        )}

        {/* --------------------------------------------------- SC-2 rationale */}
        <div className="rounded-lg border border-line bg-bg-subtle p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">
                  {item.sendTimeSource === 'ai' ? 'Why this slot' : 'Chosen by hand'}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  {suggestion?.rationale ??
                    item.sendTimeRationale ??
                    'This slot was set manually, so no model reasoning is attached to it. Re-optimising will replace it with a modelled slot and record the reasoning.'}
                </p>
                {item.sendTimeSource === 'ai' && item.predictedLift !== null && (
                  <p className="tnum mt-1.5 text-xs font-semibold text-ok-fg">
                    +{Math.round(item.predictedLift * 100)}% predicted lift over the workspace's average slot
                  </p>
                )}
              </div>
            </div>
            {canAct && (
              <Button size="xs" variant="secondary" loading={busy === 'suggest'} onClick={reoptimise} className="shrink-0">
                Re-optimise
              </Button>
            )}
          </div>
          {suggestion && (
            <div className="mt-3">
              <SendTimeHistogram distribution={suggestion.distribution} bestHour={suggestion.hour} />
            </div>
          )}
        </div>

        {/* ------------------------------------------------- manual override */}
        {canAct && (
          <div className="space-y-3">
            <Field
              label="Move to"
              hint={`Times are in ${tz}. Moving an item by hand clears its modelled slot and its recorded reasoning.`}
            >
              <Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
            </Field>

            {!moved ? (
              <p className="text-[13px] text-ink-faint">
                Pick a different time and the approval, blackout, frequency and collision checks run against it
                before you commit.
              </p>
            ) : conflicts === null ? (
              <p className="text-[13px] text-ink-faint">Checking the new slot…</p>
            ) : shown.length > 0 ? (
              <ConflictList conflicts={shown} tz={tz} onUseSuggestion={(d) => setLocal(toLocalInput(d, tz))} />
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-ok-fg">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                No approval, blackout, frequency or collision conflict at this time.
              </p>
            )}
          </div>
        )}

        {settled && (
          <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-faint">
            This send has already gone out, so it is read-only here. Its slot, audience, reasoning and the
            channel's own reference are kept on the record — the send can be reconstructed from the audit trail
            long after the campaign closes.
          </p>
        )}
      </div>
    </Modal>
  )
}

function nextSlot(weekday: number, hour: number, tz: string): string {
  const today = dayKeyIn(new Date(), tz)
  for (let i = 0; i < 8; i++) {
    const candidate = addDays(today, i)
    if (weekdayOf(candidate) !== weekday) continue
    const at = fromZoned(candidate, hour, 0, tz)
    if (at.getTime() > Date.now()) return at.toISOString()
  }
  return fromZoned(addDays(today, 1), hour, 0, tz).toISOString()
}
