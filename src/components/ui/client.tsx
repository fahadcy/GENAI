'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, Moon, Sun, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './primitives'

/* ------------------------------------------------------------------ Toast */

type Toast = { id: number; tone: 'ok' | 'danger' | 'info'; title: string; body?: string }

const ToastContext = React.createContext<{
  push: (t: Omit<Toast, 'id'>) => void
} | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const idRef = React.useRef(0)

  const push = React.useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++idRef.current
    setToasts((prev) => [...prev, { ...t, id }])
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6500)
  }, [])

  const dismiss = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id))

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/* Inset from both edges on narrow screens: `w-full` plus a right offset
          would otherwise be wider than the viewport and scroll the page. */}
      <div
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col gap-2 sm:left-auto sm:right-4 sm:w-full sm:max-w-sm"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'danger' ? AlertCircle : Info
          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border bg-surface p-3.5 shadow-pop',
                t.tone === 'ok' && 'border-ok-fg/25',
                t.tone === 'danger' && 'border-danger-fg/25',
                t.tone === 'info' && 'border-line',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  t.tone === 'ok' && 'text-ok-fg',
                  t.tone === 'danger' && 'text-danger-fg',
                  t.tone === 'info' && 'text-info-fg',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink">{t.title}</p>
                {t.body && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{t.body}</p>}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = React.useContext(ToastContext)
  if (!ctx) {
    // Allows components to be rendered in isolation (e.g. tests) without a provider.
    return { push: () => {} }
  }
  return ctx
}

/* ------------------------------------------------------------------ Modal */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open || !mounted) return null

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-[rgb(8_9_14/0.55)] backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative flex max-h-[92vh] w-full animate-fade-up flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-pop sm:rounded-2xl',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-snug text-ink-muted">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-bg-subtle px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------- Tabs */

export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: string; label: React.ReactNode; count?: number }[]
  value: string
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1 overflow-x-auto', className)} role="tablist">
      {tabs.map((t) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
              active ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={cn(
                  'tnum rounded px-1.5 py-0.5 text-2xs font-semibold',
                  active ? 'bg-surface text-ink-muted' : 'bg-bg-inset text-ink-faint',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------- Disclosure */

export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  return (
    <details className={cn('group', className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <svg
          className="h-3 w-3 transition-transform group-open:rotate-90"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2.5">{children}</div>
    </details>
  )
}

/* ------------------------------------------------------------ Theme toggle */

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light')

  React.useEffect(() => {
    const stored = readTheme()
    setTheme(stored)
    document.documentElement.dataset.theme = stored
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('genai-theme', next)
    } catch {
      /* private mode — the choice just won't persist */
    }
  }

  return (
    <button
      onClick={toggle}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink',
        className,
      )}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

function readTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem('genai-theme')
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Applied before paint so there is no light flash on a dark-theme load. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('genai-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})()`

/* --------------------------------------------------------- Confirm button */

export function ConfirmButton({
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'danger',
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  onConfirm: () => void | Promise<void>
  title: string
  description?: string
  confirmLabel?: string
  tone?: 'danger' | 'primary'
}) {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  return (
    <>
      <Button {...props} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={title}
        description={description}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={tone}
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  setOpen(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">This cannot be undone from here.</p>
      </Modal>
    </>
  )
}
