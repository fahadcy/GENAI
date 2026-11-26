'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, ShieldCheck, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { CHANNEL_META } from '@/components/domain'
import { TONE_AXES } from '@/lib/ai/guardrails'
import {
  CompetitorContextToggle,
  type CompetitorContextSummary,
} from '@/components/competitors/context-toggle'
import { createBriefAndGenerate } from '@/app/actions/content'
import type { Channel, ToneAxis } from '@/lib/db/schema'

type ProfileSummary = {
  name: string
  voice: string
  tone: ToneAxis
  bannedTerms: string[]
  passThreshold: number
  doList: string[]
  dontList: string[]
}

const SUGGESTED_CHANNELS: Channel[] = [
  'email',
  'linkedin',
  'blog',
  'x',
  'google_ads',
  'meta_ads',
  'instagram',
  'facebook',
  'sms',
  'push',
]

export function BriefComposer({
  campaigns,
  profile,
  defaultCampaignId,
  liveModel,
  initial,
  competitorContext = null,
}: {
  campaigns: { id: string; name: string; channels: string[] }[]
  profile: ProfileSummary | null
  defaultCampaignId: string | null
  liveModel: boolean
  /** Prefill from another surface, e.g. a PPC & SEO content gap. Everything stays editable. */
  initial?: { title?: string; objective?: string; keyMessages?: string[]; channels?: string[] }
  /** The latest competitor landscape, when there is one. */
  competitorContext?: CompetitorContextSummary | null
}) {
  const router = useRouter()
  const { push } = useToast()
  const [pending, setPending] = React.useState(false)

  const [title, setTitle] = React.useState(initial?.title ?? '')
  const [objective, setObjective] = React.useState(initial?.objective ?? '')
  const [audienceNote, setAudienceNote] = React.useState('')
  const [keyMessages, setKeyMessages] = React.useState<string[]>(
    initial?.keyMessages?.length ? initial.keyMessages : [''],
  )
  const [channels, setChannels] = React.useState<string[]>(
    initial?.channels?.length ? initial.channels : ['email', 'linkedin'],
  )
  const [callToAction, setCallToAction] = React.useState('')
  const [mustInclude, setMustInclude] = React.useState('')
  const [mustAvoid, setMustAvoid] = React.useState('')
  const [campaignId, setCampaignId] = React.useState(defaultCampaignId ?? '')
  const [variants, setVariants] = React.useState(2)
  const [useCompetitors, setUseCompetitors] = React.useState(Boolean(competitorContext))

  const toggleChannel = (c: string) =>
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  // Picking a campaign adopts its channel plan — the campaign already decided
  // where this work is going, so making the user restate it is busywork.
  const onCampaignChange = (id: string) => {
    setCampaignId(id)
    const c = campaigns.find((x) => x.id === id)
    if (c && c.channels.length > 0) setChannels(c.channels)
  }

  const totalVariants = channels.length * variants
  const valid = title.trim().length >= 3 && objective.trim().length >= 10 && channels.length > 0

  const submit = async () => {
    if (!valid || pending) return
    setPending(true)
    try {
      const result = await createBriefAndGenerate({
        title: title.trim(),
        objective: objective.trim(),
        audienceNote: audienceNote.trim() || undefined,
        keyMessages: keyMessages.map((m) => m.trim()).filter(Boolean),
        channels,
        callToAction: callToAction.trim() || undefined,
        mustInclude: splitList(mustInclude),
        mustAvoid: splitList(mustAvoid),
        campaignId: campaignId || null,
        variantsPerChannel: variants,
        useCompetitorContext: Boolean(competitorContext) && useCompetitors,
      })

      if (!result.ok) {
        push({ tone: 'danger', title: 'Could not generate', body: result.message })
        return
      }

      push({
        tone: 'ok',
        title: result.message,
        body: result.data?.simulated
          ? 'Generated with the deterministic simulator — add an API key in Settings to use a live model.'
          : 'Every variant was scored against your brand and legal rules before you see it.',
      })
      const first = result.data?.assetIds[0]
      router.push(first ? `/studio/${first}` : '/studio')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="The brief"
            description="Write it the way you would brief a colleague. Specifics produce better assets than adjectives."
          />
          <div className="space-y-4 p-5">
            <Field label="Title" required hint="How this work will be listed. Not customer-facing.">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Launch announcement — one governed pipeline"
                autoFocus
              />
            </Field>

            <Field
              label="Objective"
              required
              hint="What should this achieve, and for whom? One or two sentences."
            >
              <Textarea
                rows={3}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="Announce the unified workspace and drive demo signups from marketing leaders who currently run three or four overlapping tools."
              />
            </Field>

            <Field label="Audience" hint="Who is reading this? Roles, company size, situation.">
              <Input
                value={audienceNote}
                onChange={(e) => setAudienceNote(e.target.value)}
                placeholder="Heads of marketing at UK and US companies of 100–2,000 people"
              />
            </Field>

            <Field
              label="Key messages"
              hint="The points every variant must land, in your own words. The model varies the angle, not the substance."
            >
              <div className="space-y-2">
                {keyMessages.map((m, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={m}
                      onChange={(e) =>
                        setKeyMessages((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      placeholder={
                        i === 0
                          ? 'the work is slow because the steps do not talk to each other'
                          : 'another point this must make'
                      }
                    />
                    {keyMessages.length > 1 && (
                      <Button
                        variant="ghost"
                        size="md"
                        onClick={() => setKeyMessages((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Remove message"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setKeyMessages((p) => [...p, ''])}>
                  <Plus className="h-3.5 w-3.5" />
                  Add message
                </Button>
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Call to action" hint="What you want the reader to do.">
                <Input
                  value={callToAction}
                  onChange={(e) => setCallToAction(e.target.value)}
                  placeholder="Book a walkthrough"
                />
              </Field>
              <Field label="Campaign" hint="Links the assets into a plan and its approval gates.">
                <Select value={campaignId} onChange={(e) => onCampaignChange(e.target.value)}>
                  <option value="">No campaign</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Must include" hint="Comma separated. Offers, dates, legal wording.">
                <Input
                  value={mustInclude}
                  onChange={(e) => setMustInclude(e.target.value)}
                  placeholder="14-day trial, no card required"
                />
              </Field>
              <Field label="Must avoid" hint="Comma separated. Beyond the workspace banned terms.">
                <Input
                  value={mustAvoid}
                  onChange={(e) => setMustAvoid(e.target.value)}
                  placeholder="pricing specifics, competitor names"
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Channels"
            description="Each channel gets copy shaped for it — length, structure and conventions differ."
          />
          <div className="p-5">
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_CHANNELS.map((c) => {
                const meta = CHANNEL_META[c]
                const Icon = meta.icon
                const on = channels.includes(c)
                return (
                  <button
                    key={c}
                    onClick={() => toggleChannel(c)}
                    aria-pressed={on}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors',
                      on
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                )
              })}
            </div>

            <div className="mt-5 flex flex-wrap items-end gap-4">
              <Field
                label="Variants per channel"
                hint="Each takes a different angle, not a reworded version of the same one."
                className="w-48"
              >
                <Select value={String(variants)} onChange={(e) => setVariants(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="pb-2 text-[13px] text-ink-muted">
                <span className="tnum font-semibold text-ink">{totalVariants}</span> asset
                {totalVariants === 1 ? '' : 's'} will be generated and scored.
              </p>
            </div>
          </div>
        </Card>

        <CompetitorContextToggle
          summary={competitorContext}
          checked={useCompetitors}
          onChange={setUseCompetitors}
          surface="content"
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={submit} disabled={!valid} loading={pending}>
            <Wand2 className="h-4 w-4" />
            {pending ? 'Generating and scoring…' : `Generate ${totalVariants} variants`}
          </Button>
          {!valid && (
            <p className="text-[13px] text-ink-faint">
              A title and an objective of at least a sentence are needed.
            </p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- governance rail */}
      <div className="space-y-4 xl:sticky xl:top-[76px] xl:self-start">
        <Card>
          <CardHeader
            title="Rules that will be applied"
            description="Enforced at generation, then scored again before anyone reviews it."
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          {profile ? (
            <div className="space-y-4 p-5">
              <div>
                <p className="label mb-1">Voice profile</p>
                <p className="text-[13px] font-medium text-ink">{profile.name}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{profile.voice}</p>
              </div>

              <div>
                <p className="label mb-2">Tone targets</p>
                <div className="space-y-1.5">
                  {TONE_AXES.map((axis) => (
                    <div key={axis} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-xs capitalize text-ink-muted">{axis}</span>
                      <div className="relative h-1.5 flex-1 rounded-full bg-bg-inset">
                        <div
                          className="absolute inset-y-0 left-0 rounded-full bg-brand-400"
                          style={{ width: `${profile.tone[axis]}%` }}
                        />
                      </div>
                      <span className="tnum w-6 shrink-0 text-right text-2xs text-ink-faint">
                        {profile.tone[axis]}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {profile.dontList.length > 0 && (
                <div>
                  <p className="label mb-1.5">Never</p>
                  <ul className="space-y-1">
                    {profile.dontList.slice(0, 4).map((d, i) => (
                      <li key={i} className="text-xs leading-relaxed text-ink-muted">
                        · {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {profile.bannedTerms.length > 0 && (
                <div>
                  <p className="label mb-1.5">Banned terms</p>
                  <div className="flex flex-wrap gap-1">
                    {profile.bannedTerms.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-danger-bg px-1.5 py-0.5 font-mono text-2xs text-danger-fg"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">
                An asset must reach {profile.passThreshold}/100 to pass, and any high-severity legal
                finding blocks it regardless of score.
              </p>
            </div>
          ) : (
            <p className="p-5 text-[13px] text-ink-muted">
              No default brand profile is configured, so generation cannot be scored. Add one in
              Settings → Brand first.
            </p>
          )}
        </Card>

        <div className="flex items-start gap-2.5 rounded-card border border-line bg-bg-subtle p-4">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <div>
            <p className="text-[13px] font-medium text-ink">
              {liveModel ? 'Live model connected' : 'Running on the built-in simulator'}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              {liveModel
                ? 'Generation calls your configured provider through the model gateway, with per-task model tiering and usage metering.'
                : 'No API key is configured, so generation uses the deterministic simulator. Everything else — scoring, approvals, scheduling — behaves identically. Add a key in Settings to switch.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
