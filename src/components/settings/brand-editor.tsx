'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Ban, FlaskConical, Gauge, MessageSquareQuote, Plus, Scale, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  ScoreRing,
  Select,
  Textarea,
} from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { CHANNEL_META, channelLabel } from '@/components/domain'
import { estimateTone, flattenBody, readability, scoreAsset } from '@/lib/ai/guardrails'
import type { BrandProfile, Channel, LegalRule, ToneAxis } from '@/lib/db/schema'
import { saveBrandProfile } from '@/app/(app)/settings/actions'
import { AxisSlider, ChannelPicker, ReadOnlyNotice, SaveBar, SettingRow, StringListEditor } from './bits'

/* The five axes, with the poles named. "Formal 58" means nothing on its own. */
const AXES: { key: keyof ToneAxis; label: string; low: string; high: string }[] = [
  { key: 'formal', label: 'Formality', low: 'Conversational', high: 'Formal' },
  { key: 'playful', label: 'Playfulness', low: 'Straight', high: 'Playful' },
  { key: 'technical', label: 'Technical depth', low: 'Plain language', high: 'Technical' },
  { key: 'urgent', label: 'Urgency', low: 'Unhurried', high: 'Urgent' },
  { key: 'warm', label: 'Warmth', low: 'Detached', high: 'Warm' },
]

export type BrandDraft = {
  id: string
  name: string
  voice: string
  tone: ToneAxis
  doList: string[]
  dontList: string[]
  bannedTerms: string[]
  preferredTerms: { avoid: string; use: string }[]
  requiredDisclaimers: { text: string; channels: string[] }[]
  readingLevelMax: number
  maxExclamations: number
  passThreshold: number
  colors: { primary: string; secondary: string; accent: string }
}

export function toDraft(p: BrandProfile): BrandDraft {
  return {
    id: p.id,
    name: p.name,
    voice: p.voice,
    tone: p.tone,
    doList: p.doList,
    dontList: p.dontList,
    bannedTerms: p.bannedTerms,
    preferredTerms: p.preferredTerms,
    requiredDisclaimers: p.requiredDisclaimers,
    readingLevelMax: p.readingLevelMax,
    maxExclamations: p.maxExclamations,
    passThreshold: p.passThreshold,
    colors: p.colors,
  }
}

