import * as React from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'

export type FaqItem = { q: string; a: React.ReactNode }

/**
 * Native <details> rather than a stateful accordion: it works before hydration,
 * it is findable with the browser's own in-page search, and it keeps the whole
 * page a server component.
 */
export function Faq({ items, className }: { items: FaqItem[]; className?: string }) {
  return (
    <div className={cn('divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface', className)}>
      {items.map((item) => (
        <details key={item.q} className="group">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-6 px-5 py-4 transition-colors hover:bg-surface-hover sm:px-6 sm:py-5 [&::-webkit-details-marker]:hidden">
            <h3 className="text-[15px] font-medium leading-snug text-ink sm:text-base">{item.q}</h3>
            <span className="mt-0.5 shrink-0 text-ink-faint transition-transform group-open:rotate-45">
              <Plus className="h-4 w-4" />
            </span>
          </summary>
          <div className="px-5 pb-5 pr-14 text-[14.5px] leading-relaxed text-ink-muted sm:px-6 sm:pb-6">
            {item.a}
          </div>
        </details>
      ))}
    </div>
  )
}
