'use client'

import Link from 'next/link'
import { Radar } from 'lucide-react'
import { Badge, Card } from '@/components/ui/primitives'

/**
 * The "use competitor intelligence" switch shown in the Studio and Google Ads
 * composers. Off is always possible; on is the default when a landscape
 * exists. The highlights say, in one glance, what the generator will be told.
 */

export type CompetitorContextSummary = {
  competitors: number
  generatedAt: string
  simulated: boolean
  highlights: string[]
}

export function CompetitorContextToggle({
  summary,
  checked,
  onChange,
  surface,
}: {
  summary: CompetitorContextSummary | null
  checked: boolean
  onChange: (v: boolean) => void
  surface: 'content' | 'ads'
}) {
  if (!summary) {
    return (
      <Card className="flex items-start gap-3 p-4">
        <Radar className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
        <p className="text-[13px] leading-relaxed text-ink-muted">
          No competitor analysis yet. Once{' '}
          <Link href="/competitors" className="font-medium text-brand-700 hover:underline">
            Competitors
          </Link>{' '}
          has scanned your market, {surface === 'ads' ? 'campaigns' : 'copy'} can be written to stand apart from it.
        </p>
      </Card>
    )
  }
  return (
    <Card className="p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--brand-600,91_75_224))]"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
            <Radar className="h-3.5 w-3.5 text-ink-faint" />
            Use competitor intelligence
            <span className="text-xs font-normal text-ink-faint">
              {summary.competitors} competitors · analysed {summary.generatedAt.slice(0, 10)}
            </span>
            {summary.simulated && (
              <Badge tone="warn" dot>
                Partly simulated
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-[13px] leading-relaxed text-ink-muted">
            {surface === 'ads'
              ? 'Headlines avoid the promises every competitor already makes, lean into the angles nobody owns, and competitor brand names are added as negative keywords. Competitors are never named in the ads.'
              : 'The writer is told what competitors already say, what their customers complain about and what you can credibly own. Competitors are never named, and the guardrail flags any copy that does.'}
          </span>
          {checked && summary.highlights.length > 0 && (
            <ul className="mt-2 space-y-1">
              {summary.highlights.map((h) => (
                <li key={h} className="flex gap-2 text-xs leading-snug text-ink-muted">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                  {h}
                </li>
              ))}
            </ul>
          )}
        </span>
      </label>
    </Card>
  )
}
