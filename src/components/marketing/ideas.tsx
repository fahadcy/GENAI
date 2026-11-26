import * as React from 'react'
import { Braces, Gauge, RotateCcw, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The four ideas that make Aurea different, each paired with something the
 * reader can actually inspect: the real score weighting, the real field
 * catalogue the natural-language builder is restricted to, the real set of
 * copilot actions. Claims with mechanisms attached are harder to dismiss.
 */

function IdeaCard({
  n,
  title,
  children,
  aside,
  icon: Icon,
}: {
  n: number
  title: string
  children: React.ReactNode
  aside: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <article className="grid gap-6 rounded-panel border border-line bg-surface p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
      <div>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon className="h-4 w-4" />
          </span>
          <span className="tnum text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Idea {n} of 4
          </span>
        </div>
        <h3 className="mt-4 text-balance text-xl font-semibold leading-snug tracking-tight text-ink sm:text-[1.4rem]">
          {title}
        </h3>
        <div className="mt-3 space-y-3 text-[14.5px] leading-relaxed text-ink-muted">{children}</div>
      </div>
      <div className="lg:pt-1">{aside}</div>
    </article>
  )
}

function AsideFrame({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-card border border-line bg-bg-subtle', className)}>
      <div className="border-b border-line px-4 py-2.5">
        <span className="label">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

export function Ideas() {
  return (
    <div className="space-y-5">
      <IdeaCard
        n={1}
        icon={RotateCcw}
        title="Generation and decisioning are the same loop, not two products"
        aside={
          <AsideFrame label="One record, six states">
            <ol className="space-y-2">
              {[
                { k: 'Brief', v: 'Objective, audience, channel, constraints' },
                { k: 'Variants', v: 'Per channel, per test cell' },
                { k: 'Score', v: 'Brand, compliance and readability' },
                { k: 'Approval', v: 'Who signed, when, on which version' },
                { k: 'Schedule', v: 'Channel, send window, status' },
                { k: 'Results', v: 'Opens, clicks, conversions, spend' },
              ].map((row, i, arr) => (
                <li key={row.k} className="flex items-start gap-3">
                  <span className="flex flex-col items-center pt-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                    {i < arr.length - 1 && <span className="mt-1 h-5 w-px bg-line" />}
                  </span>
                  <span className="min-w-0 -mt-0.5">
                    <span className="block text-[13px] font-medium text-ink">{row.k}</span>
                    <span className="block text-xs leading-snug text-ink-faint">{row.v}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
              Not six exports between six tools. One object that carries its own history.
            </p>
          </AsideFrame>
        }
      >
        <p>
          The model that writes the email is connected to the model that decides who receives it and
          when, and to the data that says whether it worked. Nothing has to be re-keyed at a boundary,
          because there is no boundary.
        </p>
        <p>
          That is what makes the last step useful: when the results come back, the system already
          knows which brief, which variant and which audience produced them.
        </p>
      </IdeaCard>

      <IdeaCard
        n={2}
        icon={Gauge}
        title="Governance is a first-class feature, not a compliance bolt-on"
        aside={
          <AsideFrame label="How a composite score is built">
            <ul className="space-y-3">
              {[
                { label: 'Brand voice', weight: '40%', note: 'Distance from your tone profile, plus do / don’t rules' },
                { label: 'Compliance', weight: '45%', note: 'Legal patterns, banned terms, disclaimers, channel limits' },
                { label: 'Readability', weight: '15%', note: 'Reading grade against your ceiling' },
              ].map((r) => (
                <li key={r.label}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-medium text-ink">{r.label}</span>
                    <span className="tnum text-[13px] font-semibold text-brand-600">{r.weight}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-snug text-ink-faint">{r.note}</p>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
              <p>
                An asset passes at your threshold — 80 by default — and any single high-severity
                finding blocks it regardless of the total.
              </p>
              <p>
                The same input always produces the same score, which is what makes a pass-rate target
                measurable rather than rhetorical.
              </p>
            </div>
          </AsideFrame>
        }
      >
        <p>
          Every asset is scored against a brand voice profile and your legal rules before a human ever
          sees it, so review time goes on judgement rather than on catching a banned word.
        </p>
        <p>
          Every approval is logged with who, what and when, in a tamper-evident hash-chained trail.
          Each entry commits to the one before it, so an exported trail can be verified rather than
          taken on trust.
        </p>
      </IdeaCard>

      <IdeaCard
        n={3}
        icon={Braces}
        title="Plain language on top, explicit rules underneath"
        aside={
          <AsideFrame label="Sentence in, editable rules out">
            <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] italic leading-relaxed text-ink">
              “UK SaaS customers on the growth plan who were active in the last 30 days but whose
              engagement has dropped below 40”
            </p>
            <p className="my-3 text-center text-xs text-ink-faint">↓ interpreted as</p>
            <ul className="space-y-1.5 font-mono text-[11.5px]">
              {[
                ['Country', 'is', 'GB'],
                ['Industry', 'is', 'SaaS'],
                ['Plan', 'is', 'growth'],
                ['Last activity', 'in the last', '30 days'],
                ['Engagement score', '<', '40'],
              ].map(([field, op, value]) => (
                <li
                  key={field}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-2.5 py-1.5"
                >
                  <span className="text-ink">{field}</span>
                  <span className="text-ink-faint">{op}</span>
                  <span className="font-semibold text-brand-600">{value}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
              Every row is editable, and the builder can only produce rules over a known field
              catalogue with known operators — so there is nothing opaque to audit later.
            </p>
          </AsideFrame>
        }
      >
        <p>
          Describe an audience in a sentence and get structured rules you can inspect, correct and
          re-run. The natural-language layer sits on top of explicit logic; it does not replace it.
        </p>
        <p>
          The result is a segment a marketer can build alone and an analyst can still defend — because
          what actually ran is a set of conditions, not a prompt.
        </p>
      </IdeaCard>

      <IdeaCard
        n={4}
        icon={Sparkles}
        title="A copilot that acts, with a human holding the switch"
        aside={
          <AsideFrame label="What it proposes">
            <ul className="space-y-2.5">
              {[
                { t: 'Pause a fatiguing asset', d: 'Engagement decaying against its own baseline' },
                { t: 'Shift budget between channels', d: 'With the cost-per-outcome that justifies it' },
                { t: 'Move a send to a better window', d: 'From when this audience actually opens' },
                { t: 'Draft the replacement asset', d: 'Re-generated from the original brief' },
                { t: 'Widen an underfilled segment', d: 'Loosen a threshold, see the new reach first' },
                { t: 'Nudge a stalled approver', d: 'Before the SLA on that step expires' },
              ].map((a) => (
                <li key={a.t} className="flex items-start gap-2.5">
                  <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                    <Undo2 className="h-2.5 w-2.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{a.t}</span>
                    <span className="block text-xs leading-snug text-ink-faint">{a.d}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-muted">
              Each one is a single click, carries the reasoning that produced it, and can be reversed.
              Nothing is applied without a person deciding.
            </p>
          </AsideFrame>
        }
      >
        <p>
          The copilot watches live performance rather than waiting to be asked. It flags creative
          fatigue, proposes budget shifts, finds the best send window and drafts the replacement
          asset.
        </p>
        <p>
          Every proposal arrives as an action, not a chart to interpret — and every action is
          reversible, which is the only reason it is safe to make them one click.
        </p>
      </IdeaCard>
    </div>
  )
}
