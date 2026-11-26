import { cn } from '@/lib/cn'

/**
 * The GenAI mark: five nodes on a loop, one of them a gate. It is a literal
 * drawing of the product's argument — generate, review, approve, publish,
 * monitor, feeding back to the start.
 */
export function Logomark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <circle cx="16" cy="16" r="11.5" stroke="rgb(var(--brand-600))" strokeWidth="2" opacity="0.28" />
      <path
        d="M16 4.5a11.5 11.5 0 0 1 11.5 11.5"
        stroke="rgb(var(--brand-600))"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="4.5" r="3" fill="rgb(var(--brand-600))" />
      <circle cx="27.5" cy="16" r="2.4" fill="rgb(var(--gold-400))" />
      <circle cx="16" cy="27.5" r="2.1" fill="rgb(var(--brand-400))" />
      <circle cx="4.5" cy="16" r="2.1" fill="rgb(var(--brand-400))" opacity="0.65" />
    </svg>
  )
}

export function Wordmark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizes = { sm: 'text-[15px]', md: 'text-[17px]', lg: 'text-2xl' }
  const marks = { sm: 20, md: 24, lg: 32 }
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Logomark size={marks[size]} />
      <span className={cn('font-semibold tracking-tight text-ink', sizes[size])}>GenAI</span>
    </span>
  )
}

export const TAGLINE = 'One governed loop from brief to result.'
