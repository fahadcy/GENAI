'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, Card } from '@/components/ui/primitives'
import { Modal, Tabs, useToast } from '@/components/ui/client'
import { CHANNEL_META } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'
import { rescheduleAction } from '@/app/actions/scheduler'
import { Calendar, type CalendarView } from './calendar'
import { AttentionPanel, ConstraintsPanel, ReadyTray, SendTimePanel, StatusLegend } from './panels'
import { PlaceModal } from './place-modal'
import { ItemDetailModal } from './detail-modal'
import type {
  AttentionView,
  BlackoutView,
  CandidateView,
  Capabilities,
  CapView,
  DragPayload,
  ItemView,
  SegmentOption,
} from './types'
import {
  addMonths,
  dayKeyIn,
  fromZoned,
  hourIn,
  monthLabel,
  monthOf,
  partsIn,
  rangeLabel,
  weekGrid,
} from './time'

/**
 * The Scheduler's interactive surface.
 *
 * All of it is one client component because the calendar, the tray and the
 * dialogs share the same drag session: dropping an approved asset from the tray
 * onto a day has to open the placement dialog pre-filled with that slot, and
 * dropping an existing item has to move it and surface the conflict that stopped
 * it. Splitting that across islands would mean lifting the same state anyway.
 */
export function SchedulerBoard({
  items,
  blackoutsInRange,
  upcomingBlackouts,
  candidates,
  attention,
  capPressure,
  segments,
  sendTime,
  channels,
  tz,
  weekStartsOn,
  todayKey,
  caps,
}: {
  items: ItemView[]
  blackoutsInRange: BlackoutView[]
  upcomingBlackouts: BlackoutView[]
  candidates: CandidateView[]
  attention: AttentionView[]
  capPressure: CapView[]
  segments: SegmentOption[]
  sendTime: { total: number; ai: number; manual: number; avgLift: number | null; aiUpcoming: number }
  channels: string[]
  tz: string
  weekStartsOn: number
  todayKey: string
  caps: Capabilities
}) {
  const router = useRouter()
  const toast = useToast()

  const [view, setView] = React.useState<CalendarView>('month')
  const [monthKey, setMonthKey] = React.useState(() => monthOf(todayKey))
  const [weekAnchor, setWeekAnchor] = React.useState(todayKey)
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set())
  const [showPublished, setShowPublished] = React.useState(true)
  const [dragging, setDragging] = React.useState<DragPayload | null>(null)

  const [selected, setSelected] = React.useState<string | null>(null)
  const [placing, setPlacing] = React.useState<{ candidate: CandidateView; iso: string } | null>(null)
  const [override, setOverride] = React.useState<{ item: ItemView; iso: string; message: string } | null>(null)

  /* Optimistic moves keep the drag feeling instant while the action round-trips;
     they are dropped the moment the server sends a fresh list. */
  const [moves, setMoves] = React.useState<Record<string, string>>({})
  React.useEffect(() => setMoves({}), [items])

  const visibleChannels = React.useMemo(
    () => new Set(channels.filter((c) => !hidden.has(c))),
    [channels, hidden],
  )

  const effective = React.useMemo(
    () =>
      items
        .map((it) => (moves[it.id] ? { ...it, scheduledAt: moves[it.id] } : it))
        .filter((it) => showPublished || it.status !== 'published'),
    [items, moves, showPublished],
  )

  const byId = React.useMemo(() => new Map(effective.map((i) => [i.id, i])), [effective])
  const selectedItem = selected ? byId.get(selected) ?? null : null

  /* ------------------------------------------------------------ navigation */

  const step = (delta: number) => {
    if (view === 'month') setMonthKey((m) => addMonths(m, delta))
    else setWeekAnchor((w) => shiftWeek(w, delta))
  }

  const goToday = () => {
    setMonthKey(monthOf(todayKey))
    setWeekAnchor(todayKey)
  }

  const jumpTo = (iso: string) => {
    const key = dayKeyIn(new Date(iso), tz)
    setMonthKey(monthOf(key))
    setWeekAnchor(key)
  }

  const expandDay = (dayKey: string) => {
    setWeekAnchor(dayKey)
    setView('week')
  }

  /* ------------------------------------------------------------------ drop */

  async function handleDrop(target: { dayKey: string; hour: number | null }) {
    const payload = dragging
    setDragging(null)
    if (!payload) return

    if (payload.kind === 'candidate') {
      const candidate = candidates.find((c) => c.assetId === payload.assetId)
      if (!candidate) return
      // A day-level drop has no hour of its own; 09:00 is a defensible default
      // that the dialog then invites the marketer (or the model) to change.
      const iso = fromZoned(target.dayKey, target.hour ?? 9, 0, tz).toISOString()
      setPlacing({ candidate, iso })
      return
    }

    const item = byId.get(payload.id)
    if (!item) return
    const current = new Date(item.scheduledAt)
    const hour = target.hour ?? hourIn(current, tz)
    const minute = target.hour === null ? partsIn(current, tz).minute : 0
    const to = fromZoned(target.dayKey, hour, minute, tz)
    if (to.getTime() === current.getTime()) return

    const iso = to.toISOString()
    setMoves((m) => ({ ...m, [item.id]: iso }))

    const r = await rescheduleAction(item.id, iso, false)
    if (r.ok) {
      toast.push({
        tone: 'ok',
        title: 'Moved',
        body: `"${item.assetTitle}" now sends ${to.toLocaleString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: tz,
        })}.`,
      })
      router.refresh()
    } else {
      // Roll the chip back to where it was and let the marketer decide whether
      // the conflict is one they are entitled to override.
      setMoves((m) => {
        const next = { ...m }
        delete next[item.id]
        return next
      })
      setOverride({ item, iso, message: r.message })
    }
  }

  async function forceMove() {
    if (!override) return
    const { item, iso } = override
    setOverride(null)
    setMoves((m) => ({ ...m, [item.id]: iso }))
    const r = await rescheduleAction(item.id, iso, true)
    toast.push({
      tone: r.ok ? 'ok' : 'danger',
      title: r.ok ? 'Moved with an override' : 'Still blocked',
      body: r.ok ? 'The override is on the audit trail against this item.' : r.message,
    })
    if (!r.ok) {
      setMoves((m) => {
        const next = { ...m }
        delete next[item.id]
        return next
      })
    }
    router.refresh()
  }

  const ready = candidates.filter((c) => c.ready)
  const blocked = candidates.filter((c) => !c.ready)
  const weekKeys = weekGrid(weekAnchor, weekStartsOn)

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      {/* ------------------------------------------------------- calendar */}
      <div className="min-w-0 space-y-5">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-lg border border-line">
                <button
                  onClick={() => step(-1)}
                  aria-label="Previous"
                  className="rounded-l-lg px-1.5 py-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="h-4 w-px bg-line" />
                <button
                  onClick={() => step(1)}
                  aria-label="Next"
                  className="rounded-r-lg px-1.5 py-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">
                {view === 'month' ? monthLabel(monthKey) : rangeLabel(weekKeys)}
              </h2>
              <Button size="xs" variant="ghost" onClick={goToday}>
                Today
              </Button>
            </div>

            <Tabs
              value={view}
              onChange={(v) => setView(v as CalendarView)}
              tabs={[
                { value: 'month', label: 'Month' },
                { value: 'week', label: 'Week' },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1">
              {channels.map((c) => {
                const meta = CHANNEL_META[c as Channel]
                const on = !hidden.has(c)
                const Icon = meta?.icon
                return (
                  <button
                    key={c}
                    onClick={() =>
                      setHidden((h) => {
                        const next = new Set(h)
                        if (next.has(c)) next.delete(c)
                        else next.add(c)
                        return next
                      })
                    }
                    aria-pressed={on}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium transition-all',
                      on ? 'tint' : 'text-ink-faint line-through opacity-60 hover:opacity-100',
                    )}
                    style={on ? ({ '--h': meta?.hue ?? 250 } as React.CSSProperties) : undefined}
                  >
                    {Icon && <Icon className="h-3 w-3" />}
                    {meta?.short ?? c}
                  </button>
                )
              })}
              {hidden.size > 0 && (
                <button
                  onClick={() => setHidden(new Set())}
                  className="ml-1 text-2xs font-semibold text-brand-600 hover:underline"
                >
                  Show all
                </button>
              )}
            </div>

            <button
              onClick={() => setShowPublished((v) => !v)}
              className="inline-flex items-center gap-1.5 text-2xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              {showPublished ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {showPublished ? 'Showing published' : 'Upcoming only'}
            </button>
          </div>

          <Calendar
            view={view}
            monthKey={monthKey}
            weekAnchor={weekAnchor}
            weekStartsOn={weekStartsOn}
            tz={tz}
            todayKey={todayKey}
            items={effective}
            blackouts={blackoutsInRange}
            visibleChannels={visibleChannels}
            canEdit={caps.edit}
            dragging={dragging}
            onDragStateChange={setDragging}
            onOpenItem={(i) => setSelected(i.id)}
            onDrop={handleDrop}
            onExpandDay={expandDay}
          />

          <div className="border-t border-line px-4 py-2.5">
            <StatusLegend />
          </div>
        </Card>

        <ConstraintsPanel blackouts={upcomingBlackouts} caps={capPressure} tz={tz} onJump={jumpTo} />
      </div>

      {/* ---------------------------------------------------------- rail */}
      <div className="space-y-4">
        <SendTimePanel summary={sendTime} />
        <ReadyTray
          ready={ready}
          blocked={blocked}
          caps={caps}
          onDragStateChange={setDragging}
          onPlace={(c) => setPlacing({ candidate: c, iso: defaultPlacement(tz) })}
        />
        <AttentionPanel items={attention} caps={caps} onOpen={(id) => setSelected(id)} />
      </div>

      {/* -------------------------------------------------------- dialogs */}
      {selectedItem && (
        <ItemDetailModal item={selectedItem} tz={tz} caps={caps} onClose={() => setSelected(null)} />
      )}

      {placing && (
        <PlaceModal
          candidate={placing.candidate}
          defaultIso={placing.iso}
          segments={segments}
          tz={tz}
          onClose={() => setPlacing(null)}
        />
      )}

      {override && (
        <Modal
          open
          onClose={() => setOverride(null)}
          size="md"
          title="That slot conflicts with a workspace rule"
          description={`Moving "${override.item.assetTitle}" to ${new Date(override.iso).toLocaleString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: tz,
          })}.`}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setOverride(null)}>
                Leave it where it was
              </Button>
              <Button size="sm" variant="secondary" onClick={forceMove}>
                Move anyway
              </Button>
            </>
          }
        >
          <p className="rounded-lg bg-warn-bg p-3 text-[13px] leading-relaxed text-warn-fg">{override.message}</p>
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            Blackout windows, frequency caps and same-hour collisions can be overridden by someone with scheduling
            rights, and the override is written to the audit trail. The approval gate cannot — an unapproved asset
            never gets a slot, whatever the override.
          </p>
        </Modal>
      )}
    </div>
  )
}

function shiftWeek(anchor: string, delta: number): string {
  const d = new Date(`${anchor}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta * 7)
  return d.toISOString().slice(0, 10)
}

/** Tomorrow at 09:00 in the workspace zone — a slot the gate will actually accept. */
function defaultPlacement(tz: string): string {
  const key = dayKeyIn(new Date(Date.now() + 86_400_000), tz)
  return fromZoned(key, 9, 0, tz).toISOString()
}
