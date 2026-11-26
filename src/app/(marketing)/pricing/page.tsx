import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { LinkButton } from '@/components/ui/primitives'
import { Container, Eyebrow, Footnote, Section, SectionTitle } from '@/components/marketing/bits'
import { PricingTiers } from '@/components/marketing/pricing-tiers'
import { Faq, type FaqItem } from '@/components/marketing/faq'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Aurea pricing: Studio £49 per seat per month, Growth £790 per month for 5 seats, Scale £1,900 per month for 15 seats, and custom Enterprise agreements. 14-day trial, no card.',
}

export default function PricingPage() {
  return (
    <>
      <Header />
      <Tiers />
      <EveryPlan />
      <MarketContext />
      <Questions />
      <ClosingCta />
    </>
  )
}

/* ------------------------------------------------------------------ header */

function Header() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 60% 55% at 50% -10%, rgb(var(--brand-500) / 0.14), transparent 70%)',
        }}
        aria-hidden
      />
      <Container className="relative py-16 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow className="mb-4">Pricing</Eyebrow>
          <h1 className="text-balance text-[2.25rem] font-semibold leading-[1.08] tracking-tight text-ink sm:text-[3rem]">
            Priced as one product, because it is one product.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-[16px] leading-relaxed text-ink-muted sm:text-[17px]">
            One line on the invoice covers generation, planning, targeting, approvals, scheduling and
            reporting. No separate AI add-on, no per-channel publishing fee, no charge for the audit
            trail that makes the rest defensible.
          </p>
          <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink-muted shadow-card">
            <span className="h-1.5 w-1.5 rounded-full bg-ok-fg" />
            14-day trial on every plan · no card required
          </p>
        </div>
      </Container>
    </section>
  )
}

/* ------------------------------------------------------------------- tiers */

function Tiers() {
  return (
    <section className="pb-20 sm:pb-24">
      <Container>
        <PricingTiers />
        <Footnote className="mt-5 text-center">
          Prices in GBP, excluding VAT. Monthly plans include the seats shown; additional seats are
          available on every plan. Annual agreements are available from Growth upwards.
        </Footnote>
      </Container>
    </section>
  )
}

/* -------------------------------------------------------------- every plan */

const FLOOR = [
  {
    title: 'Brand and legal scoring on every asset',
    body: 'Guardrails are not a premium feature. Every plan scores every generated asset against your voice profile and rules before a human sees it.',
  },
  {
    title: 'A tamper-evident audit trail',
    body: 'Every approval and every applied action is written to a hash-chained log that can be verified and exported. Included at every tier, including the trial.',
  },
  {
    title: 'Role-scoped access',
    body: 'Six roles out of the box — owner, marketing ops, content creator, growth marketer, reviewer, analyst — each with a permission set and a landing screen that fits the job.',
  },
  {
    title: 'EU data residency by default',
    body: 'Workspaces default to EU residency. Enterprise agreements add residency selection alongside SSO and custom chains.',
  },
]

