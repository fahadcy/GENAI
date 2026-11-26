import { ArrowRight } from 'lucide-react'
import { LinkButton } from '@/components/ui/primitives'
import { Footnote } from './bits'

/**
 * The "what this replaces" stack. Figures are published list prices, labelled
 * as indicative, and deliberately not converted into a single blended total —
 * a fake like-for-like number would be the one dishonest thing on the page.
 */

type StackRow = {
  camp: string
  vendor: string
  price: string
  qualifier: string
  limit: string
  others: string
}

const STACK: StackRow[] = [
  {
    camp: 'Enterprise suite',
    vendor: 'HubSpot Marketing Hub Professional',
    price: '$890',
    qualifier: '/ month, 3 seats',
    limit: 'Owns campaigns, data and automation — but generative AI is an add-on bolted to the side.',
    others:
      'Enterprise sits nearer $3,600/mo. Marketo is quote-based at roughly $895–$3,195/mo, with enterprise contracts commonly $60k–$200k a year. Salesforce Marketing Cloud Growth starts near $1,500/mo and Advanced near $3,250/mo, billed annually.',
  },
  {
    camp: 'AI content tool',
    vendor: 'Jasper',
    price: '$59–69',
    qualifier: '/ seat / month',
    limit: 'Produces assets fast, then stops at the draft. It knows nothing about your channels, your audience or whether the work landed.',
    others: 'Copy.ai runs a free tier, $49/mo paid seats, and agent plans from $249/mo.',
  },
  {
    camp: 'Scheduling and social',
    vendor: 'Hootsuite',
    price: '$99–349',
    qualifier: '/ user / month',
    limit: 'Publishes and reports. It does not create the work or plan the campaign it belongs to.',
    others: 'Buffer covers the lighter end at $5–$12 per channel per month.',
  },
]

export function CostStack() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-8">
      <div>
        <div className="overflow-hidden rounded-panel border border-line bg-surface">
          <div className="border-b border-line bg-bg-subtle px-5 py-3.5">
            <h3 className="text-[13px] font-semibold text-ink">The three contracts most teams already hold</h3>
          </div>
          <ul className="divide-y divide-line">
            {STACK.map((row) => (
              <li key={row.vendor} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    <p className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                      {row.camp}
                    </p>
                    <p className="mt-0.5 text-[14px] font-medium text-ink">{row.vendor}</p>
                  </div>
                  <p className="tnum shrink-0 text-[15px] font-semibold text-ink">
                    {row.price}
                    <span className="ml-1 text-[12px] font-normal text-ink-muted">{row.qualifier}</span>
                  </p>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{row.limit}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">{row.others}</p>
              </li>
            ))}
          </ul>
          <div className="border-t border-line bg-bg-subtle px-5 py-4">
            <p className="text-[13px] leading-relaxed text-ink">
              Three renewal dates, three sets of onboarding, and none of them talks to the others.
              The gaps between them are filled by a person copying a brief into a second tool and
              pasting the result into a third.
            </p>
          </div>
        </div>

        <Footnote className="mt-3">
          Indicative published list prices as of August 2026, shown in the currency each vendor
          publishes. These are entry points that rise with seats, contact tiers and add-ons;
          enterprise agreements are negotiated individually. Aurea prices are in GBP and are not a
          converted equivalent — the comparison is about how many contracts and handoffs you are
          carrying, not a like-for-like total.
        </Footnote>
      </div>

      <div className="flex flex-col rounded-panel border border-brand-400 bg-surface p-6 shadow-pop ring-1 ring-brand-400 lg:self-start">
        <p className="text-2xs font-semibold uppercase tracking-wider text-brand-600">Instead</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">Aurea Growth</h3>
        <div className="mt-4 flex items-baseline gap-1.5">
          <span className="tnum text-[2.1rem] font-semibold leading-none tracking-tight text-ink">£790</span>
          <span className="text-[13px] text-ink-muted">per month</span>
        </div>
        <p className="mt-1.5 text-xs font-medium text-ink-faint">5 seats included · 14-day trial, no card</p>

        <ul className="mt-6 space-y-3 border-t border-line pt-5 text-[13px] leading-relaxed text-ink">
          <li>
            <span className="font-medium">One contract</span> covering generation, planning,
            targeting, approvals, scheduling and reporting.
          </li>
          <li>
            <span className="font-medium">No handoffs</span> — the brief, the draft, the sign-off and
            the result are the same record moving through stages.
          </li>
          <li>
            <span className="font-medium">Nothing to reconcile</span>, because the model that writes
            the asset is connected to the data that says whether it worked.
          </li>
        </ul>

        <p className="mt-5 rounded-lg bg-bg-subtle px-3.5 py-2.5 text-xs leading-relaxed text-ink-muted">
          Smaller team? Studio is £49 per seat per month and carries the same governance floor —
          scoring, approvals and the audit trail are in every plan.
        </p>

        <div className="mt-6">
          <LinkButton href="/pricing" variant="primary" size="md" className="w-full">
            See all plans
            <ArrowRight className="h-4 w-4" />
          </LinkButton>
        </div>
      </div>
    </div>
  )
}
