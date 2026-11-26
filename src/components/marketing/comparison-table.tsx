import * as React from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Capability comparison. Every cell is a judgement about published capability,
 * not a benchmark result, and the caption says so — the honest version of this
 * table is more persuasive than an inflated one, because the last row is the
 * only one that actually matters.
 */

type Level = 'full' | 'partial' | 'none'

const VENDORS = ['HubSpot', 'Marketo', 'SF MC', 'Jasper', 'Copy.ai', 'Hootsuite'] as const

type Row = {
  capability: string
  note: string
  /** Same order as VENDORS. */
  values: [Level, Level, Level, Level, Level, Level]
  aurea: Level
}

const ROWS: Row[] = [
  {
    capability: 'AI content generation',
    note: 'Drafting copy for a channel from a prompt or brief',
    values: ['partial', 'partial', 'partial', 'full', 'full', 'partial'],
    aurea: 'full',
  },
  {
    capability: 'Brand and tone guardrails',
    note: 'Automatic scoring against a defined voice before review',
    values: ['none', 'none', 'none', 'full', 'partial', 'none'],
    aurea: 'full',
  },
  {
    capability: 'Campaign planning',
    note: 'Objectives, budget and a sequenced multi-channel plan',
    values: ['full', 'full', 'full', 'none', 'none', 'partial'],
    aurea: 'full',
  },
  {
    capability: 'AI audience targeting',
    note: 'Segments and lookalikes built from behaviour, not just lists',
    values: ['partial', 'full', 'full', 'none', 'none', 'none'],
    aurea: 'full',
  },
  {
    capability: 'Cross-channel scheduling',
    note: 'One calendar covering email, social, ads and web',
    values: ['full', 'full', 'full', 'none', 'none', 'full'],
    aurea: 'full',
  },
  {
    capability: 'Built-in approval workflow',
    note: 'Multi-step sign-off with roles, SLAs and an audit trail',
    values: ['partial', 'full', 'partial', 'none', 'none', 'full'],
    aurea: 'full',
  },
  {
    capability: 'Live performance and auto-optimise',
    note: 'Results read back and acted on while the campaign runs',
    values: ['partial', 'partial', 'full', 'none', 'none', 'partial'],
    aurea: 'full',
  },
  {
    capability: 'One governed end-to-end pipeline',
    note: 'Generate through monitor without leaving the workspace',
    values: ['none', 'none', 'none', 'none', 'none', 'none'],
    aurea: 'full',
  },
]

function Cell({ level, emphasis }: { level: Level; emphasis?: boolean }) {
  if (level === 'full') {
    return (
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-full',
          emphasis ? 'bg-brand-solid text-brand-on' : 'bg-ok-bg text-ok-fg',
        )}
        title="Built in"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
        <span className="sr-only">Built in</span>
      </span>
    )
  }
  if (level === 'partial') {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-warn-bg text-warn-fg"
        title="Partial — add-on, higher tier, or limited scope"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span className="sr-only">Partial</span>
      </span>
    )
  }
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-faint" title="Not offered">
      <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
      <span className="sr-only">Not offered</span>
    </span>
  )
}

export function ComparisonTable() {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface">
      {/* The scroll container is the table's own box, so a narrow viewport
          never pushes the page itself sideways. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left">
          <caption className="sr-only">
            Capability comparison between Aurea and six representative marketing tools.
          </caption>
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-surface px-5 py-4 text-2xs font-semibold uppercase tracking-wider text-ink-faint"
              >
                Capability
              </th>
              {VENDORS.map((v) => (
                <th
                  key={v}
                  scope="col"
                  className="px-3 py-4 text-center text-[12px] font-semibold text-ink-muted"
                >
                  {v}
                </th>
              ))}
              <th
                scope="col"
                className="rounded-t-lg border-x border-brand-200 bg-brand-50 px-3 py-4 text-center text-[12px] font-semibold text-brand-700"
              >
                Aurea
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, i) => {
              const last = i === ROWS.length - 1
              return (
                <tr
                  key={row.capability}
                  className={cn('border-b border-line last:border-b-0', last && 'bg-bg-subtle')}
                >
                  <th
                    scope="row"
                    className={cn(
                      'sticky left-0 z-10 px-5 py-3.5 font-normal',
                      last ? 'bg-bg-subtle' : 'bg-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'block text-[13.5px] text-ink',
                        last && 'font-semibold',
                      )}
                    >
                      {row.capability}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-ink-faint">{row.note}</span>
                  </th>
                  {row.values.map((v, j) => (
                    <td key={VENDORS[j]} className="px-3 py-3.5 text-center align-middle">
                      <Cell level={v} />
                    </td>
                  ))}
                  <td
                    className={cn(
                      'border-x border-brand-200 bg-brand-50 px-3 py-3.5 text-center align-middle',
                      last && 'rounded-b-lg border-b',
                    )}
                  >
                    <Cell level={row.aurea} emphasis />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-5 py-3.5">
        <span className="text-xs font-medium text-ink-faint md:hidden">Scroll the table sideways →</span>
        <LegendItem>
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-ok-bg text-ok-fg">
            <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
          </span>
          Built in
        </LegendItem>
        <LegendItem>
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-warn-bg text-warn-fg">
            <span className="h-1 w-1 rounded-full bg-current" />
          </span>
          Partial — add-on, higher tier or limited scope
        </LegendItem>
        <LegendItem>
          <span className="inline-flex h-4 w-4 items-center justify-center text-ink-faint">
            <Minus className="h-3 w-3" strokeWidth={2.5} />
          </span>
          Not offered
        </LegendItem>
      </div>
    </div>
  )
}

function LegendItem({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-2 text-xs text-ink-muted">{children}</span>
}