function EveryPlan() {
  return (
    <Section tone="subtle">
      <Container>
        <SectionTitle
          eyebrow="In every plan"
          title="The governance floor does not move with the price."
          lede="Charging extra for the parts that make AI output safe to publish would defeat the point of the product. These four are in the trial and in every tier above it."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {FLOOR.map((f) => (
            <div key={f.title} className="rounded-panel border border-line bg-surface p-6">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <h3 className="mt-4 text-[16px] font-semibold leading-snug tracking-tight text-ink">
                {f.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  )
}

/* ----------------------------------------------------------- market prices */

type MarketRow = { vendor: string; price: string; note: string }
type MarketGroup = { camp: string; blurb: string; rows: MarketRow[] }

const MARKET: MarketGroup[] = [
  {
    camp: 'Enterprise marketing suites',
    blurb: 'Own campaigns, data and automation — and treat generative AI as an add-on.',
    rows: [
      {
        vendor: 'HubSpot Marketing Hub Professional',
        price: '$890 / mo',
        note: '3 seats, before contact tiers and one-off onboarding',
      },
      { vendor: 'HubSpot Marketing Hub Enterprise', price: '~$3,600 / mo', note: 'Before contact tiers' },
      {
        vendor: 'Adobe Marketo Engage',
        price: 'Quote-based',
        note: 'Roughly $895–$3,195 / mo; enterprise contracts commonly $60k–$200k a year',
      },
      {
        vendor: 'Salesforce Marketing Cloud Growth',
        price: 'From ~$1,500 / mo',
        note: 'Billed annually',
      },
      {
        vendor: 'Salesforce Marketing Cloud Advanced',
        price: 'From ~$3,250 / mo',
        note: 'Billed annually',
      },
    ],
  },
  {
    camp: 'AI content tools',
    blurb: 'Produce assets fast, then stop at the draft. No knowledge of your channels or results.',
    rows: [
      { vendor: 'Jasper', price: '$59–69 / seat / mo', note: 'Per seat, before enterprise terms' },
      { vendor: 'Copy.ai', price: 'Free · $49 / mo', note: 'Agent plans from $249 / mo' },
    ],
  },
  {
    camp: 'Scheduling and social',
    blurb: 'Publish and report, but neither create the work nor plan the campaign.',
    rows: [
      { vendor: 'Hootsuite', price: '$99–349 / user / mo', note: 'Varies by plan and user count' },
      { vendor: 'Buffer', price: '$5–12 / channel / mo', note: 'Per connected channel' },
    ],
  },
]

function MarketContext() {
  return (
    <Section>
      <Container>
        <SectionTitle
          eyebrow="For context"
          title="What the three camps charge to cover part of the job."
          lede="Set against the stack a team usually assembles. We are showing published list prices rather than a blended total, because a converted like-for-like number would not be honest."
        />

        <div className="mt-12 overflow-hidden rounded-panel border border-line bg-surface">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <caption className="sr-only">
                Indicative published list prices for representative marketing tools, August 2026.
              </caption>
              <thead>
                <tr className="border-b border-line bg-bg-subtle">
                  <th scope="col" className="px-5 py-3 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                    Product
                  </th>
                  <th scope="col" className="px-5 py-3 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                    Indicative list price
                  </th>
                  <th scope="col" className="px-5 py-3 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                    Qualifier
                  </th>
                </tr>
              </thead>
              {MARKET.map((group) => (
                <tbody key={group.camp}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={3}
                      className="border-y border-line bg-bg-inset px-5 py-2.5 text-left"
                    >
                      <span className="text-[13px] font-semibold text-ink">{group.camp}</span>
                      <span className="ml-2 text-xs font-normal text-ink-muted">{group.blurb}</span>
                    </th>
                  </tr>
                  {group.rows.map((r) => (
                    <tr key={r.vendor} className="border-b border-line last:border-b-0">
                      <td className="px-5 py-3 text-[13.5px] text-ink">{r.vendor}</td>
                      <td className="tnum whitespace-nowrap px-5 py-3 text-[13.5px] font-semibold text-ink">
                        {r.price}
                      </td>
                      <td className="px-5 py-3 text-xs leading-snug text-ink-faint">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <div className="border-t border-line bg-brand-50 px-5 py-4">
            <p className="text-[13.5px] leading-relaxed text-brand-700">
              <span className="font-semibold">Aurea Growth is £790 a month with 5 seats</span> and
              covers all three jobs in one pipeline — which is the comparison worth making: how many
              contracts and handoffs you are carrying, not a converted total.
            </p>
          </div>
        </div>

        <Footnote className="mt-4 max-w-3xl">
          Indicative published list prices as of August 2026, in the currency each vendor publishes.
          They are entry points that rise with seats, contacts and add-ons; onboarding is often
          charged separately, and enterprise agreements are negotiated individually. Verify with the
          vendor before relying on any figure here. Aurea prices are in GBP and are not converted
          equivalents. Product names and trademarks belong to their respective owners.
        </Footnote>
      </Container>
    </Section>
  )
}

/* --------------------------------------------------------------------- faq */

const PRICING_FAQ: FaqItem[] = [
  {
    q: 'What counts as a seat?',
    a: (
      <>
        Any person who signs in to the workspace, whatever their role. A reviewer who only approves
        work and an analyst who only reads reports each use a seat, because both leave entries in the
        audit trail and both need a permission set.
      </>
    ),
  },
  {
    q: 'What happens at the end of the 14 days?',
    a: (
      <>
        You choose a plan or you stop. Nothing publishes without your say-so during the trial, and
        your work is not deleted the moment it ends — you can export the audit trail and your assets
        before you decide either way. No card is taken to start.
      </>
    ),
  },
  {
    q: 'Is the AI usage metered on top?',
    a: (
      <>
        No. Generation, scoring and copilot analysis are included in the plan price. Fair-use limits
        apply at very high volumes, and if you approach them we will tell you before anything changes
        rather than after.
      </>
    ),
  },
  {
    q: 'Can we start on Studio and move up?',
    a: (
      <>
        Yes, in either direction, and your data stays where it is. Growth adds the Campaign Planner,
        audience targeting and the copilot; Scale adds multiple workspaces, lookalike audiences and
        retention controls. Moving down keeps the historical record intact even where a feature is no
        longer active.
      </>
    ),
  },
  {
    q: 'What do the prices you quote for other vendors mean?',
    a: (
      <>
        They are indicative published list prices as of August 2026 and nothing more — entry points
        that rise with seats, contact tiers and add-ons, with onboarding often charged separately and
        enterprise deals negotiated individually. They are here to show the shape of the spend, not to
        quote a competitor.
      </>
    ),
  },
  {
    q: 'What is in an Enterprise agreement?',
    a: (
      <>
        Everything in Scale, plus single sign-on, data residency selection, custom approval chains and
        model routing, contractual SLAs and support through your security review. Terms are annual and
        priced to the shape of the deployment.{' '}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Start a trial
        </Link>{' '}
        and we will pick it up from there.
      </>
    ),
  },
]

function Questions() {
  return (
    <Section id="faq" tone="subtle">
      <Container>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16">
          <div>
            <Eyebrow className="mb-3">Billing questions</Eyebrow>
            <h2 className="text-balance text-[1.75rem] font-semibold leading-[1.14] tracking-tight text-ink sm:text-[2.1rem]">
              Before you pick a plan.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-muted">
              More about how the product works is on the{' '}
              <Link href="/#faq" className="font-medium text-brand-600 hover:underline">
                main FAQ
              </Link>
              .
            </p>
          </div>
          <Faq items={PRICING_FAQ} />
        </div>
      </Container>
    </Section>
  )
}

/* --------------------------------------------------------------- final cta */

function ClosingCta() {
  return (
    <Section>
      <Container>
        <div className="relative overflow-hidden rounded-panel border border-line bg-surface px-6 py-14 text-center shadow-card sm:px-12 sm:py-16">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(ellipse 70% 90% at 50% 0%, rgb(var(--brand-500) / 0.13), transparent 70%)',
            }}
            aria-hidden
          />
          <div className="relative mx-auto max-w-xl">
            <h2 className="text-balance text-[1.9rem] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.3rem]">
              Try the whole loop for fourteen days.
            </h2>
            <p className="mt-4 text-pretty text-[16px] leading-relaxed text-ink-muted">
              No card, no sales call to unlock the trial, and a workspace that is governed from the
              first asset you write.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LinkButton href="/signup" variant="primary" size="lg" className="w-full sm:w-auto">
                Start a 14-day trial
                <ArrowRight className="h-4 w-4" />
              </LinkButton>
              <LinkButton href="/" variant="secondary" size="lg" className="w-full sm:w-auto">
                See how the loop works
              </LinkButton>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  )
}
