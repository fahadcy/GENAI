'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Info, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AdObjective } from '@/lib/db/schema'
import {
  budgetExplanation,
  objectiveDef,
  GEO_PRESETS,
  LANGUAGE_PRESETS,
  MONTHLY_BUDGET_MULTIPLIER,
  OBJECTIVES,
} from '@/lib/ads/objectives'
import { generateCampaignAction } from '@/app/actions/ads'
import { Button, Card, Field, Input, Select, Spinner, Textarea } from '@/components/ui/primitives'
import { Disclosure, useToast } from '@/components/ui/client'
import { formatMoney } from '@/components/domain'
import {
  CompetitorContextToggle,
  type CompetitorContextSummary,
} from '@/components/competitors/context-toggle'

/**
 * The front door to paid search for someone who has said, in as many words,
 * "I am not from marketing".
 *
 * Deliberately one long form rather than a wizard: the whole decision is five
 * questions, and hiding four of them behind Next buttons makes a small thing
 * feel like a process and hides what a step costs. Every Google concept that
 * survives onto this screen — daily budget, location targeting, conversions —
 * carries its explanation next to it rather than in a help article.
 */

export type BuilderAccount = {
  id: string
  name: string
  currencyCode: string
}

export type BuilderCampaign = {
  id: string
  name: string
}

/** Countries first: it is the choice most people actually want. */
const GEO_GROUPS: { key: string; heading: string }[] = [
  { key: 'Country', heading: 'Countries' },
  { key: 'Region', heading: 'Regions' },
  { key: 'City', heading: 'Cities' },
]

