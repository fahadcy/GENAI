'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CHANNEL_META } from '@/components/domain'
import type { Channel } from '@/lib/db/schema'

/**
 * Filters live in the URL rather than component state, so a filtered view is
 * shareable, survives a refresh, and lets the page refetch on the server
 * instead of shipping the whole asset list to the browser to filter locally.
 */
export function StudioFilterBar({
  counts,
  status,
  channel,
  q,
  view,
}: {
  counts: Record<string, number>
  status: string
  channel: string
  q: string
  view: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [search, setSearch] = React.useState(q)

  const setParam = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value === null || value === '' || value === 'all') next.delete(key)
      else next.set(key, value)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // Debounced so typing does not fire a server round trip per keystroke.
  React.useEffect(() => {
    if (search === q) return
    const t = setTimeout(() => setParam('q', search), 350)
    return () => clearTimeout(t)
  }, [search, q, setParam])

  const tabs = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'needs_work', label: 'Needs work', count: counts.needs_work },
    { value: 'in_review', label: 'In review', count: counts.in_review },
    { value: 'approved', label: 'Approved', count: counts.approved },
    { value: 'scheduled', label: 'Scheduled', count: counts.scheduled },
    { value: 'published', label: 'Published', count: counts.published },
  ]

  const channels = Object.keys(CHANNEL_META) as Channel[]

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 rounded-lg bg-bg-inset p-0.5">
        {(['assets', 'briefs'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setParam('view', v === 'assets' ? null : v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[13px] font-medium capitalize transition-colors',
              view === v ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
            )}
          >
            {v}
          </button>
        ))}
      </div>

      {view === 'assets' && (
        <>
          <div className="flex items-center gap-0.5 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.value}
                onClick={() => setParam('status', t.value)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                  status === t.value
                    ? 'bg-bg-inset text-ink'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'tnum rounded px-1.5 text-2xs font-semibold',
                    status === t.value ? 'bg-surface text-ink-muted' : 'bg-bg-inset text-ink-faint',
                  )}
                >
                  {t.count ?? 0}
                </span>
              </button>
            ))}
          </div>

          <select
            value={channel}
            onChange={(e) => setParam('channel', e.target.value)}
            className="field h-8 w-auto cursor-pointer py-0 text-[13px]"
            aria-label="Filter by channel"
          >
            <option value="all">All channels</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_META[c].label}
              </option>
            ))}
          </select>

          <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles and copy"
              className="field h-8 py-0 pl-8 pr-7 text-[13px]"
              aria-label="Search assets"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
