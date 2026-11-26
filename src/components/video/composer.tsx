'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react'
import { Clapperboard, Image, Sparkles, TriangleAlert, UserRound } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives'
import { generateVideoAction, quoteVideoAction } from '@/app/actions/video'
import type { VideoQuote, VideoQuoteInput } from '@/lib/video/service'
import type { VideoCreativeMode, VideoReferenceAsset } from '@/lib/video/prompt'
import type { ComposerModel } from '@/app/(app)/studio/video/queries'

/**
 * The video brief composer.
 *
 * Two rules govern this surface.
 *
 * The price is never a surprise. It is on screen before the button is, it moves
 * as the settings move, and the button says the figure it is about to spend.
 * The acknowledgement is not a modal bolted on at the end — the exact figure
 * displayed here goes back to the server, and if the two disagree the server
 * refuses.
 *
 * And only what the chosen model can actually do is offered. Lengths,
 * resolutions and ratios all come from the catalogue and re-narrow when the
 * model changes, so there is no way to select a combination that exists only
 * in the form. The server clamps and refuses independently; this just means
 * nobody has to discover that after committing to a spend.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const rate = (cents: number) => `$${(cents / 100).toFixed(2)}/s`

export type ComposerChannel = { value: string; label: string }

type ReferenceDraft = {
  speakerUrl: string
  speakerLabel: string
  speakerInstruction: string
  speakerConsent: boolean
  logoUrl: string
  logoLabel: string
  logoInstruction: string
  productUrl: string
  productLabel: string
  productInstruction: string
  sceneUrl: string
  sceneLabel: string
  sceneInstruction: string
}

/** The ratio each channel wants, mirrored from VIDEO_CHANNEL_ASPECT server-side. */
const CHANNEL_ASPECT: Record<string, string> = {
  instagram: '9:16',
  facebook: '4:5',
  linkedin: '1:1',
  x: '16:9',
  meta_ads: '9:16',
  google_ads: '16:9',
  web: '16:9',
}