export function CampaignBuilder({
  accounts,
  campaigns,
  workspaceCurrency,
  initial,
  competitorContext = null,
}: {
  accounts: BuilderAccount[]
  campaigns: BuilderCampaign[]
  workspaceCurrency: string
  /** Prefill from another surface, e.g. a Competitors play. Everything stays editable. */
  initial?: { brief?: string; finalUrl?: string; name?: string }
  competitorContext?: CompetitorContextSummary | null
}) {
  const router = useRouter()
  const toast = useToast()

  const [objectiveKey, setObjectiveKey] = React.useState<AdObjective>('leads')
  const objective = objectiveDef(objectiveKey)

  const [brief, setBrief] = React.useState(initial?.brief ?? '')
  const [finalUrl, setFinalUrl] = React.useState(initial?.finalUrl ?? '')
  const [budget, setBudget] = React.useState(String(objectiveDef('leads').suggestedMinDailyBudget))
  const [budgetTouched, setBudgetTouched] = React.useState(false)
  const [geo, setGeo] = React.useState<string[]>([])

  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? '')
  const [campaignId, setCampaignId] = React.useState('')
  const [language, setLanguage] = React.useState('1000')
  const [endDate, setEndDate] = React.useState('')
  const [conversionAction, setConversionAction] = React.useState('')
  const [name, setName] = React.useState(initial?.name ?? '')
  const [useCompetitors, setUseCompetitors] = React.useState(Boolean(competitorContext))

  const [errors, setErrors] = React.useState<Record<string, string | null>>({})
  const [pending, setPending] = React.useState(false)

  const placeholder = useCyclingExample(objective.examples)
  const currency = accounts.find((a) => a.id === accountId)?.currencyCode ?? workspaceCurrency
  const daily = Number(budget)
  const dailyValid = Number.isFinite(daily) && daily > 0
  const explanation = budgetExplanation(dailyValid ? daily : 0, currency)
  const belowFloor = dailyValid && daily < objective.suggestedMinDailyBudget

  // An untouched budget follows the objective, because the floor that matters
  // is different for each one and a stale number is worse than no number.
  const chooseObjective = (key: AdObjective) => {
    setObjectiveKey(key)
    if (!budgetTouched) setBudget(String(objectiveDef(key).suggestedMinDailyBudget))
  }

  const clearError = (key: string) => setErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev))

  const validate = (): boolean => {
    const next: Record<string, string | null> = {}
    if (!brief.trim()) next.brief = 'Tell me in a sentence what you are selling and to whom.'
    if (!finalUrl.trim()) {
      next.finalUrl = 'Add the web page people should land on when they click.'
    } else if (!looksLikeUrl(finalUrl)) {
      next.finalUrl = `"${finalUrl.trim()}" is not a valid web address. Use the full address, starting with https://`
    }
    if (!dailyValid) next.budget = 'Set a daily budget above zero.'
    if (geo.length === 0) next.geo = 'Choose at least one place to advertise in.'
    setErrors(next)
    return Object.values(next).every((v) => !v)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setPending(true)
    try {
      const res = await generateCampaignAction({
        name: name.trim() || undefined,
        brief: brief.trim(),
        objective: objectiveKey,
        finalUrl: finalUrl.trim(),
        dailyBudget: daily,
        geoCriterionIds: geo,
        languages: [language],
        accountId: accountId || null,
        campaignId: campaignId || null,
        conversionAction: conversionAction.trim() || null,
        endDate: endDate || null,
        useCompetitorContext: Boolean(competitorContext) && useCompetitors,
      })
      if (res.ok && res.data) {
        toast.push({ tone: 'ok', title: 'Campaign built', body: res.message })
        // Stays disabled through the navigation: re-enabling here would leave a
        // live button on screen for the second it takes to move, and a second
        // press builds a second campaign.
        router.push(`/ads/${res.data.id}`)
        return
      }
      toast.push({ tone: 'danger', title: 'Nothing was built', body: res.message })
      setPending(false)
    } catch {
      toast.push({
        tone: 'danger',
        title: 'The builder did not respond',
        body: 'Nothing was saved and nothing was sent to Google. Your answers are still here — try again.',
      })
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* 1 ---------------------------------------------------------------- */}
      <Section step={1} title="What do you want this to do?">
        <div className="grid gap-3 sm:grid-cols-2">
          {OBJECTIVES.map((o) => {
            const selected = o.key === objectiveKey
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => chooseObjective(o.key)}
                aria-pressed={selected}
                className={cn(
                  'min-w-0 rounded-lg border p-4 text-left transition-colors',
                  selected
                    ? 'border-brand-500 bg-brand-50'
                    : 'border-line bg-surface hover:border-line-strong hover:bg-surface-hover',
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span
                    className={cn(
                      'text-[14px] font-semibold leading-snug',
                      selected ? 'text-brand-700' : 'text-ink',
                    )}
                  >
                    {o.label}
                  </span>
                  {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
                </span>
                <span className="mt-1.5 block text-[13px] leading-relaxed text-ink-muted">
                  {o.summary}
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 flex gap-3 rounded-lg border border-line bg-bg-subtle p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <div className="min-w-0 space-y-1.5">
            <p className="text-[13px] leading-relaxed text-ink">{objective.biddingReason}</p>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              {objective.conversionPrompt} You can answer that further down, or leave it and set it
              up in Google later.
            </p>
          </div>
        </div>
      </Section>

      {/* 2 ---------------------------------------------------------------- */}
      <Section
        step={2}
        title="Tell me about it"
        hint="One or two sentences saying what you sell and who should buy it. This is the only thing you have to write."
      >
        <Field error={errors.brief}>
          <Textarea
            rows={3}
            value={brief}
            onChange={(e) => {
              setBrief(e.target.value)
              clearError('brief')
            }}
            placeholder={placeholder}
            className="text-[13.5px]"
          />
        </Field>
      </Section>

      {/* 3 ---------------------------------------------------------------- */}
      <Section step={3} title="Where should people land?">
        <Field
          hint="The page someone arrives at after clicking the ad. Use the page about the thing you are advertising, not your home page — people who have to go hunting for it usually leave."
          error={errors.finalUrl}
        >
          <Input
            value={finalUrl}
            onChange={(e) => {
              setFinalUrl(e.target.value)
              clearError('finalUrl')
            }}
            placeholder="https://example.com/annual-plan"
            inputMode="url"
            autoComplete="off"
          />
        </Field>
      </Section>

      {/* 4 ---------------------------------------------------------------- */}
      <Section step={4} title="How much a day?">
        <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Field label={`Daily budget (${currency})`} error={errors.budget} className="min-w-0">
            <Input
              value={budget}
              onChange={(e) => {
                setBudget(e.target.value)
                setBudgetTouched(true)
                clearError('budget')
              }}
              inputMode="decimal"
              type="number"
              min={0}
              step={1}
              className="tnum"
            />
          </Field>

          <div className="min-w-0 space-y-2.5 self-end pb-1">
            {dailyValid ? (
              <p className="text-[13px] leading-relaxed text-ink-muted">{explanation.sentence}</p>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-faint">
                Put in a daily figure and you will see both of Google&rsquo;s spending limits here.
              </p>
            )}
            {belowFloor && (
              <p className="flex gap-2 text-[13px] leading-relaxed text-warn-fg">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {formatMoney(daily, currency)} a day is below the{' '}
                  {formatMoney(objective.suggestedMinDailyBudget, currency)} this kind of campaign
                  usually needs. Google&rsquo;s automatic bidding needs roughly 30 results in 30 days
                  before it works properly; under that it is guessing with your money. You can carry
                  on — it is your money and your call — but expect slower learning, or narrow the
                  locations below so the same amount buys more of the right clicks.
                </span>
              </p>
            )}
          </div>
        </div>
      </Section>

      {/* 5 ---------------------------------------------------------------- */}
      <Section
        step={5}
        title="Where are your customers?"
        hint="Your ads only show to people in the places you pick here. Choose as few as you can — a smaller area makes a small budget go further."
      >
        <div className="space-y-4">
          {GEO_GROUPS.map((group) => {
            const options = GEO_PRESETS.filter((g) => g.group === group.key)
            if (options.length === 0) return null
            return (
              <div key={group.key}>
                <p className="label mb-2">{group.heading}</p>
                <div className="flex flex-wrap gap-1.5">
                  {options.map((g) => {
                    const on = geo.includes(g.criterionId)
                    return (
                      <button
                        key={g.criterionId}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setGeo((prev) =>
                            prev.includes(g.criterionId)
                              ? prev.filter((id) => id !== g.criterionId)
                              : [...prev, g.criterionId],
                          )
                          clearError('geo')
                        }}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors',
                          on
                            ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                            : 'border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink',
                        )}
                      >
                        {on && <Check className="h-3 w-3 shrink-0" />}
                        {g.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {errors.geo && <p className="text-xs text-danger-fg">{errors.geo}</p>}
        </div>
      </Section>

      {/* optional ---------------------------------------------------------- */}
      <Card className="px-5 py-4">
        <Disclosure summary="Anything else? (you can skip all of this)">
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Field
              label="Google Ads account"
              hint={
                accounts.length === 0
                  ? 'No account connected yet. You can still build the campaign and attach it later.'
                  : 'Which account this campaign would be created in. Its currency is used for the budget.'
              }
              className="min-w-0"
            >
              <Select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                disabled={accounts.length === 0}
              >
                <option value="">Decide later</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currencyCode})
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Part of which marketing campaign?"
              hint="Links this spend to a plan you already have, so results show up against it."
              className="min-w-0"
            >
              <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">Not linked to one</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="What language do people search in?"
              hint="Google matches this against the language setting of the person searching."
              className="min-w-0"
            >
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGE_PRESETS.map((l) => (
                  <option key={l.criterionId} value={l.criterionId}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Stop on"
              hint="Leave blank and it keeps running until you pause it."
              className="min-w-0"
            >
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>

            <Field
              label="What counts as a result?"
              hint={`${objective.conversionPrompt} Write it plainly — it is recorded so whoever sets up tracking in Google knows what to measure.`}
              className="min-w-0 sm:col-span-2"
            >
              <Input
                value={conversionAction}
                onChange={(e) => setConversionAction(e.target.value)}
                placeholder="Someone submits the contact form"
                maxLength={120}
              />
            </Field>

            <Field
              label="What to call this campaign"
              hint="Only affects what you see here. Left blank, we name it from your description."
              className="min-w-0 sm:col-span-2"
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Named from your description"
                maxLength={120}
              />
            </Field>
          </div>
        </Disclosure>
      </Card>

      <CompetitorContextToggle
        summary={competitorContext}
        checked={useCompetitors}
        onChange={setUseCompetitors}
        surface="ads"
      />

      {/* submit ------------------------------------------------------------ */}
      {/* Stacks on a phone: side by side there is not enough width left for the
          note to be readable, and a squeezed reassurance reassures nobody. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs leading-relaxed text-ink-faint sm:flex-1">
          Building a campaign costs nothing and sends nothing to Google. You will see every keyword
          and every line of ad text before anyone approves it.
          {dailyValid && geo.length > 0 && (
            <>
              {' '}
              As set up, it would spend at most{' '}
              <span className="tnum font-medium text-ink-muted">
                {formatMoney(daily * MONTHLY_BUDGET_MULTIPLIER, currency)}
              </span>{' '}
              a month once running.
            </>
          )}
        </p>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={pending}
          className="w-full sm:w-auto"
        >
          {pending ? (
            <>
              <Spinner className="h-4 w-4" />
              Writing the ad groups and keywords…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Build the campaign
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ pieces */

function Section({
  step,
  title,
  hint,
  children,
}: {
  step: number
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="tnum mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-inset text-xs font-semibold text-ink-muted">
          {step}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          {hint && <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{hint}</p>}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  )
}

/**
 * Rotates the objective's own examples through the placeholder. Starts at the
 * first every time the list changes, so the server-rendered placeholder and the
 * first client render agree.
 */
function useCyclingExample(examples: string[]): string {
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    setIndex(0)
    if (examples.length < 2) return
    const timer = setInterval(() => setIndex((i) => i + 1), 4500)
    return () => clearInterval(timer)
  }, [examples])
  return examples[index % examples.length] ?? ''
}

/** Lenient on purpose: the action prefixes https:// and the validator has the last word. */
function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (/\s/.test(trimmed)) return false
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    return url.hostname.includes('.') && !url.hostname.endsWith('.')
  } catch {
    return false
  }
}
