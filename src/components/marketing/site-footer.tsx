import Link from 'next/link'
import { Wordmark, TAGLINE } from '@/components/brand'
import { Container } from './bits'

/**
 * Deliberately small. Every link here goes somewhere that exists — a footer
 * full of dead placeholders is the fastest way to look unfinished.
 */
export function SiteFooter() {
  const columns: { heading: string; links: { href: string; label: string }[] }[] = [
    {
      heading: 'Product',
      links: [
        { href: '/#loop', label: 'The governed loop' },
        { href: '/#ideas', label: 'What makes it different' },
        { href: '/#comparison', label: 'Capability comparison' },
        { href: '/#replaces', label: 'What it replaces' },
      ],
    },
    {
      heading: 'Get started',
      links: [
        { href: '/pricing', label: 'Pricing' },
        { href: '/signup', label: 'Start a 14-day trial' },
        { href: '/login', label: 'Sign in' },
        { href: '/#faq', label: 'Questions' },
      ],
    },
  ]

  return (
    <footer className="border-t border-line bg-bg-subtle">
      <Container className="py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))]">
          <div className="max-w-sm">
            <Wordmark size="md" />
            <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">{TAGLINE}</p>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-faint">
              Generate, review, approve, publish and monitor in one pipeline, with every decision on
              the record.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.heading}>
              <h3 className="label">{col.heading}</h3>
              <ul className="mt-3.5 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-[14px] text-ink-muted transition-colors hover:text-ink"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-2xl text-xs leading-relaxed text-ink-faint">
            Competitor prices quoted anywhere on this site are indicative published list prices as of
            August 2026. They are entry points that rise with seats, contacts and add-ons, and
            enterprise agreements are negotiated individually. Product names and trademarks belong to
            their respective owners.
          </p>
          <p className="shrink-0 text-xs text-ink-faint">© 2026 GenAI</p>
        </div>
      </Container>
    </footer>
  )
}
