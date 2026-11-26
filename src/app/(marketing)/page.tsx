import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowLeftRight,
  ArrowRight,
  Blocks,
  Bot,
  Hourglass,
} from 'lucide-react'
import { getAuth } from '@/lib/auth/session'
import { ROLE_HOME } from '@/lib/auth/rbac'
import { LinkButton } from '@/components/ui/primitives'
import { Container, Eyebrow, Footnote, Section, SectionTitle } from '@/components/marketing/bits'
import { LoopDiagram } from '@/components/marketing/loop-diagram'
import { Ideas } from '@/components/marketing/ideas'
import { ComparisonTable } from '@/components/marketing/comparison-table'
import { CostStack } from '@/components/marketing/cost-stack'
import { Faq, type FaqItem } from '@/components/marketing/faq'

export const metadata: Metadata = {
  title: 'Aurea — one governed loop from brief to result',
  description:
    'Suites own your campaigns, AI writers own the draft, schedulers own the calendar. Aurea is the connective tissue: generate, review, approve, publish and monitor in one governed pipeline.',
}

export default async function LandingPage() {
  const auth = await getAuth()
  const home = auth ? (ROLE_HOME[auth.role] ?? '/command-center') : null

  return (
    <>
      <Hero home={home} />
      <Problem />
      <Loop />
      <IdeasSection />
      <Targets />
      <Comparison />
      <Replaces />
      <Questions />
      <ClosingCta home={home} />
    </>
  )
}

/* -------------------------------------------------------------------- hero */

function Hero({ home }: { home: string | null }) {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 70% 55% at 50% -8%, rgb(var(--brand-500) / 0.16), transparent 70%), radial-gradient(ellipse 40% 40% at 88% 12%, rgb(var(--gold-400) / 0.10), transparent 70%)',
        }}
        aria-hidden
      />
      <Container className="relative py-20 sm:py-28 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted shadow-card">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            GenAI marketing automation
          </span>

          <h1 className="mt-6 text-balance text-[2.5rem] font-semibold leading-[1.06] tracking-tight text-ink sm:text-[3.25rem] lg:text-[3.6rem]">
            One governed loop from brief to result.
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-[17px] leading-relaxed text-ink-muted sm:text-lg">
            Suites own your campaigns. AI writers own the draft. Schedulers own the calendar. Nobody
            owns the connective tissue between them — so your team carries the work across by hand.
            Aurea is one pipeline where a task is generated, reviewed, approved, published and
            monitored without leaving the workspace.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {home ? (
              <LinkButton href={home} variant="primary" size="lg" className="w-full sm:w-auto">
                Go to your workspace
                <ArrowRight className="h-4 w-4" />
              </LinkButton>
            ) : (
              <>
                <LinkButton href="/signup" variant="primary" size="lg" className="w-full sm:w-auto">
                  Start a 14-day trial
                  <ArrowRight className="h-4 w-4" />
                </LinkButton>
                <LinkButton href="/login" variant="secondary" size="lg" className="w-full sm:w-auto">
                  Sign in
                </LinkButton>
              </>
            )}
          </div>

          <p className="mt-4 text-[13px] text-ink-faint">
            No card required. A new workspace arrives with a brand voice profile and an approval chain
            already in place.
          </p>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-2xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
            {['Generate', 'Review', 'Approve', 'Publish', 'Monitor'].map((s, i) => (
              <span key={s} className="inline-flex items-center gap-2">
                {i > 0 && <span className="text-line-strong">/</span>}
                {s}
              </span>
            ))}
          </div>
        </div>
      </Container>
    </section>
  )
}

/* ----------------------------------------------------------------- problem */

