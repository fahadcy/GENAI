'use client'

import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * Shared chart plumbing for the Performance surface.
 *
 * Every colour on this screen comes from the design-system tokens in
 * globals.css. SVG we author by hand can reference them directly with
 * `rgb(var(--series-1))`, but Recharts writes its fills as inline attribute
 * strings, so those have to be *resolved* to concrete colours in JS — and
 * re-resolved when the theme flips, which is what `useChartTokens` is for.
 *
 * Palette policy: the token set has six categorical slots, but only the first
 * three clear an all-pairs colour-vision separation check in both themes, and
 * slot 6 sits under the chroma floor (it reads as grey). So no chart here
 * carries more than two coloured series, and every one of them also carries a
 * direct label or a legend — colour is never the only channel.
 */

const TOKEN_NAMES = [
  '--series-1',
  '--series-2',
  '--series-3',
  '--ink',
  '--ink-muted',
  '--ink-faint',
  '--line',
  '--surface',
  '--bg-inset',
  '--ok-fg',
  '--danger-fg',
] as const

export type ChartTokens = Record<(typeof TOKEN_NAMES)[number], string>

export function useChartTokens(): ChartTokens | null {
  const [tokens, setTokens] = React.useState<ChartTokens | null>(null)

  React.useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      const next = {} as ChartTokens
      for (const name of TOKEN_NAMES) next[name] = `rgb(${cs.getPropertyValue(name).trim()})`
      setTokens(next)
    }
    read()
    // The theme toggle sets data-theme on <html>; the OS setting moves the
    // media query. Either one has to re-resolve the colours Recharts baked in.
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', read)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', read)
    }
  }, [])

  return tokens
}

/** Reserves the plot's height during hydration so nothing jumps into place. */
export function ChartFrame({
  height,
  ready,
  children,
  className,
}: {
  height: number
  ready: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('w-full', className)} style={{ height }} aria-hidden={!ready}>
      {ready ? children : <div className="h-full w-full rounded-lg bg-bg-subtle" />}
    </div>
  )
}

/* ------------------------------------------------------------- chart chrome */

/** Recharts axis/grid styling, kept identical across every plot on the screen. */
export function axisProps(tokens: ChartTokens) {
  return {
    stroke: tokens['--line'],
    tick: { fill: tokens['--ink-faint'], fontSize: 11 },
    tickLine: false,
    axisLine: { stroke: tokens['--line'] },
  } as const
}

export function ChartTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean
  label: React.ReactNode
  rows: { key: string; color?: string; label: string; value: string }[]
}) {
  if (!active) return null
  return (
    <div className="pointer-events-none rounded-lg border border-line bg-surface px-3 py-2 shadow-pop">
      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-[13px]">
            {r.color && (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
            )}
            <span className="text-ink-muted">{r.label}</span>
            <span className="tnum ml-auto font-semibold text-ink">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------ chart/table */

/**
 * Every chart on this screen ships with a table twin. A tooltip is an
 * enhancement; it must never be the only way to read a value.
 */
export function ViewToggle({
  view,
  onChange,
  className,
}: {
  view: 'chart' | 'table'
  onChange: (v: 'chart' | 'table') => void
  className?: string
}) {
  return (
    <div className={cn('inline-flex rounded-lg bg-bg-inset p-0.5', className)} role="group">
      {(['chart', 'table'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={cn(
            'rounded-md px-2.5 py-1 text-2xs font-semibold capitalize transition-colors',
            view === v ? 'bg-surface text-ink shadow-card' : 'text-ink-faint hover:text-ink',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- helpers */

/**
 * Compact number formatting, done by hand rather than through `Intl`'s
 * `notation: 'compact'`.
 *
 * Node and Chromium ship different ICU data for the compact suffix — Node
 * renders "163K", Chromium "163k" — which is invisible on a server-rendered
 * page but throws a hydration mismatch the moment a *client* component prints
 * one during SSR. These rules are explicit, so both sides agree.
 */
export function compact(n: number): string {
  const abs = Math.abs(n)
  const scale = (v: number, suffix: string) => {
    const s = (Math.round(v * 10) / 10).toFixed(1)
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + suffix
  }
  if (abs >= 1_000_000_000) return scale(n / 1_000_000_000, 'bn')
  if (abs >= 1_000_000) return scale(n / 1_000_000, 'M')
  if (abs >= 1_000) return scale(n / 1_000, 'k')
  return Math.round(n).toLocaleString('en-GB')
}

/** Currency for an axis tick: whole units only, so ticks stay short and clean. */
export function axisMoney(value: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 2 : 0,
  }).format(value)
}

export function formatDay(iso: string, grain: 'day' | 'week'): string {
  const d = new Date(`${iso}T00:00:00`)
  if (grain === 'week') return `w/c ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Escapes one CSV field: quote it, and double any quote inside it. */
function csvField(value: string | number): string {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n')
}

/**
 * PF-5. The file is built from the data already rendered on the page, so the
 * export cannot drift from what the marketer just looked at.
 */
export function downloadCsv(filename: string, csv: string) {
  // The BOM makes Excel open UTF-8 currency symbols correctly on Windows.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
