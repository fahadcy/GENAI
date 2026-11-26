import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'

/* ------------------------------------------------------------------ Button */

/**
 * Filled variants use `text-ink-invert` rather than a literal white: the
 * semantic tokens flip with the theme, and in dark mode the success and danger
 * fills are light colours where white text drops to ~2:1. `ink-invert` is
 * white on light and near-black on dark, which is correct against both.
 */
const BUTTON_VARIANTS = {
  primary:
    'bg-brand-solid text-brand-on hover:brightness-110 active:brightness-95 shadow-sm disabled:opacity-50',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-hover hover:border-line-strong disabled:opacity-50',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-50',
  danger: 'bg-danger-fg text-ink-invert hover:opacity-90 disabled:opacity-50',
  success: 'bg-ok-fg text-ink-invert hover:opacity-90 disabled:opacity-50',
  /* Gold is a light fill in BOTH themes, so it always needs dark ink. */
  gold: 'bg-gold-400 text-[rgb(28,22,4)] hover:brightness-95 disabled:opacity-50',
} as const

const BUTTON_SIZES = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
} as const

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS
  size?: keyof typeof BUTTON_SIZES
  loading?: boolean
}

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  loading,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-all',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

export function LinkButton({
  className,
  variant = 'secondary',
  size = 'md',
  href,
  children,
  ...props
}: React.ComponentProps<typeof Link> & {
  variant?: keyof typeof BUTTON_VARIANTS
  size?: keyof typeof BUTTON_SIZES
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-all',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
      />
    </svg>
  )
}

/* ------------------------------------------------------------------- Card */

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('card', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  icon,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  icon?: React.ReactNode
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line px-5 py-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 text-ink-faint">{icon}</div>}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] leading-snug text-ink-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ Badge */

const BADGE_TONES = {
  neutral: 'bg-bg-inset text-ink-muted ring-line',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  ok: 'bg-ok-bg text-ok-fg ring-ok-fg/20',
  warn: 'bg-warn-bg text-warn-fg ring-warn-fg/20',
  danger: 'bg-danger-bg text-danger-fg ring-danger-fg/20',
  info: 'bg-info-bg text-info-fg ring-info-fg/20',
  gold: 'bg-gold-100 text-gold-600 ring-gold-600/25',
} as const

export type BadgeTone = keyof typeof BADGE_TONES

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
}: {
  tone?: BadgeTone
  children: React.ReactNode
  className?: string
  dot?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-semibold ring-1 ring-inset',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/* ----------------------------------------------------------------- Fields */

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: React.ReactNode
  hint?: React.ReactNode
  error?: string | null
  required?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label className="flex items-center gap-1 text-[13px] font-medium text-ink">
          {label}
          {required && <span className="text-danger-fg">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger-fg">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-snug text-ink-faint">{hint}</p>
      ) : null}
    </div>
  )
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn('field', className)} {...props} />
  },
)

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn('field resize-y leading-relaxed', className)} {...props} />
})

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn('field cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  )
})

/* ----------------------------------------------------------------- Avatar */

export function Avatar({
  name,
  hue = 250,
  size = 28,
  className,
}: {
  name: string
  hue?: number
  size?: number
  className?: string
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
  return (
    <span
      className={cn('tint inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className)}
      style={
        {
          width: size,
          height: size,
          fontSize: Math.max(9, size * 0.38),
          '--h': hue,
        } as React.CSSProperties
      }
      title={name}
      aria-label={name}
    >
      {initials || '?'}
    </span>
  )
}

/* -------------------------------------------------------------- Score ring */

/**
 * Compact score dial used everywhere an asset appears. Colour follows the band,
 * not the raw number, so the same visual means the same thing on every screen.
 */
export function ScoreRing({
  score,
  size = 40,
  label,
  strokeWidth = 3.5,
}: {
  score: number
  size?: number
  label?: string
  strokeWidth?: number
}) {
  const r = (size - strokeWidth) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  const tone = score >= 85 ? 'var(--ok-fg)' : score >= 70 ? 'var(--warn-fg)' : 'var(--danger-fg)'
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgb(var(--line))"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`rgb(${tone})`}
          strokeWidth={strokeWidth}
          strokeDasharray={`${c * pct} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <span
        className="tnum absolute font-semibold"
        style={{ fontSize: size * 0.3, color: `rgb(${tone})` }}
        title={label}
      >
        {Math.round(score)}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------- Stat tile */

export function StatTile({
  label,
  value,
  delta,
  hint,
  href,
  tone = 'neutral',
  icon,
}: {
  label: string
  value: React.ReactNode
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; good?: boolean }
  hint?: string
  href?: string
  tone?: BadgeTone
  icon?: React.ReactNode
}) {
  const body = (
    <div className="flex h-full flex-col justify-between gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 lets a long label wrap instead of forcing the tile wider than
            its grid column, which on a phone scrolls the whole page. */}
        <span className="label min-w-0 break-words">{label}</span>
        {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
      </div>
      <div>
        <div className="tnum text-2xl font-semibold leading-none tracking-tight text-ink">{value}</div>
        <div className="mt-2 flex items-center gap-2">
          {delta && (
            <span
              className={cn(
                'tnum inline-flex items-center gap-0.5 text-xs font-semibold',
                delta.direction === 'flat'
                  ? 'text-ink-faint'
                  : delta.good === false
                    ? 'text-danger-fg'
                    : 'text-ok-fg',
              )}
            >
              {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'} {delta.value}
            </span>
          )}
          {hint && <span className="truncate text-xs text-ink-faint">{hint}</span>}
        </div>
      </div>
    </div>
  )
  void tone
  return href ? (
    <Link href={href} className="card block transition-colors hover:bg-surface-hover">
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  )
}

/* ------------------------------------------------------------ Empty state */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-bg-inset text-ink-faint">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ Misc */

export function Divider({ className, label }: { className?: string; label?: string }) {
  if (label) {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        <span className="h-px flex-1 bg-line" />
        <span className="label">{label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    )
  }
  return <div className={cn('h-px bg-line', className)} />
}

export function KeyValue({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[auto_1fr]">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          <dt className="text-ink-faint">{item.label}</dt>
          <dd className="text-ink">{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'brand',
  className,
}: {
  value: number
  max?: number
  tone?: 'brand' | 'ok' | 'warn' | 'danger'
  className?: string
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const colors = {
    brand: 'bg-brand-600',
    ok: 'bg-ok-fg',
    warn: 'bg-warn-fg',
    danger: 'bg-danger-fg',
  }
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-bg-inset', className)}>
      <div className={cn('h-full rounded-full transition-all', colors[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}
