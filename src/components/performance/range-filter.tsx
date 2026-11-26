import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'

/**
 * The one filter on this screen. It writes to the URL rather than to component
 * state, so the range is a server-side refetch: every panel below re-queries
 * the same window, the view is shareable, and the back button works.
 */
export function RangeFilter({
  options,
  value,
  basePath = '/performance',
}: {
  options: readonly number[]
  value: number
  basePath?: string
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Date range">
      {options.map((days) => {
        const active = days === value
        return (
          <Link
            key={days}
            href={`${basePath}?range=${days}`}
            scroll={false}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'tnum rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              active
                ? 'bg-bg-inset text-ink'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            {days} days
          </Link>
        )
      })}
    </div>
  )
}
