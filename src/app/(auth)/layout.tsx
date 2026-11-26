import Link from 'next/link'
import { Check } from 'lucide-react'
import { Logomark, TAGLINE, Wordmark } from '@/components/brand'
import { ThemeToggle } from '@/components/ui/client'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,520px)]">
      {/* Left: the argument. Hidden on small screens where the form is the job. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-bg-subtle p-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 60% at 20% 0%, rgb(var(--brand-500) / 0.16), transparent 70%), radial-gradient(ellipse 60% 50% at 90% 90%, rgb(var(--gold-400) / 0.12), transparent 70%)',
          }}
        />
        <Link href="/" className="relative z-10">
          <Wordmark size="md" />
        </Link>

        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink">
            One governed loop from brief to result.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">
            Point tools generate copy or schedule posts. GenAI is the connective tissue: a task is
            generated, reviewed, approved, published and monitored without leaving the workspace —
            and every step is on the record.
          </p>
          <ul className="mt-8 space-y-3">
            {[
              'Brand and legal rules scored before a human sees the work',
              'Approvals with a tamper-evident audit trail',
              'Send times and budget shifts proposed with their reasoning',
              'One place for content, planning, targeting and results',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[14px] text-ink">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-solid text-brand-on">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs text-ink-faint">
          Built to the GenAI Marketing Automation product requirements, v1.0.
        </p>
      </aside>

      <main className="flex flex-col justify-center bg-bg px-5 py-10 sm:px-10">
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Link href="/">
            <Wordmark size="sm" />
          </Link>
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 hidden justify-end lg:flex">
            <ThemeToggle />
          </div>
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
