import { Check } from 'lucide-react'
import { LinkButton } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

export type Tier = {
  name: string
  price: string
  unit: string
  summary: string
  seats: string
  features: string[]
  cta: { label: string; href: string }
  featured?: boolean
}

export const TIERS: Tier[] = [
  {
    name: 'Studio',
    price: '£49',
    unit: 'per seat / month',
    seats: 'from 1 seat',
    summary: 'The governed loop for a small team that does not need a suite around it.',
    features: [
      'Content Studio: briefs in, scored on-brand variants out',
      'One brand voice profile and one approval chain',
      'Email and organic social scheduling',
      'Performance dashboard tied to spend',
      'Full tamper-evident audit trail',
    ],
    cta: { label: 'Start free trial', href: '/signup' },
  },
  {
    name: 'Growth',
    price: '£790',
    unit: 'per month',
    seats: '5 seats included',
    summary: 'Where most marketing teams run the whole pipeline end to end.',
    features: [
      'Everything in Studio',
      'Campaign Planner and plain-language audience targeting',
      'Unlimited brand profiles and approval chains',
      'Copilot recommendations as one-click, reversible actions',
      'Paid channel connectors and cross-channel calendar',
      'Six built-in roles with permission-scoped access',
    ],
    cta: { label: 'Start free trial', href: '/signup' },
    featured: true,
  },
  {
    name: 'Scale',
    price: '£1,900',
    unit: 'per month',
    seats: '15 seats included',
    summary: 'Several brands, several markets, one governance model across all of them.',
    features: [
      'Everything in Growth',
      'Multiple workspaces with separate brand and legal rules',
      'Lookalike audiences and send-time optimisation',
      'Custom legal rule sets per channel and market',
      'Audit exports and retention controls',
      'Priority support with a named contact',
    ],
    cta: { label: 'Start free trial', href: '/signup' },
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    unit: 'annual plan',
    seats: 'seats to fit, starts as a trial',
    summary: 'For organisations with procurement, security review and residency requirements.',
    features: [
      'Everything in Scale',
      'SSO and directory-based provisioning',
      'Data residency selection',
      'Custom approval chains and model routing',
      'Contractual SLAs and security review support',
    ],
    cta: { label: 'Start free trial', href: '/signup' },
  },
]

export function PricingTiers({ tiers = TIERS }: { tiers?: Tier[] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-4">
      {tiers.map((t) => (
        <div
          key={t.name}
          className={cn(
            'flex flex-col rounded-panel border bg-surface p-6',
            t.featured ? 'border-brand-400 shadow-pop ring-1 ring-brand-400' : 'border-line shadow-card',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">{t.name}</h3>
            {t.featured && (
              <span className="rounded-md bg-brand-50 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-brand-700 ring-1 ring-inset ring-brand-200">
                Most teams
              </span>
            )}
          </div>

          {/* Price and its qualifiers stack rather than sit inline, so a word
              price like "Custom" cannot push the card's CTA out of alignment
              with its neighbours. */}
          <div className="mt-5">
            <div className="tnum text-[2.1rem] font-semibold leading-none tracking-tight text-ink">
              {t.price}
            </div>
            <p className="mt-2 min-h-[2.25rem] text-[13px] leading-[1.35] text-ink-muted">
              {t.unit}
              <span className="text-ink-faint"> · {t.seats}</span>
            </p>
          </div>

          <p className="mt-4 min-h-[3.25rem] text-[13.5px] leading-relaxed text-ink-muted">{t.summary}</p>

          <LinkButton
            href={t.cta.href}
            variant={t.featured ? 'primary' : 'secondary'}
            size="md"
            className="mt-5 w-full"
          >
            {t.cta.label}
          </LinkButton>

          <ul className="mt-6 space-y-2.5 border-t border-line pt-5">
            {t.features.map((f) => (
              <li key={f} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-ink">
                <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
