'use client'

import * as React from 'react'
import { Check, Copy, Plus, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, Input } from '@/components/ui/primitives'
import { CHANNEL_META } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'

export const ALL_CHANNELS = Object.keys(CHANNEL_META) as Channel[]

/* ------------------------------------------------------------- setting row */

/** Label + explanation on the left, control on the right. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  className,
  stack,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
  /** Forces the control below the label rather than beside it. */
  stack?: boolean
}) {
  return (
    <div
      className={cn(
        'gap-x-6 gap-y-2 border-b border-line px-5 py-4 last:border-b-0',
        stack ? 'block' : 'grid sm:grid-cols-[minmax(0,1fr)_minmax(0,340px)] sm:items-start',
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
          {label}
        </label>
        {hint && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{hint}</p>}
      </div>
      <div className={cn('min-w-0', stack && 'mt-3')}>{children}</div>
    </div>
  )
}

/* ---------------------------------------------------------------- toggle */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-surface shadow-sm transition-transform',
          checked ? 'translate-x-[1.125rem]' : 'translate-x-[0.1875rem]',
        )}
      />
    </button>
  )
}

/* ---------------------------------------------------------------- slider */

/**
 * Tone axis control. The value is shown as a number as well as a position —
 * "playful 24" is a rule people quote to each other, so it has to be readable.
 */
export function AxisSlider({
  label,
  low,
  high,
  value,
  onChange,
  disabled,
  estimate,
}: {
  label: string
  low: string
  high: string
  value: number
  onChange: (next: number) => void
  disabled?: boolean
  /** Where the sample copy currently sits, drawn as a marker on the track. */
  estimate?: number
}) {
  const drift = estimate === undefined ? null : estimate - value
  const off = drift !== null && Math.abs(drift) > 12

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="tnum flex items-baseline gap-2 text-xs">
          {estimate !== undefined && (
            <span className={off ? 'font-semibold text-warn-fg' : 'text-ok-fg'}>
              sample {estimate}
            </span>
          )}
          <span className="font-semibold text-ink">{value}</span>
        </span>
      </div>
      <div className="relative mt-2">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className={cn(
            'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60',
            '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-600 [&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-surface',
            '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand-600',
          )}
        />
        {estimate !== undefined && (
          <span
            aria-hidden
            title={`Sample copy reads ${estimate}`}
            className={cn(
              'pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full',
              off ? 'bg-warn-fg' : 'bg-ok-fg',
            )}
            style={{ left: `calc(${estimate}% - 1px)` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-2xs text-ink-faint">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- list editor */

/** Editable list of short strings — do/don't rules, banned terms. */
export function StringListEditor({
  items,
  onChange,
  placeholder,
  addLabel,
  disabled,
  compact,
}: {
  items: string[]
  onChange: (next: string[]) => void
  placeholder: string
  addLabel: string
  disabled?: boolean
  /** Chip layout for single words rather than a row per sentence. */
  compact?: boolean
}) {
  const [draft, setDraft] = React.useState('')

  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (items.some((i) => i.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...items, value])
    setDraft('')
  }

  return (
    <div>
      {items.length > 0 &&
        (compact ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {items.map((item, i) => (
              <li
                key={`${item}-${i}`}
                className="inline-flex items-center gap-1 rounded-md bg-bg-inset px-2 py-1 text-xs text-ink"
              >
                <span className="font-mono">{item}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                    className="rounded text-ink-faint transition-colors hover:text-danger-fg"
                    aria-label={`Remove ${item}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="mb-2 space-y-1">
            {items.map((item, i) => (
              <li key={`${item}-${i}`} className="flex items-start gap-2">
                <Input
                  value={item}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(items.map((x, j) => (j === i ? e.target.value : x)))
                  }
                  className="h-8 py-1 text-[13px]"
                />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                    className="mt-1.5 shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-danger-fg"
                    aria-label={`Remove "${item}"`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ))}

      {!disabled && (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder={placeholder}
            className="h-8 py-1 text-[13px]"
          />
          <Button type="button" size="xs" variant="secondary" onClick={add} disabled={!draft.trim()}>
            <Plus className="h-3 w-3" />
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- channel picker */

export function ChannelPicker({
  value,
  onChange,
  disabled,
  emptyMeans = 'Every channel',
  channels = ALL_CHANNELS,
}: {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  emptyMeans?: string
  channels?: string[]
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {channels.map((channel) => {
          const meta = CHANNEL_META[channel as Channel]
          if (!meta) return null
          const on = value.includes(channel)
          return (
            <button
              key={channel}
              type="button"
              disabled={disabled}
              onClick={() => onChange(on ? value.filter((c) => c !== channel) : [...value, channel])}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                on
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink',
              )}
            >
              {on ? <Check className="h-3 w-3" /> : <meta.icon className="h-3 w-3" />}
              {meta?.label ?? channel}
            </button>
          )
        })}
      </div>
      {value.length === 0 && (
        <p className="mt-1.5 text-2xs text-ink-faint">Nothing selected — {emptyMeans.toLowerCase()}.</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- save bar */

/**
 * Sticky footer that only appears once something has actually changed. Settings
 * screens are long; a save button at the bottom of a 1,400px form is a trap.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
  summary,
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  summary?: string
}) {
  if (!dirty) return null
  return (
    <div className="sticky bottom-4 z-30 mt-4 flex animate-fade-up items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3 shadow-pop">
      <p className="min-w-0 truncate text-[13px] text-ink-muted">
        {summary ?? 'Unsaved changes.'}{' '}
        <span className="text-ink-faint">Saving writes an entry to the audit trail.</span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} loading={saving}>
          Save changes
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ copy button */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          /* clipboard blocked — the value is on screen to select by hand */
        }
      }}
    >
      {copied ? <Check className="h-3 w-3 text-ok-fg" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

/* ------------------------------------------------------ read-only notice */

export function ReadOnlyNotice({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-bg-subtle px-3.5 py-2.5">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
      <p className="text-[13px] leading-relaxed text-ink-muted">
        You can read {what} but not change {what === 'this' ? 'it' : 'them'}. Ask an owner or marketing
        ops if something here needs to move.
      </p>
    </div>
  )
}