const PROBLEMS = [
  {
    icon: Blocks,
    title: 'The work is spread across three camps',
    body: 'A suite for campaigns and data, a writing tool for drafts, a scheduler for publishing. Each is competent inside its own box and blind to the other two. You pay into all three and still own the gaps.',
  },
  {
    icon: ArrowLeftRight,
    title: 'The handoffs are done by a person',
    body: 'A brief is retyped into a second tool. The draft is pasted into a third. Approval happens in email, with a version number that nobody is certain about. Every seam is manual, and every seam is where the delay lives.',
  },
  {
    icon: Bot,
    title: 'The AI stops at the draft',
    body: 'Generative features are bolted onto products designed before them. The model writes text, then hands it to a workflow that knows nothing about how it was made — and receives nothing back about how it performed.',
  },
  {
    icon: Hourglass,
    title: 'The reporting arrives too late to act on',
    body: 'Results turn up in a dashboard after the campaign has run, disconnected from the decisions that caused them. By the time creative fatigue is visible in a chart, the budget behind it is already spent.',
  },
]

function Problem() {
  return (
    <Section tone="subtle">
      <Container>
        <SectionTitle
          eyebrow="The problem"
          title="Marketing teams are not short of tools. They are short of a spine."
          lede="Fragmentation is not an inconvenience — it is where campaigns lose their weeks. Four failures repeat in almost every stack assembled from those three camps."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {PROBLEMS.map((p) => (
            <div key={p.title} className="rounded-panel border border-line bg-surface p-6">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg-inset text-ink-muted">
                <p.icon className="h-4 w-4" />
              </span>
              <h3 className="mt-4 text-[16px] font-semibold leading-snug tracking-tight text-ink">
                {p.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">{p.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  )
}

/* -------------------------------------------------------------------- loop */

function Loop() {
  return (
    <Section id="loop">
      <Container>
        <SectionTitle
          eyebrow="The wedge"
          title="One pipeline, five stages, one gate — and a feedback arc that actually closes."
          lede="This is the whole argument. Not a new writing tool and not another suite: the connective tissue that turns five separate jobs into one governed sequence, with the AI acting as an operator rather than a novelty text box."
        />

        <div className="mt-14">
          <LoopDiagram />
        </div>

        <div className="mt-12 grid gap-6 border-t border-line pt-10 sm:grid-cols-3">
          <div>
            <h3 className="text-[14px] font-semibold text-ink">Nothing leaves the workspace</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-muted">
              A brief becomes variants, a score, an approval, a scheduled send and a result set —
              without an export, an attachment or a second login.
            </p>
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-ink">The gate is real</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-muted">
              Approval is a step with roles, an SLA and a record, not a convention people are expected
              to remember. Editing an approved asset sends it back for review.
            </p>
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-ink">The loop closes</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-muted">
              Monitoring is wired back into generation. Results are not a report at the end; they are
              the input to the next brief.
            </p>
          </div>
        </div>
      </Container>
    </Section>
  )
}

/* ------------------------------------------------------------------- ideas */

function IdeasSection() {
  return (
    <Section id="ideas" tone="subtle">
      <Container>
        <SectionTitle
          eyebrow="What is actually new"
          title="Four ideas, each with a mechanism you can inspect."
          lede="Every claim below is attached to something concrete — a weighting, a field catalogue, a set of actions. Anything we cannot show, we do not claim."
        />
        <div className="mt-12">
          <Ideas />
        </div>
      </Container>
    </Section>
  )
}

/* ----------------------------------------------------------------- targets */

const TARGETS = [
  {
    value: '2–5 days',
    label: 'Campaign turnaround',
    note: 'From the 2–4 weeks a manual, multi-tool cycle typically takes.',
  },
  { value: '30%+', label: 'Faster approvals', note: 'Reduction in average time from submission to decision.' },
  { value: '20%+', label: 'Lower cost per signup', note: 'Cost per acquired signup, against the pre-Aurea baseline.' },
  { value: '≥95%', label: 'Pass brand check unedited', note: 'Assets clearing the guardrails with no human edit.' },
]

function Targets() {
  return (
    <Section>
      <Container>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <Eyebrow className="mb-3">The bar we have set</Eyebrow>
            <h2 className="text-balance text-[1.75rem] font-semibold leading-[1.14] tracking-tight text-ink sm:text-[2.1rem]">
              These are targets, not results.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-muted">
              Aurea is designed to hit the four numbers on the right. We are not reporting them as
              achieved outcomes and we are not attributing them to anyone else&rsquo;s campaigns.
            </p>
            <p className="mt-3 text-[16px] leading-relaxed text-ink-muted">
              What we can promise is that the product measures every one of them inside your own
              workspace — turnaround, approval time, cost per outcome and guardrail pass rate — so
              after a quarter you will know whether we met the bar rather than having to take our word
              for it.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {TARGETS.map((t) => (
              <div key={t.label} className="rounded-card border border-line bg-surface p-5 shadow-card">
                <div className="tnum text-[1.9rem] font-semibold leading-none tracking-tight text-brand-600">
                  {t.value}
                </div>
                <div className="mt-2.5 text-[13.5px] font-semibold text-ink">{t.label}</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">{t.note}</p>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  )
}

/* -------------------------------------------------------------- comparison */

function Comparison() {
  return (
    <Section id="comparison" tone="subtle">
      <Container>
        <SectionTitle
          eyebrow="Capability comparison"
          title="Every column is good at something. Only one row is the point."
          lede="Suites cover planning, data and automation. Writing tools cover the draft. Schedulers cover publishing. Read down the last row: the end-to-end governed pipeline is the capability nobody else is selling."
        />
        <div className="mt-12">
          <ComparisonTable />
        </div>
        <Footnote className="mt-4 max-w-3xl">
          Assessments reflect our reading of each vendor&rsquo;s published capabilities as of August
          2026 and are not benchmark results. Products change, and higher tiers or add-ons may cover
          more than the base offering shown here. Product names and trademarks belong to their
          respective owners.
        </Footnote>
      </Container>
    </Section>
  )
}

/* ---------------------------------------------------------------- replaces */

function Replaces() {
  return (
    <Section id="replaces">
      <Container>
        <SectionTitle
          eyebrow="What it replaces"
          title="You are already paying for three products to do one job badly."
          lede="The stack below is the common shape: a suite, a writing tool and a scheduler, each billed separately and none of them aware of the others."
        />
        <div className="mt-12">
          <CostStack />
        </div>
      </Container>
    </Section>
  )
}

/* --------------------------------------------------------------------- faq */

const FAQ_ITEMS: FaqItem[] = [
  {
    q: 'Is Aurea trying to replace my CRM?',
    a: (
      <>
        No. Your CRM stays where it is. Aurea sits above the channels: connectors push approved work
        out to email, social, ads and web, and pull results back in so the loop can close. What it
        does replace is the improvised layer between your suite, your writing tool and your scheduler
        — the spreadsheets, the approval emails and the manual re-keying.
      </>
    ),
  },
  {
    q: 'How is this different from adding an AI writing tool to the suite we already have?',
    a: (
      <>
        A writing tool bolted to a suite still leaves you with two products and a person in between.
        The draft does not know what campaign it belongs to, the approval does not know what changed
        since the last version, and the results never reach the model that produced the copy. Aurea
        is one pipeline, so the brief, the score, the sign-off, the send and the outcome are states of
        the same record rather than files moving between systems.
      </>
    ),
  },
  {
    q: 'What does “governed” actually mean here?',
    a: (
      <>
        Three specific things. Every asset is scored against your brand voice profile and legal rules
        before a human sees it. Approvals run through configurable chains with roles and SLAs, and an
        edit to an approved asset forces re-review. And every decision is written to a hash-chained
        audit trail where each entry commits to the one before it, so an exported trail can be
        verified rather than trusted.
      </>
    ),
  },
  {
    q: 'Does the AI publish things on its own?',
    a: (
      <>
        No. The copilot proposes — pause this asset, shift this budget, move this send, draft this
        replacement — and a person decides. Each proposal is a single click, carries the reasoning
        that produced it, and is reversible. Autonomy without a human in the loop is not something we
        are offering.
      </>
    ),
  },
  {
    q: 'Where do the target numbers come from?',
    a: (
      <>
        They are the bar we designed the product to clear, not outcomes we are reporting. Campaign
        turnaround of 2–5 days, approvals 30%+ faster, cost per acquired signup down 20%+, and 95% or
        more of assets passing the brand check unedited. Aurea instruments all four inside your own
        workspace, so you can check us against them with your own data.
      </>
    ),
  },
  {
    q: 'Are the competitor prices you quote current?',
    a: (
      <>
        They are indicative published list prices as of August 2026, shown so you can see the shape of
        the spend rather than as a quote. Every one of them is an entry point that rises with seats,
        contact tiers and add-ons, onboarding fees are often separate, and enterprise agreements are
        negotiated individually. Check with the vendor before relying on any figure here.
      </>
    ),
  },
  {
    q: 'Where does our data live?',
    a: (
      <>
        Each workspace has a data residency setting, defaulting to the EU. Enterprise agreements add
        single sign-on, residency selection, custom approval chains and model routing, and support for
        your security review.
      </>
    ),
  },
  {
    q: 'What happens when the trial ends?',
    a: (
      <>
        The trial runs 14 days and needs no card. Nothing publishes without your say-so during it, and
        nothing is deleted the moment it ends — you pick a plan, or you export your audit trail and
        walk away. Pricing starts at £49 per seat per month on Studio;{' '}
        <Link href="/pricing" className="font-medium text-brand-600 hover:underline">
          all four plans are here
        </Link>
        .
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
            <Eyebrow className="mb-3">Questions</Eyebrow>
            <h2 className="text-balance text-[1.75rem] font-semibold leading-[1.14] tracking-tight text-ink sm:text-[2.1rem]">
              The things people ask first.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-muted">
              Including the awkward ones. If something here is not answered, it is answered in the
              product — start a trial and look.
            </p>
          </div>
          <Faq items={FAQ_ITEMS} />
        </div>
      </Container>
    </Section>
  )
}

/* --------------------------------------------------------------- final cta */

function ClosingCta({ home }: { home: string | null }) {
  return (
    <Section className="border-t border-line">
      <Container>
        <div className="relative overflow-hidden rounded-panel border border-line bg-surface px-6 py-14 text-center shadow-card sm:px-12 sm:py-20">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(ellipse 70% 90% at 50% 0%, rgb(var(--brand-500) / 0.14), transparent 70%), radial-gradient(ellipse 50% 60% at 92% 100%, rgb(var(--gold-400) / 0.10), transparent 70%)',
            }}
            aria-hidden
          />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-3xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-[2.6rem]">
              Put the whole loop in one place.
            </h2>
            <p className="mt-5 text-pretty text-[16px] leading-relaxed text-ink-muted sm:text-[17px]">
              Fourteen days, no card, and a workspace that is governed from the first asset. Write one
              brief and watch it move through all five stages before you decide anything.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {home ? (
                <LinkButton href={home} variant="primary" size="lg" className="w-full sm:w-auto">
                  Go to your workspace
                  <ArrowRight className="h-4 w-4" />
                </LinkButton>
              ) : (
                <>
                  <LinkButton href="/signup" variant="primary" size="lg" className="w-full sm:w-auto">
                    Start a 14-day trial
                    <ArrowRight className="h-4 w-4" />
                  </LinkButton>
                  <LinkButton href="/pricing" variant="secondary" size="lg" className="w-full sm:w-auto">
                    See pricing
                  </LinkButton>
                </>
              )}
            </div>
          </div>
        </div>
      </Container>
    </Section>
  )
}
