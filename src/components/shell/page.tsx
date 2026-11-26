import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * Every product screen uses the same page frame, so the header height, gutter
 * and max width never drift between surfaces.
 */
export function PageBody({
  children,
  className,
  width = 'wide',
}: {
  children: React.ReactNode
  className?: string
  width?: 'wide' | 'full' | 'narrow'
}) {
  return (
    <main
      className={cn(
        'flex-1 px-5 py-6 lg:px-7',
        width === 'wide' && 'mx-auto w-full max-w-[1500px]',
        width === 'narrow' && 'mx-auto w-full max-w-3xl',
        className,
      )}
    >
      {children}
    </main>
  )
}

export function SectionHeading({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-3 flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * A short line explaining which PRD requirement a screen satisfies. Visible in
 * the product because the first audience for this build is the stakeholders who
 * wrote the requirements.
 */
export function RequirementNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
      <span className="font-semibold uppercase tracking-wide">Requirement</span> · {children}
    </p>
  )
}
