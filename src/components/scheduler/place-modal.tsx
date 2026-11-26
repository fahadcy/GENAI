'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CalendarClock, Sparkles } from 'lucide-react'
import { Modal, useToast } from '@/components/ui/client'
import { Button, Field, Input, Select } from '@/components/ui/primitives'
import { ChannelChip, formatCompact } from '@/components/domain'
import { scheduleAssetAction, conflictsForAction, suggestSendTimeAction } from '@/app/actions/scheduler'
import type { CandidateView, ConflictView, SegmentOption } from './types'
import { ConflictList, SendTimeHistogram } from './bits'
import { fmtTimeIn, fromLocalInput, fromZoned, toLocalInput, weekdayOf, addDays, dayKeyIn } from './time'

type Suggestion = {
  weekday: number
  hour: number
  predictedLift: number
  rationale: string
  distribution: { hour: number; weight: number }[]
}

/**
 * Placing an approved asset (SC-2 + SC-3 + SC-5 in one dialog): the model's slot
 * and its reasoning sit next to a manual override, and every constraint that
 * would block the chosen time is shown *before* the button is pressed.
 */
export function PlaceModal({
  candidate,
  defaultIso,
  segments,
  tz,
  onClose,
}: {
  candidate: CandidateView
  defaultIso: string
  segments: SegmentOption[]
  tz: string
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()

  const [segmentId, setSegmentId] = React.useState<string>(segments[0]?.id ?? '')
  const [local, setLocal] = React.useState(() => toLocalInput(defaultIso, tz))
  const [conflicts, setConflicts] = React.useState<ConflictView[] | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [suggestion, setSuggestion] = React.useState<Suggestion | null>(null)
  const [suggesting, setSuggesting] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const iso = fromLocalInput(local, tz)
  const segment = segments.find((s) => s.id === segmentId)
  const reach = segment ? (segment.reachability[candidate.channel] ?? segment.reachableSize) : null

  /* Conflicts are re-checked as the marketer types, so the dialog never says
     "blocked" only after they commit. */
  React.useEffect(() => {
    if (!iso) return
    let live = true
    setChecking(true)
    const t = setTimeout(() => {
      conflictsForAction({
        assetId: candidate.assetId,
        channel: candidate.channel,
        segmentId: segmentId || null,
        scheduledAt: iso,
      })
        .then((c) => live && setConflicts(c as ConflictView[]))
        .finally(() => live && setChecking(false))
    }, 280)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [iso, segmentId, candidate.assetId, candidate.channel])

  const soft = (conflicts ?? []).filter((c) => c.kind !== 'approval')
  const hard = (conflicts ?? []).filter((c) => c.kind === 'approval')

  async function suggest() {
    setSuggesting(true)
    try {
      const s = (await suggestSendTimeAction(candidate.channel, segmentId || null)) as Suggestion
      setSuggestion(s)
    } finally {
      setSuggesting(false)
    }
  }

  function applySuggestion(s: Suggestion) {
    setLocal(toLocalInput(nextSlot(s.weekday, s.hour, tz), tz))
  }

  async function place(force: boolean, useModelSlot = false) {
    if (!iso && !useModelSlot) return
    setBusy(true)
    try {
      const r = await scheduleAssetAction({
        assetId: candidate.assetId,
        segmentId: segmentId || null,
        scheduledAt: useModelSlot ? undefined : iso!,
        force,
      })
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Scheduled' : 'Not scheduled', body: r.message })
      if (r.ok) {
        router.refresh()
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="lg"
      title={candidate.title}
      description={`${candidate.campaignName ?? 'No campaign'} · approved v${candidate.version}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {soft.length > 0 && hard.length === 0 && (
            <Button variant="secondary" size="sm" loading={busy} onClick={() => place(true)}>
              Place anyway
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!iso || hard.length > 0 || soft.length > 0}
            onClick={() => place(false)}
          >
            Schedule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <ChannelChip channel={candidate.channel} />
          {candidate.compositeScore !== null && (
            <span className="text-xs text-ink-muted">Composite score {candidate.compositeScore}</span>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Audience"
            hint={
              reach !== null
                ? `${formatCompact(reach)} reachable on ${candidate.channel.replace('_', ' ')} after consent and suppression.`
                : 'Frequency caps and collision checks only apply once a segment is chosen.'
            }
          >
            <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
              <option value="">No segment (broadcast)</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {formatCompact(s.reachability[candidate.channel] ?? s.reachableSize)} reachable
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Send at" hint={`Workspace timezone — ${tz}.`}>
            <Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
          </Field>
        </div>

        {/* ------------------------------------------------ SC-2 model slot */}
        <div className="rounded-lg border border-line bg-bg-subtle p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
              <div>
                <p className="text-[13px] font-semibold text-ink">Modelled send time</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  {suggestion
                    ? suggestion.rationale
                    : 'Combines when this segment historically engages with how this channel has performed here over the last 90 days.'}
                </p>
              </div>
            </div>
            <Button size="xs" variant="secondary" loading={suggesting} onClick={suggest} className="shrink-0">
              {suggestion ? 'Recompute' : 'Suggest'}
            </Button>
          </div>

          {suggestion && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700">
                  <CalendarClock className="h-3.5 w-3.5" />
                  {fmtTimeIn(new Date(nextSlot(suggestion.weekday, suggestion.hour, tz)), tz)} ·{' '}
                  {new Date(nextSlot(suggestion.weekday, suggestion.hour, tz)).toLocaleDateString('en-GB', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                    timeZone: tz,
                  })}
                </span>
                <span className="tnum text-xs font-semibold text-ok-fg">
                  +{Math.round(suggestion.predictedLift * 100)}% predicted lift
                </span>
                <Button size="xs" variant="ghost" onClick={() => applySuggestion(suggestion)}>
                  Use this slot
                </Button>
              </div>
              <SendTimeHistogram distribution={suggestion.distribution} bestHour={suggestion.hour} />
            </div>
          )}
        </div>

        {/* ------------------------------------------------- SC-5 conflicts */}
        <div>
          <p className="label mb-2">
            Constraint check {checking && <span className="ml-1 font-normal normal-case text-ink-faint">checking…</span>}
          </p>
          {conflicts === null ? (
            <p className="text-[13px] text-ink-faint">Choose a time to run the approval, blackout, frequency and collision checks.</p>
          ) : conflicts.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-ok-fg">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              Clear on all four checks — approval, blackout windows, frequency caps and same-hour collisions.
            </p>
          ) : (
            <ConflictList conflicts={conflicts} tz={tz} onUseSuggestion={(d) => setLocal(toLocalInput(d, tz))} />
          )}
        </div>

        {hard.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-danger-bg p-3 text-xs leading-relaxed text-danger-fg">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            The approval gate cannot be overridden from the calendar. Send the asset back through review first.
          </p>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-xs leading-relaxed text-ink-faint">
            Prefer not to pick? The model can choose the slot and record its reasoning against the item.
          </p>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={hard.length > 0}
            onClick={() => place(false, true)}
            className="shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Let the model place it
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Next occurrence of a weekday/hour pair, read in the workspace timezone. */
function nextSlot(weekday: number, hour: number, tz: string): string {
  let key = dayKeyIn(new Date(), tz)
  for (let i = 0; i < 8; i++) {
    const candidate = addDays(key, i)
    if (weekdayOf(candidate) !== weekday) continue
    const at = fromZoned(candidate, hour, 0, tz)
    if (at.getTime() > Date.now()) return at.toISOString()
  }
  key = addDays(key, 1)
  return fromZoned(key, hour, 0, tz).toISOString()
}
