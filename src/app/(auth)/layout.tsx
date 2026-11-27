import Link from 'next/link'
import { Check } from 'lucide-react'
import { Logomark, TAGLINE, Wordmark } from '@/components/brand'
import { ThemeToggle } from '@/components/ui/client'

/**
 * Two equal halves, so the form sits near the middle of the screen rather
 * than pinned to the right edge.
 *
 * The left side is deliberately thin on words. Everybody signing in already
 * knows what this is, so three lines earn their place and a fourth does not.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left: the argument, briefly. Hidden on small screens, where the form is the job. */}
      <aside className="relative hidden flex-col justify-center overflow-hidden bg-bg-subtle px-12 py-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 60% at 20% 0%, rgb(var(--brand-500) / 0.16), transparent 70%), radial-gradient(ellipse 60% 50% at 90% 90%, rgb(var(--gold-400) / 0.12), transparent 70%)',
          }}
        />
        <Link href="/product" className="absolute left-12 top-12 z-10">
          <Wordmark size="md" />
        </Link>

        <div className="relative z-10 ml-auto max-w-sm">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">
            One governed loop from brief to result.
          </h1>
          <ul className="mt-7 space-y-3">
            {[
              'Brand and legal rules scored before anyone reads the work',
              'Approvals on a tamper-evident record',
              'Content, planning, targeting and results in one place',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[14px] leading-snug text-ink">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-solid text-brand-on">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="relative flex flex-col justify-center bg-bg px-5 py-10 sm:px-10">
        <div className="absolute right-6 top-6 hidden lg:block">
          <ThemeToggle />
        </div>
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Link href="/product">
            <Wordmark size="sm" />
          </Link>
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-sm lg:mr-auto lg:ml-16">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logomark size={36} />
          </div>
          {children}
        </div>
        <p className="mx-auto mt-10 max-w-sm text-center text-xs text-ink-faint lg:hidden">{TAGLINE}</p>
      </main>
    </div>
  )
}