export function BrandEditor({
  profile,
  legalRules,
  canEdit,
}: {
  profile: BrandProfile
  legalRules: LegalRule[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const initial = React.useMemo(() => toDraft(profile), [profile])
  const [draft, setDraft] = React.useState<BrandDraft>(initial)
  const [baseline, setBaseline] = React.useState<BrandDraft>(initial)
  const [saving, setSaving] = React.useState(false)

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const set = <K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  /* Sample copy lives up here because the sliders draw the sample's position on
     their own track — the test panel and the rules are one instrument. */
  const [sample, setSample] = React.useState(SAMPLES[0].body)
  const [sampleHeadline, setSampleHeadline] = React.useState(SAMPLES[0].headline)
  const [sampleChannel, setSampleChannel] = React.useState<Channel>('email')

  const evaluation = React.useMemo(() => {
    const body = { subject: sampleHeadline || undefined, body: sample }
    const text = flattenBody(body)
    if (!text.trim()) return null
    return {
      detail: scoreAsset({ body, channel: sampleChannel, profile: draft, legalRules }),
      tone: estimateTone(text),
      grade: readability(text).grade,
      words: (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length,
    }
    // Recomputes on every keystroke and every slider drag. The whole guardrail
    // module is pure and dependency-free, so this is microseconds of work in
    // the browser — no round trip, no debounce needed.
  }, [sample, sampleHeadline, sampleChannel, draft, legalRules])

  const save = async () => {
    setSaving(true)
    try {
      const result = await saveBrandProfile(draft)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setBaseline(draft)
        router.refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      {/* ------------------------------------------------------------ rules */}
      <div className="min-w-0 space-y-5">
        {!canEdit && <ReadOnlyNotice what="the brand rules" />}

        <Card className="overflow-hidden">
          <CardHeader
            title="Voice"
            description="Fed to the model on every generation, and the thing a new writer reads first."
            icon={<MessageSquareQuote className="h-4 w-4" />}
            actions={<Badge tone={profile.isDefault ? 'brand' : 'neutral'}>{profile.isDefault ? 'Default profile' : 'Secondary profile'}</Badge>}
          />
          <SettingRow label="Profile name" htmlFor="brand-name">
            <Input
              id="brand-name"
              value={draft.name}
              disabled={!canEdit}
              onChange={(e) => set('name', e.target.value)}
            />
          </SettingRow>
          <SettingRow
            label="How this brand sounds"
            hint="Write it the way you would brief a freelancer. Concrete instructions produce better copy than adjectives."
            htmlFor="brand-voice"
            stack
          >
            <Textarea
              id="brand-voice"
              rows={5}
              value={draft.voice}
              disabled={!canEdit}
              maxLength={2000}
              placeholder="Direct, credible and unhurried. We sound like an experienced practitioner explaining something to a peer…"
              onChange={(e) => set('voice', e.target.value)}
            />
            <p className="mt-1.5 text-2xs text-ink-faint">{draft.voice.length} / 2000 characters</p>
          </SettingRow>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Tone targets"
            description="Generated copy is measured on each axis. Drift beyond 12 points costs brand score; the green or amber marker shows where your sample copy currently sits."
            icon={<Gauge className="h-4 w-4" />}
          />
          <div className="grid gap-5 px-5 py-5 sm:grid-cols-2">
            {AXES.map((axis) => (
              <AxisSlider
                key={axis.key}
                label={axis.label}
                low={axis.low}
                high={axis.high}
                value={draft.tone[axis.key]}
                estimate={evaluation?.tone[axis.key]}
                disabled={!canEdit}
                onChange={(v) => set('tone', { ...draft.tone, [axis.key]: v })}
              />
            ))}
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader title="Always do" description="Matched loosely against copy; hits nudge the brand score up." />
            <div className="px-5 py-4">
              <StringListEditor
                items={draft.doList}
                onChange={(v) => set('doList', v)}
                disabled={!canEdit}
                placeholder="Lead with the concrete problem the reader recognises"
                addLabel="Add"
              />
            </div>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Never do" description="A match costs 12 brand points and is named in the reviewer's notes." />
            <div className="px-5 py-4">
              <StringListEditor
                items={draft.dontList}
                onChange={(v) => set('dontList', v)}
                disabled={!canEdit}
                placeholder="Open with “In today's fast-paced world”"
                addLabel="Add"
              />
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <CardHeader
            title="Banned terms"
            description="A hard block. Any of these words in a draft is a high-severity finding, and high-severity findings cannot be submitted for review at all."
            icon={<Ban className="h-4 w-4" />}
            actions={<Badge tone={draft.bannedTerms.length > 0 ? 'danger' : 'neutral'}>{draft.bannedTerms.length}</Badge>}
          />
          <div className="px-5 py-4">
            <StringListEditor
              items={draft.bannedTerms}
              onChange={(v) => set('bannedTerms', v)}
              disabled={!canEdit}
              placeholder="revolutionary"
              addLabel="Ban"
              compact
            />
            <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
              Matched on whole words, case-insensitively. “disrupt” will not catch “disruption”.
            </p>
          </div>
        </Card>

        <PreferredTermsCard
          items={draft.preferredTerms}
          onChange={(v) => set('preferredTerms', v)}
          disabled={!canEdit}
        />

        <DisclaimersCard
          items={draft.requiredDisclaimers}
          onChange={(v) => set('requiredDisclaimers', v)}
          disabled={!canEdit}
        />

        <Card className="overflow-hidden">
          <CardHeader
            title="Thresholds"
            description="The numbers that decide whether a generated asset reaches a human or bounces back to the model."
            icon={<Scale className="h-4 w-4" />}
          />
          <SettingRow
            label="Maximum reading grade"
            hint="Flesch–Kincaid. Each grade above the limit costs 11 readability points. UK marketing copy usually sits between 8 and 11."
            htmlFor="brand-grade"
          >
            <div className="flex items-center gap-3">
              <Input
                id="brand-grade"
                type="number"
                min={4}
                max={18}
                className="tnum w-20"
                value={draft.readingLevelMax}
                disabled={!canEdit}
                onChange={(e) => set('readingLevelMax', Number(e.target.value))}
              />
              {evaluation && (
                <span
                  className={cn(
                    'tnum text-xs',
                    evaluation.grade > draft.readingLevelMax ? 'text-warn-fg' : 'text-ok-fg',
                  )}
                >
                  sample reads at grade {evaluation.grade.toFixed(1)}
                </span>
              )}
            </div>
          </SettingRow>
          <SettingRow
            label="Exclamation marks allowed"
            hint="Counted across the whole asset, including subject lines and hashtags."
            htmlFor="brand-excl"
          >
            <Input
              id="brand-excl"
              type="number"
              min={0}
              max={10}
              className="tnum w-20"
              value={draft.maxExclamations}
              disabled={!canEdit}
              onChange={(e) => set('maxExclamations', Number(e.target.value))}
            />
          </SettingRow>
          <SettingRow
            label="Pass threshold"
            hint="Composite score an asset must reach to be marked as passing. Raising it produces more regeneration and fewer reviewer edits; lowering it does the opposite."
            htmlFor="brand-threshold"
          >
            <div>
              <div className="flex items-center gap-3">
                <input
                  id="brand-threshold"
                  type="range"
                  min={50}
                  max={100}
                  value={draft.passThreshold}
                  disabled={!canEdit}
                  onChange={(e) => set('passThreshold', Number(e.target.value))}
                  className={cn(
                    'h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60',
                    '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-600 [&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-surface',
                    '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand-600',
                  )}
                />
                <span className="tnum w-10 text-right text-sm font-semibold text-ink">
                  {draft.passThreshold}
                </span>
              </div>
              <p className="mt-1.5 text-2xs text-ink-faint">
                Composite = 40% brand voice, 45% compliance, 15% readability.
              </p>
            </div>
          </SettingRow>
        </Card>

        {canEdit && (
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={save}
            onReset={() => setDraft(baseline)}
            summary="Brand rules changed. They apply to the next generation."
          />
        )}
      </div>

      {/* ------------------------------------------------------ test panel */}
      <div className="min-w-0 xl:sticky xl:top-[88px] xl:self-start">
        <TestPanel
          sample={sample}
          onSample={setSample}
          headline={sampleHeadline}
          onHeadline={setSampleHeadline}
          channel={sampleChannel}
          onChannel={setSampleChannel}
          evaluation={evaluation}
          draft={draft}
          dirty={dirty}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ test panel */

function TestPanel({
  sample,
  onSample,
  headline,
  onHeadline,
  channel,
  onChannel,
  evaluation,
  draft,
  dirty,
}: {
  sample: string
  onSample: (v: string) => void
  headline: string
  onHeadline: (v: string) => void
  channel: Channel
  onChannel: (v: Channel) => void
  evaluation: {
    detail: ReturnType<typeof scoreAsset>
    tone: ToneAxis
    grade: number
    words: number
  } | null
  draft: BrandDraft
  dirty: boolean
}) {
  const detail = evaluation?.detail
  const headlineLabel =
    channel === 'email' ? 'Subject line' : channel === 'blog' || channel === 'web' ? 'Title' : 'Headline'

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Test these rules"
        description="Paste real copy. It is scored in your browser against the rules exactly as they stand above — including changes you have not saved."
        icon={<FlaskConical className="h-4 w-4" />}
      />

      <div className="space-y-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2">
          <Select
            value={channel}
            onChange={(e) => onChannel(e.target.value as Channel)}
            className="h-8 py-1 text-[13px]"
            aria-label="Channel to test against"
          >
            {(Object.keys(CHANNEL_META) as Channel[]).map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </Select>
          {dirty && <Badge tone="warn">Unsaved rules</Badge>}
        </div>

        <Input
          value={headline}
          onChange={(e) => onHeadline(e.target.value)}
          placeholder={headlineLabel}
          aria-label={headlineLabel}
          className="h-8 py-1 text-[13px]"
        />
        <Textarea
          rows={7}
          value={sample}
          onChange={(e) => onSample(e.target.value)}
          placeholder="Paste a draft here…"
          aria-label="Sample copy"
          className="text-[13px]"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-ink-faint">Try:</span>
          {SAMPLES.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                onSample(s.body)
                onHeadline(s.headline)
              }}
              className="rounded-md bg-bg-inset px-2 py-0.5 text-2xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {!detail ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-faint">
          Nothing to score yet. Paste some copy above.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4 border-b border-line px-5 py-4">
            <ScoreRing score={detail.composite} size={56} strokeWidth={4} label="Composite score" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">
                {detail.passed
                  ? `Passes at ${detail.composite}/100`
                  : detail.compliance.findings.some((f) => f.severity === 'high')
                    ? 'Blocked before review'
                    : `${detail.composite}/100 — under the ${draft.passThreshold} threshold`}
              </p>
              <p className="mt-0.5 text-xs leading-snug text-ink-muted">
                {detail.passed
                  ? 'This would reach a reviewer without a regeneration.'
                  : detail.compliance.findings.some((f) => f.severity === 'high')
                    ? 'A high-severity finding stops submission outright, whatever the score.'
                    : 'Aurea would regenerate this rather than send it to a reviewer.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
            <SubScore label="Brand voice" value={detail.brand.score} weight="40%" />
            <SubScore label="Compliance" value={detail.compliance.score} weight="45%" />
            <SubScore
              label="Readability"
              value={detail.readability.score}
              weight="15%"
              foot={`grade ${detail.readability.grade.toFixed(1)}`}
            />
          </div>

          {detail.compliance.findings.length === 0 ? (
            <div className="px-5 py-4">
              <p className="text-[13px] text-ok-fg">No compliance findings against these rules.</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {detail.compliance.findings.map((f, i) => (
                <li key={`${f.ruleId}-${i}`} className="px-5 py-3">
                  <div className="flex items-start gap-2">
                    <Badge
                      tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'neutral'}
                    >
                      {f.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium leading-snug text-ink">{f.ruleName}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{f.message}</p>
                      {f.excerpt && (
                        <p className="mt-1 truncate rounded bg-bg-inset px-1.5 py-0.5 font-mono text-2xs text-ink-muted">
                          “{f.excerpt}”
                        </p>
                      )}
                      {f.remedy && (
                        <p className="mt-1 flex items-start gap-1 text-2xs leading-relaxed text-ink-faint">
                          <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" />
                          {f.remedy}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {detail.brand.notes.length > 0 && (
            <div className="border-t border-line bg-bg-subtle px-5 py-3">
              <p className="label mb-1.5">Voice notes</p>
              <ul className="space-y-1">
                {detail.brand.notes.map((note, i) => (
                  <li key={i} className="text-xs leading-relaxed text-ink-muted">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="border-t border-line px-5 py-2.5 text-2xs text-ink-faint">
            {evaluation.words} words · scored locally, nothing is stored
          </p>
        </>
      )}
    </Card>
  )
}

function SubScore({
  label,
  value,
  weight,
  foot,
}: {
  label: string
  value: number
  weight: string
  foot?: string
}) {
  return (
    <div className="px-4 py-3">
      <p className="label">{label}</p>
      <p
        className={cn(
          'tnum mt-1 text-lg font-semibold leading-none',
          value >= 85 ? 'text-ok-fg' : value >= 70 ? 'text-warn-fg' : 'text-danger-fg',
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-2xs text-ink-faint">{foot ?? `${weight} of composite`}</p>
    </div>
  )
}

/* ---------------------------------------------------- preferred wording */

function PreferredTermsCard({
  items,
  onChange,
  disabled,
}: {
  items: { avoid: string; use: string }[]
  onChange: (next: { avoid: string; use: string }[]) => void
  disabled?: boolean
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Preferred wording"
        description="Low-severity swaps. The reviewer sees the suggestion rather than a block, so house style stays consistent without stopping work."
        actions={<Badge tone="neutral">{items.length}</Badge>}
      />
      <div className="px-5 py-4">
        {items.length > 0 && (
          <ul className="mb-3 space-y-1.5">
            {items.map((item, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input
                  value={item.avoid}
                  disabled={disabled}
                  placeholder="leverage"
                  aria-label="Word to avoid"
                  className="h-8 py-1 text-[13px]"
                  onChange={(e) =>
                    onChange(items.map((x, j) => (j === i ? { ...x, avoid: e.target.value } : x)))
                  }
                />
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <Input
                  value={item.use}
                  disabled={disabled}
                  placeholder="use"
                  aria-label="Word to use instead"
                  className="h-8 py-1 text-[13px]"
                  onChange={(e) =>
                    onChange(items.map((x, j) => (j === i ? { ...x, use: e.target.value } : x)))
                  }
                />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                    className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-danger-fg"
                    aria-label={`Remove swap ${item.avoid}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!disabled && (
          <Button size="xs" variant="secondary" onClick={() => onChange([...items, { avoid: '', use: '' }])}>
            <Plus className="h-3 w-3" />
            Add a swap
          </Button>
        )}
      </div>
    </Card>
  )
}

/* -------------------------------------------------------- disclaimers */

function DisclaimersCard({
  items,
  onChange,
  disabled,
}: {
  items: { text: string; channels: string[] }[]
  onChange: (next: { text: string; channels: string[] }[]) => void
  disabled?: boolean
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Required disclaimers"
        description="Copy that must appear verbatim on the named channels. A missing disclaimer is high severity, so the asset cannot be submitted until it is there."
        actions={<Badge tone={items.length > 0 ? 'warn' : 'neutral'}>{items.length}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        {items.map((item, i) => (
          <div key={i} className="rounded-lg border border-line bg-bg-subtle p-3">
            <div className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={item.text}
                disabled={disabled}
                placeholder="Results shown are from a pilot programme and are not a prediction of your results."
                aria-label="Disclaimer text"
                className="text-[13px]"
                onChange={(e) =>
                  onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(items.filter((_, j) => j !== i))}
                  className="mt-1.5 shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-danger-fg"
                  aria-label="Remove disclaimer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-2.5">
              <p className="label mb-1.5">Required on</p>
              <ChannelPicker
                value={item.channels}
                disabled={disabled}
                emptyMeans="Required on every channel"
                onChange={(channels) =>
                  onChange(items.map((x, j) => (j === i ? { ...x, channels } : x)))
                }
              />
            </div>
            <p className="mt-2 text-2xs text-ink-faint">
              Matched on the first 40 characters, so light reformatting downstream will not trip it.
            </p>
          </div>
        ))}
        {!disabled && (
          <Button size="xs" variant="secondary" onClick={() => onChange([...items, { text: '', channels: [] }])}>
            <Plus className="h-3 w-3" />
            Add a disclaimer
          </Button>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- samples */

/** Three real drafts: one clean, one that trips the usual rules, one borderline. */
const SAMPLES = [
  {
    label: 'On-brand draft',
    headline: 'The approval queue is where campaigns die',
    body: `Most teams can produce a month of content in an afternoon. Getting it signed off is the part that takes three weeks.

We measured it across eleven B2B teams last quarter: median time from finished draft to approved was 6.4 days, and 40% of that was work sitting in an inbox nobody was watching.

Aurea puts the review step inside the same tool that made the draft. Every asset arrives already scored against your brand and legal rules, so a reviewer opens something that has already cleared the obvious problems.

Worth twenty minutes? Pick a time that suits you.`,
  },
  {
    label: 'Trips the rules',
    headline: 'The best-in-class platform that will skyrocket your ROI',
    body: `In today's fast-paced world, marketing teams need a revolutionary solution!

Our game-changing platform delivers guaranteed results — teams leverage Aurea to unlock an ROI of 340% in the first quarter alone!!! It's clinically proven to reduce approval times and it beats HubSpot on every measure.

We added you to this list because we think you'll love it. Don't miss out — this offer ends today!`,
  },
  {
    label: 'Borderline',
    headline: 'Quarterly product update',
    body: `The instrumentation layer now exposes per-asset attribution through the metrics pipeline, with p95 ingestion latency under 400ms across all supported connector integrations and a revised schema for downstream segmentation orchestration.

Configuration is available through the API or the console. Documentation for the migration path from the previous webhook architecture is published alongside this release.`,
  },
]
