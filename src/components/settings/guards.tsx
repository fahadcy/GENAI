'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CalendarOff, Gauge, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, EmptyState, Input, Select } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { ChannelChip, channelLabel } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'
import {
  deleteBlackoutWindow,
  deleteFrequencyCap,
  saveBlackoutWindow,
  saveFrequencyCap,
} from '@/app/(app)/settings/actions'
import { ALL_CHANNELS, ChannelPicker } from './bits'

export type BlackoutView = {
  id: string
  name: string
  startsAt: string
  endsAt: string
  channels: string[]
  reason: string | null
}

export type CapView = {
  id: string
  channel: string
  maxPerContact: number
  windowDays: number
}

/* ------------------------------------------------------------- blackouts */

type BlackoutDraft = {
  id?: string
  name: string
  startsAt: string
  endsAt: string
  channels: string[]
  reason: string
}

/** `datetime-local` wants a value with no zone, in the browser's own offset. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function BlackoutWindows({
  windows,
  canEdit,
  timezone,
}: {
  windows: BlackoutView[]
  canEdit: boolean
  timezone: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = React.useState<BlackoutDraft | null>(null)
  const [busy, setBusy] = React.useState(false)
  const now = Date.now()

  const save = async (draft: BlackoutDraft) => {
    setBusy(true)
    try {
      const result = await saveBlackoutWindow({
        ...draft,
        startsAt: new Date(draft.startsAt).toISOString(),
        endsAt: new Date(draft.endsAt).toISOString(),
        reason: draft.reason || undefined,
      })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      const result = await deleteBlackoutWindow(id)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const blank = (): BlackoutDraft => {
    const start = new Date(Date.now() + 86_400_000)
    const end = new Date(Date.now() + 3 * 86_400_000)
    return {
      name: '',
      startsAt: toLocalInput(start.toISOString()),
      endsAt: toLocalInput(end.toISOString()),
      channels: [],
      reason: '',
    }
  }

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Blackout windows"
          description="Dates on which the scheduler refuses to place anything. Approved work is simply held rather than cancelled."
          icon={<CalendarOff className="h-4 w-4" />}
          actions={
            canEdit && (
              <Button size="xs" variant="secondary" onClick={() => setEditing(blank())}>
                <Plus className="h-3 w-3" />
                New window
              </Button>
            )
          }
        />
        {windows.length === 0 ? (
          <EmptyState
            icon={<CalendarOff className="h-5 w-5" />}
            title="No blackout windows"
            description="Nothing is blocked. Teams usually add the December shutdown and any week when a results announcement or an incident makes outbound a bad idea."
          />
        ) : (
          <ul className="divide-y divide-line">
            {windows.map((w) => {
              const start = new Date(w.startsAt)
              const end = new Date(w.endsAt)
              const live = now >= start.getTime() && now <= end.getTime()
              const past = now > end.getTime()
              return (
                <li
                  key={w.id}
                  className={cn('flex items-start gap-3 px-5 py-3', past && 'opacity-55')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{w.name}</span>
                      {live && (
                        <Badge tone="danger" dot>
                          In force now
                        </Badge>
                      )}
                      {past && <Badge tone="neutral">Passed</Badge>}
                    </div>
                    <p className="tnum mt-0.5 text-xs text-ink-muted">
                      {formatWindow(start, end)}
                    </p>
                    {w.reason && <p className="mt-1 text-xs leading-snug text-ink-faint">{w.reason}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {w.channels.length === 0 ? (
                      <span className="text-2xs text-ink-faint">every channel</span>
                    ) : (
                      <div className="flex flex-wrap justify-end gap-1">
                        {w.channels.map((c) => (
                          <ChannelChip key={c} channel={c} size="sm" showLabel={false} />
                        ))}
                      </div>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            id: w.id,
                            name: w.name,
                            startsAt: toLocalInput(w.startsAt),
                            endsAt: toLocalInput(w.endsAt),
                            channels: w.channels,
                            reason: w.reason ?? '',
                          })
                        }
                        className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
                        aria-label={`Edit ${w.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <p className="border-t border-line bg-bg-subtle px-5 py-2.5 text-2xs text-ink-faint">
          Times are shown in your browser's zone. The workspace schedules in {timezone}.
        </p>
      </Card>

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          size="lg"
          title={editing.id ? 'Edit blackout window' : 'New blackout window'}
          description="Anything already scheduled inside the window is flagged so it can be moved before the window opens."
          footer={
            <>
              {editing.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mr-auto text-danger-fg"
                  onClick={() => void remove(editing.id!)}
                  disabled={busy}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!editing.name.trim() || !editing.startsAt || !editing.endsAt}
                onClick={() => void save(editing)}
              >
                Save window
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="bo-name" className="text-[13px] font-medium text-ink">
                Name
              </label>
              <Input
                id="bo-name"
                value={editing.name}
                placeholder="Christmas shutdown"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="bo-start" className="text-[13px] font-medium text-ink">
                  Starts
                </label>
                <Input
                  id="bo-start"
                  type="datetime-local"
                  value={editing.startsAt}
                  onChange={(e) => setEditing({ ...editing, startsAt: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bo-end" className="text-[13px] font-medium text-ink">
                  Ends
                </label>
                <Input
                  id="bo-end"
                  type="datetime-local"
                  value={editing.endsAt}
                  onChange={(e) => setEditing({ ...editing, endsAt: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-ink">Channels blocked</p>
              <ChannelPicker
                value={editing.channels}
                onChange={(channels) => setEditing({ ...editing, channels })}
                emptyMeans="every channel is blocked"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="bo-reason" className="text-[13px] font-medium text-ink">
                Reason <span className="font-normal text-ink-faint">(shown to anyone whose send is blocked)</span>
              </label>
              <Input
                id="bo-reason"
                value={editing.reason}
                placeholder="No outbound while the office is closed."
                onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function formatWindow(start: Date, end: Date): string {
  const fmt: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: start.getFullYear() === end.getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000))
  return `${start.toLocaleString('en-GB', fmt)} → ${end.toLocaleString('en-GB', { ...fmt, year: 'numeric' })} · ${days} day${days === 1 ? '' : 's'}`
}

/* -------------------------------------------------------- frequency caps */

