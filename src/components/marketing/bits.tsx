import * as React from 'react'
import { cn } from '@/lib/cn'

/**
 * Shared furniture for the public site. The product surfaces use a dense
 * application rhythm; the marketing pages use a wider gutter and a taller
 * vertical scale, but the same token set — so the two never look like
 * different companies.
 */

export function Container({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn('mx-auto w-full max-w-[1160px] px-5 sm:px-8', className)}>{children}</div>
}

export function Section({
  id,
  tone = 'plain',
  className,
  children,
}: {
  id?: string
  tone?: 'plain' | 'subtle'
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-20 border-t border-line py-20 sm:py-28',
        tone === 'subtle' && 'bg-bg-subtle',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('text-2xs font-semibold uppercase tracking-[0.14em] text-brand-600', className)}>
      {children}
    </p>
  )
}

export function SectionTitle({
  eyebrow,
  title,
  lede,
  align = 'left',
  className,
}: {
  eyebrow?: string
  title: React.ReactNode
  lede?: React.ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <div className={cn('max-w-3xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <Eyebrow className="mb-3">{eyebrow}</Eyebrow>}
      <h2 className="text-balance text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
        {title}
      </h2>
      {lede && (
        <p
          className={cn(
            'mt-4 max-w-2xl text-pretty text-[16px] leading-relaxed text-ink-muted sm:text-[17px]',
            align === 'center' && 'mx-auto',
          )}
        >
          {lede}
        </p>
      )}
    </div>
  )
}

/** A quiet, non-clickable statement of fact used under headlines and tables. */
export function Footnote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-xs leading-relaxed text-ink-faint', className)}>{children}</p>
}