export function VideoComposer({
  channels,
  models,
  defaultModel,
  maxVariants,
  briefId = null,
  onQueued,
  initial,
}: {
  channels: ComposerChannel[]
  models: ComposerModel[]
  defaultModel: string
  maxVariants: number
  briefId?: string | null
  onQueued?: (ids: string[]) => void
  /** Prefill from another surface, e.g. a Competitors play. Everything stays editable. */
  initial?: { title?: string; prompt?: string; script?: string; channel?: string }
}) {
  const [modelId, setModelId] = useState(defaultModel)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [script, setScript] = useState(initial?.script ?? '')
  const [channel, setChannel] = useState(
    channels.find((c) => c.value === initial?.channel)?.value ?? channels[0]?.value ?? 'instagram',
  )
  const [audio, setAudio] = useState(false)
  const [variants, setVariants] = useState(Math.min(2, maxVariants))
  const [creativeMode, setCreativeMode] = useState<VideoCreativeMode>('auto')
  const [references, setReferences] = useState<ReferenceDraft>({
    speakerUrl: '',
    speakerLabel: '',
    speakerInstruction: '',
    speakerConsent: false,
    logoUrl: '',
    logoLabel: '',
    logoInstruction: '',
    productUrl: '',
    productLabel: '',
    productInstruction: '',
    sceneUrl: '',
    sceneLabel: '',
    sceneInstruction: '',
  })

  const model = useMemo(
    () => models.find((m) => m.id === modelId) ?? models[0],
    [models, modelId],
  )

  /* What this model offers, narrowed to what the plan allows. */
  const resolutions: string[] = model?.resolutions ?? ['720p']
  const [resolution, setResolution] = useState<string>(
    resolutions.includes('720p') ? '720p' : (resolutions[resolutions.length - 1] ?? '720p'),
  )

  const durations = useMemo(() => {
    if (!model) return [6]
    const lock = model.resolutionDurationLocks?.[resolution as keyof typeof model.resolutionDurationLocks]
    return model.durations.filter((d) => !lock || lock.includes(d))
  }, [model, resolution])

  const [durationSeconds, setDuration] = useState(durations[1] ?? durations[0] ?? 6)
  const currentRate = model?.centsPerSecondByResolution?.[resolution as keyof typeof model.centsPerSecondByResolution] ?? model?.centsPerSecond ?? 0

  /* Changing the model can invalidate the current settings, so they follow it
     rather than being left in a state the model would reject. */
  useEffect(() => {
    if (!resolutions.includes(resolution)) {
      setResolution(resolutions.includes('720p') ? '720p' : (resolutions[resolutions.length - 1] ?? '720p'))
    }
  }, [resolutions, resolution])

  useEffect(() => {
    if (!durations.includes(durationSeconds)) setDuration(durations[durations.length - 1] ?? 6)
  }, [durations, durationSeconds])

  useEffect(() => {
    if (audio && model && !model.generatesAudio) setAudio(false)
  }, [audio, model])

  const [quote, setQuote] = useState<VideoQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const referenceAssets = useMemo(() => buildReferences(references), [references])

  const input: VideoQuoteInput = useMemo(
    () => ({
      title: title.trim() || 'Untitled clip',
      prompt,
      script: script.trim() || null,
      channel: channel as VideoQuoteInput['channel'],
      resolution: resolution as VideoQuoteInput['resolution'],
      durationSeconds,
      variants,
      audio,
      requestedModel: modelId,
      creativeMode,
      referenceAssets,
    }),
    [title, prompt, script, channel, resolution, durationSeconds, variants, audio, modelId, creativeMode, referenceAssets],
  )

  /* Quoting writes nothing and spends nothing, so it is safe to run often —
     debounced only so it is not one request per keystroke. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (prompt.trim().length < 8) {
      setQuote(null)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setQuoting(true)
      setError(null)
      const res = await quoteVideoAction(input)
      setQuoting(false)
      if (res.ok && res.data) setQuote(res.data)
      else {
        setQuote(null)
        setError(res.message)
      }
    }, 450)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [input, prompt])

  const generate = useCallback(() => {
    if (!quote?.canProceed) return
    start(async () => {
      setError(null)
      const res = await generateVideoAction({
        input,
        // The handshake: exactly what is on screen goes back to the server.
        acknowledgedFingerprint: quote.estimate.fingerprint,
        acknowledgedTotalCents: quote.estimate.totalCents,
        briefId,
      })
      if (!res.ok) {
        setError(res.message)
        return
      }
      onQueued?.(res.data?.ids ?? [])
      setPrompt('')
      setScript('')
      setQuote(null)
    })
  }, [quote, input, briefId, onQueued])

  const blocking = (quote?.score.compliance.findings ?? []).filter((f) => f.severity === 'high')
  const advisory = (quote?.score.compliance.findings ?? []).filter((f) => f.severity !== 'high')

  const wantedAspect = CHANNEL_ASPECT[channel]
  const aspectMismatch = Boolean(model && wantedAspect && !model.aspectRatios.includes(wantedAspect as never))
  const needsKey = Boolean(model && !model.configured)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------------- brief */}
      <div className="min-w-0 space-y-4">
        <Field label="Name" hint="How this clip appears in the queue and the audit trail.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Spring launch teaser" />
        </Field>

        <Field
          label="What should the clip show?"
          hint="One sentence is enough. GenAI turns it into a timed director prompt before anything is generated."
          required
        >
          <Textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A slow push-in on a ceramic mug on a windowsill, soft morning light, steam rising, shallow depth of field."
          />
        </Field>

        <Field label="Creative mode" hint="Controls the automatic shot recipe; spend and duration still come from policy.">
          <div className="grid gap-2 sm:grid-cols-4">
            {[
              ['auto', 'Auto'],
              ['ugc', 'Speaker'],
              ['product', 'Product'],
              ['cinematic', 'Cinematic'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setCreativeMode(value as VideoCreativeMode)}
                aria-pressed={creativeMode === value}
                className={
                  creativeMode === value
                    ? 'rounded-md bg-ink px-3 py-2 text-xs font-semibold text-ink-invert'
                    : 'rounded-md px-3 py-2 text-xs font-medium text-ink-muted ring-1 ring-inset ring-line hover:ring-ink-faint'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Script or voiceover"
          hint="Scored against your brand profile and legal rules before anything is generated."
        >
          <Textarea
            rows={3}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Mornings, made simple."
          />
        </Field>

        <Card className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Creative references</h3>
              <p className="mt-0.5 text-xs text-ink-faint">Optional images for the speaker, logo, product or scene.</p>
            </div>
            {referenceAssets.length > 0 && <Badge tone="info">{referenceAssets.length} image{referenceAssets.length === 1 ? '' : 's'}</Badge>}
          </div>

          <ReferenceFields
            icon={<UserRound className="h-3.5 w-3.5" />}
            title="Person who can speak"
            url={references.speakerUrl}
            label={references.speakerLabel}
            instruction={references.speakerInstruction}
            onUrl={(value) => setReferences((r) => ({ ...r, speakerUrl: value }))}
            onLabel={(value) => setReferences((r) => ({ ...r, speakerLabel: value }))}
            onInstruction={(value) => setReferences((r) => ({ ...r, speakerInstruction: value }))}
          />
          {references.speakerUrl.trim() && (
            <label className="flex items-start gap-2 rounded-md bg-bg-inset p-3 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={references.speakerConsent}
                onChange={(e) => setReferences((r) => ({ ...r, speakerConsent: e.target.checked }))}
                className="mt-0.5 h-4 w-4"
              />
              I have permission to use this person's likeness in generated video.
            </label>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            <ReferenceFields
              icon={<Image className="h-3.5 w-3.5" />}
              title="Logo"
              url={references.logoUrl}
              label={references.logoLabel}
              instruction={references.logoInstruction}
              onUrl={(value) => setReferences((r) => ({ ...r, logoUrl: value }))}
              onLabel={(value) => setReferences((r) => ({ ...r, logoLabel: value }))}
              onInstruction={(value) => setReferences((r) => ({ ...r, logoInstruction: value }))}
              compact
            />
            <ReferenceFields
              icon={<Image className="h-3.5 w-3.5" />}
              title="Product"
              url={references.productUrl}
              label={references.productLabel}
              instruction={references.productInstruction}
              onUrl={(value) => setReferences((r) => ({ ...r, productUrl: value }))}
              onLabel={(value) => setReferences((r) => ({ ...r, productLabel: value }))}
              onInstruction={(value) => setReferences((r) => ({ ...r, productInstruction: value }))}
              compact
            />
            <ReferenceFields
              icon={<Image className="h-3.5 w-3.5" />}
              title="Scene"
              url={references.sceneUrl}
              label={references.sceneLabel}
              instruction={references.sceneInstruction}
              onUrl={(value) => setReferences((r) => ({ ...r, sceneUrl: value }))}
              onLabel={(value) => setReferences((r) => ({ ...r, sceneLabel: value }))}
              onInstruction={(value) => setReferences((r) => ({ ...r, sceneInstruction: value }))}
              compact
            />
          </div>
        </Card>

        {/* ------------------------------------------------------- model */}
        <Field
          label="Model"
          hint="Cheapest first. Changing it re-prices the clip and narrows the lengths and sizes to what that model makes."
        >
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.configured}>
                {m.label} —{' '}
                {m.centsPerSecondByResolution
                  ? `from ${rate(Math.min(...Object.values(m.centsPerSecondByResolution)))}`
                  : rate(m.centsPerSecond)}
                {m.generatesAudio ? ` (+${rate(m.audioCentsPerSecond)} audio)` : ' · silent'}
                {m.configured ? '' : ' — needs a key'}
              </option>
            ))}
          </Select>
        </Field>

        {needsKey && model?.keyName && (
          <p className="rounded-md bg-warn-bg px-3 py-2 text-xs text-warn-fg">
            {model.label} has no credentials on this deployment. Set{' '}
            <code className="font-mono text-2xs">{model.keyName}</code> and restart the app and the worker to
            use it.
          </p>
        )}

        {model?.note && !needsKey && <p className="text-xs text-ink-faint">{model.note}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel" hint="Sets the aspect ratio and the delivery checks.">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Resolution">
            <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Length" hint="Only the lengths this model makes at this size.">
            <div className="flex flex-wrap gap-2">
              {durations.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  aria-pressed={durationSeconds === d}
                  className={
                    durationSeconds === d
                      ? 'rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-ink-invert'
                      : 'rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted ring-1 ring-inset ring-line hover:ring-ink-faint'
                  }
                >
                  {d}s
                </button>
              ))}
            </div>
          </Field>

          <Field label="Variants" hint="Each one costs the same as the first.">
            <Input
              type="number"
              min={1}
              max={maxVariants}
              value={variants}
              onChange={(e) => setVariants(Math.max(1, Math.min(maxVariants, Number(e.target.value) || 1)))}
            />
          </Field>
        </div>

        {aspectMismatch && (
          <p className="flex items-start gap-1.5 rounded-md bg-warn-bg px-3 py-2 text-xs text-warn-fg">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {model?.label} cannot produce the {wantedAspect} this channel wants — it makes{' '}
            {model?.aspectRatios.join(', ')}. Choose another model or another channel.
          </p>
        )}

        <label className="flex items-center gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            checked={audio}
            onChange={(e) => setAudio(e.target.checked)}
            disabled={!model?.generatesAudio}
            className="h-4 w-4"
          />
          Generate audio
          <span className="text-ink-faint">
            {model?.generatesAudio
              ? `— adds ${rate(model.audioCentsPerSecond)}`
              : `— ${model?.label} does not generate audio`}
          </span>
        </label>
      </div>

      {/* ------------------------------------------------- price, always on */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <Card className="space-y-4 p-4">
          {quote?.directorPrompt && (
            <div className="rounded-md bg-bg-inset p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <Sparkles className="h-3.5 w-3.5" />
                Director prompt ready
              </p>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-2xs leading-relaxed text-ink-muted">
                {quote.directorPrompt}
              </p>
            </div>
          )}

          <div>
            <div className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">This generation</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums text-ink">
                {quote ? money(quote.estimate.totalCents) : '—'}
              </span>
              {quote && (
                <span className="text-xs text-ink-faint">
                  {quote.variants} × {money(quote.estimate.perVariantCents)}
                </span>
              )}
            </div>
            {quoting && <p className="mt-1 text-xs text-ink-faint">Pricing…</p>}
            {quote?.simulated && (
              <p className="mt-2 rounded-md bg-info-bg px-2 py-1.5 text-xs text-info-fg">
                Running on the simulator. Nothing will be billed, and every clip is labelled.
              </p>
            )}
            {quote?.pricingUnverified && (
              <p className="mt-2 rounded-md bg-warn-bg px-2 py-1.5 text-xs text-warn-fg">
                This vendor price has not been re-checked recently. Treat it as indicative.
              </p>
            )}
          </div>

          {quote && (
            <dl className="space-y-1.5 border-t border-line pt-3 text-xs">
              <Row label="Model" value={quote.modelLabel} />
              <Row label="Rate" value={rate(currentRate + (quote.audio && model?.generatesAudio ? (model.audioCentsPerSecond ?? 0) : 0))} />
              <Row
                label="Format"
                value={`${quote.aspectRatio} · ${quote.resolution} · ${quote.durationSeconds}s`}
              />
              <Row label="Brand score" value={`${quote.score.composite}/100`} />
              <Row
                label="Left this month"
                value={money(quote.ceiling.remainingCents)}
                alarm={quote.ceiling.wouldExceed}
              />
            </dl>
          )}

          {quote && quote.adjustments.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-3 text-xs text-ink-muted">
              {quote.adjustments.map((a) => (
                <li key={a}>· {a}</li>
              ))}
            </ul>
          )}

          {blocking.length > 0 && (
            <div className="space-y-1.5 rounded-md bg-danger-bg p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-danger-fg">
                <TriangleAlert className="h-3.5 w-3.5" />
                Blocked before generating — nothing will be spent
              </p>
              <ul className="space-y-1">
                {blocking.map((f) => (
                  <li key={f.ruleId} className="text-xs text-danger-fg">
                    <span className="font-medium">{f.ruleName}:</span> {f.message}
                    {f.remedy && <span className="block opacity-80">{f.remedy}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {advisory.length > 0 && (
            <ul className="space-y-1 rounded-md bg-warn-bg p-3 text-xs text-warn-fg">
              {advisory.slice(0, 4).map((f) => (
                <li key={f.ruleId}>
                  <span className="font-medium">{f.ruleName}:</span> {f.message}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="rounded-md bg-danger-bg p-3 text-xs text-danger-fg">{error}</p>}

          <Button
            variant="primary"
            className="w-full"
            onClick={generate}
            loading={pending}
            disabled={!quote?.canProceed || pending}
          >
            <Clapperboard className="h-3.5 w-3.5" />
            {quote ? `Generate — ${money(quote.estimate.totalCents)}` : 'Generate'}
          </Button>

          <p className="text-2xs leading-relaxed text-ink-faint">
            Confirming spends {quote ? money(quote.estimate.totalCents) : 'the figure above'} from this
            workspace&rsquo;s monthly video budget. Clips arrive for review — nothing publishes without
            approval.
          </p>
        </Card>
      </aside>
    </div>
  )
}

function Row({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={alarm ? 'font-semibold tabular-nums text-danger-fg' : 'tabular-nums text-ink-muted'}>
        {value}
      </dd>
    </div>
  )
}

function ReferenceFields({
  icon,
  title,
  url,
  label,
  instruction,
  onUrl,
  onLabel,
  onInstruction,
  compact,
}: {
  icon: ReactNode
  title: string
  url: string
  label: string
  instruction: string
  onUrl: (value: string) => void
  onLabel: (value: string) => void
  onInstruction: (value: string) => void
  compact?: boolean
}) {
  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        {icon}
        {title}
      </div>
      <Input value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://..." />
      <Input value={label} onChange={(e) => onLabel(e.target.value)} placeholder="Name or label" />
      <Textarea
        rows={compact ? 2 : 3}
        value={instruction}
        onChange={(e) => onInstruction(e.target.value)}
        placeholder="How should GenAI use this image?"
      />
    </div>
  )
}

function buildReferences(draft: ReferenceDraft): VideoReferenceAsset[] {
  return [
    {
      kind: 'speaker' as const,
      url: draft.speakerUrl,
      label: draft.speakerLabel,
      instruction: draft.speakerInstruction,
      likenessConfirmed: draft.speakerConsent,
    },
    { kind: 'logo' as const, url: draft.logoUrl, label: draft.logoLabel, instruction: draft.logoInstruction },
    {
      kind: 'product' as const,
      url: draft.productUrl,
      label: draft.productLabel,
      instruction: draft.productInstruction,
    },
    { kind: 'scene' as const, url: draft.sceneUrl, label: draft.sceneLabel, instruction: draft.sceneInstruction },
  ].filter((r) => r.url.trim().length > 0)
}