export function FrequencyCaps({ caps, canEdit }: { caps: CapView[]; canEdit: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const uncapped = ALL_CHANNELS.filter((c) => !caps.some((cap) => cap.channel === c))

  const save = async (cap: { id?: string; channel: string; maxPerContact: number; windowDays: number }) => {
    setBusy(cap.id ?? 'new')
    try {
      const result = await saveFrequencyCap(cap)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setAdding(false)
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      const result = await deleteFrequencyCap(id)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Frequency caps"
        description="The most a single contact may receive on a channel. Enforced when a send is placed, so an over-cap audience is trimmed rather than the send failing."
        icon={<Gauge className="h-4 w-4" />}
        actions={
          canEdit &&
          uncapped.length > 0 && (
            <Button size="xs" variant="secondary" onClick={() => setAdding(true)}>
              <Plus className="h-3 w-3" />
              Cap a channel
            </Button>
          )
        }
      />

      {caps.length === 0 && !adding ? (
        <EmptyState
          icon={<Gauge className="h-5 w-5" />}
          title="No frequency caps"
          description="Every channel is currently uncapped, so a contact who matches several segments could receive every one of them."
        />
      ) : (
        <ul className="divide-y divide-line">
          {caps.map((cap) => (
            <CapRow
              key={cap.id}
              cap={cap}
              canEdit={canEdit}
              busy={busy === cap.id}
              onSave={save}
              onRemove={() => void remove(cap.id)}
            />
          ))}
          {adding && (
            <CapRow
              cap={{ id: '', channel: uncapped[0] ?? 'email', maxPerContact: 3, windowDays: 7 }}
              canEdit
              isNew
              channelOptions={uncapped}
              busy={busy === 'new'}
              onSave={(c) => save({ channel: c.channel, maxPerContact: c.maxPerContact, windowDays: c.windowDays })}
              onRemove={() => setAdding(false)}
            />
          )}
        </ul>
      )}
    </Card>
  )
}

function CapRow({
  cap,
  canEdit,
  busy,
  isNew,
  channelOptions,
  onSave,
  onRemove,
}: {
  cap: CapView
  canEdit: boolean
  busy: boolean
  isNew?: boolean
  channelOptions?: Channel[]
  onSave: (cap: CapView) => void
  onRemove: () => void
}) {
  const [draft, setDraft] = React.useState(cap)
  const dirty =
    draft.channel !== cap.channel ||
    draft.maxPerContact !== cap.maxPerContact ||
    draft.windowDays !== cap.windowDays

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="w-32 shrink-0">
        {isNew && channelOptions ? (
          <Select
            value={draft.channel}
            aria-label="Channel"
            className="h-8 py-1 text-[13px]"
            onChange={(e) => setDraft({ ...draft, channel: e.target.value })}
          >
            {channelOptions.map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </Select>
        ) : (
          <ChannelChip channel={draft.channel} size="md" />
        )}
      </div>

      <div className="flex flex-1 flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        <span>at most</span>
        <Input
          type="number"
          min={1}
          max={50}
          value={draft.maxPerContact}
          disabled={!canEdit}
          aria-label={`Maximum sends per contact on ${draft.channel}`}
          className="tnum h-8 w-16 py-1 text-[13px]"
          onChange={(e) => setDraft({ ...draft, maxPerContact: Number(e.target.value) })}
        />
        <span>message{draft.maxPerContact === 1 ? '' : 's'} per contact every</span>
        <Input
          type="number"
          min={1}
          max={90}
          value={draft.windowDays}
          disabled={!canEdit}
          aria-label={`Window in days for ${draft.channel}`}
          className="tnum h-8 w-16 py-1 text-[13px]"
          onChange={(e) => setDraft({ ...draft, windowDays: Number(e.target.value) })}
        />
        <span>day{draft.windowDays === 1 ? '' : 's'}</span>
      </div>

      {canEdit && (
        <div className="flex shrink-0 items-center gap-1.5">
          {(dirty || isNew) && (
            <Button size="xs" variant="primary" loading={busy} onClick={() => onSave(draft)}>
              {isNew ? 'Add cap' : 'Save'}
            </Button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
            aria-label={isNew ? 'Cancel' : `Remove the ${draft.channel} cap`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  )
}
