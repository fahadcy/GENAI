'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarPlus,
  Check,
  History,
  Lock,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { ScoreReport } from '@/components/governance/score-report'
import { CHANNEL_LIMITS } from '@/lib/ai/guardrails'
import { CHANNEL_META } from '@/components/domain'
import { regenerateAsset, submitForReviewAction, updateAssetBody } from '@/app/actions/content'
import { scheduleAssetAction } from '@/app/actions/scheduler'
import type { ApprovalStep, AssetBody, AssetStatus, Channel, ScoreDetail, ToneAxis } from '@/lib/db/schema'

type Props = {
  asset: {
    id: string
    title: string
    channel: string
    body: AssetBody
    status: AssetStatus
    version: number
    scoreDetail: ScoreDetail | null
    imagePrompt: string | null
    editedByHuman: boolean
  }
  profile: { tone: ToneAxis; passThreshold: number; name: string } | null
  legalRuleCount: number
  versions: { version: number; note: string | null; createdAt: string; composite: number | null }[]
  approval: {
    id: string
    status: string
    chainName: string
    currentStep: number
    steps: ApprovalStep[]
    subjectVersion: number
    requestedAt: string
    decisions: {
      decision: string
      comment: string | null
      step: number
      createdAt: string
      userName: string | null
      userHue: number | null
    }[]
  } | null
  segments: { id: string; name: string; reachable: number }[]
  blockReason: string | null
  permissions: { edit: boolean; submit: boolean; schedule: boolean }
}

/**
 * The asset workbench: edit on the left, the guardrail verdict on the right,
 * and the pipeline actions in between.
 *
 * The verdict panel is deliberately always visible rather than behind a tab.
 * Making the score a permanent companion to the text is what turns governance
 * from a gate you hit at the end into something you can see yourself moving.
 */
export function AssetWorkbench(props: Props) {
  const { asset, profile, permissions } = props
  const router = useRouter()
  const { push } = useToast()

  const [body, setBody] = React.useState<AssetBody>(asset.body)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [regenOpen, setRegenOpen] = React.useState(false)
  const [scheduleOpen, setScheduleOpen] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)

  // Reset local edits whenever the server sends a newer version through.
  React.useEffect(() => {
    setBody(asset.body)
  }, [asset.body, asset.version])

  const dirty = JSON.stringify(body) !== JSON.stringify(asset.body)
  const locked = asset.status === 'published' || !permissions.edit
  const limits = CHANNEL_LIMITS[asset.channel] ?? []

  const save = async () => {
    setBusy('save')
    try {
      const r = await updateAssetBody(asset.id, body)
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Saved and re-scored' : 'Could not save', body: r.message })
      if (r.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    setBusy('submit')
    try {
      const r = await submitForReviewAction(asset.id)
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Sent for review' : 'Blocked', body: r.message })
      if (r.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      {/* ------------------------------------------------------- editor */}
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="The asset"
            description={
              locked
                ? asset.status === 'published'
                  ? 'Published assets are read-only. Archive it and generate a replacement instead.'
                  : 'Your role has read-only access to assets.'
                : 'Edit in place. Saving creates a new version and re-scores against the brand and legal rules.'
            }
            actions={
              !locked && (
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setRegenOpen(true)} disabled={busy !== null}>
                    <RefreshCw className="h-3 w-3" />
                    Regenerate
                  </Button>
                  <Button
                    size="xs"
                    variant={dirty ? 'primary' : 'secondary'}
                    onClick={save}
                    disabled={!dirty || busy !== null}
                    loading={busy === 'save'}
                  >
                    <Save className="h-3 w-3" />
                    {dirty ? 'Save' : 'Saved'}
                  </Button>
                </div>
              )
            }
          />

          <div className="space-y-4 p-5">
            <BodyFields body={body} onChange={setBody} channel={asset.channel} disabled={locked} limits={limits} />
          </div>

          {dirty && (
            <div className="flex items-center gap-2 border-t border-line bg-warn-bg px-5 py-2.5 text-[13px] text-warn-fg">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              Unsaved changes. The score on the right still reflects v{asset.version}.
            </div>
          )}
        </Card>

        <Preview body={body} channel={asset.channel} />

        {props.approval && <ApprovalTrail approval={props.approval} assetVersion={asset.version} />}
      </div>

      {/* ---------------------------------------------------- governance */}
      <div className="space-y-4 xl:sticky xl:top-[76px] xl:self-start">
        <Card>
          <CardHeader
            title="Guardrail verdict"
            description={
              profile
                ? `Scored against "${profile.name}" and ${props.legalRuleCount} active legal rule${props.legalRuleCount === 1 ? '' : 's'}.`
                : 'No brand profile configured.'
            }
            icon={<ShieldCheck className="h-4 w-4" />}
            actions={
              props.versions.length > 1 && (
                <Button size="xs" variant="ghost" onClick={() => setHistoryOpen(true)}>
                  <History className="h-3 w-3" />
                  v{asset.version}
                </Button>
              )
            }
          />
          <div className="p-5">
            {asset.scoreDetail && profile ? (
              <ScoreReport
                detail={asset.scoreDetail}
                threshold={profile.passThreshold}
                toneTarget={profile.tone}
              />
            ) : (
              <p className="text-[13px] text-ink-muted">This asset has not been scored.</p>
            )}
          </div>
        </Card>

        {/* Pipeline actions */}
        <Card>
          <CardHeader title="Next step" description="The gate decides what is possible from here." />
          <div className="space-y-3 p-5">
            {asset.status === 'draft' || asset.status === 'changes_requested' ? (
              <>
                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  onClick={submit}
                  loading={busy === 'submit'}
                  disabled={!permissions.submit || dirty || busy !== null}
                >
                  <Send className="h-3.5 w-3.5" />
                  Submit for review
                </Button>
                <p className="text-xs leading-relaxed text-ink-muted">
                  {dirty
                    ? 'Save your changes first — the reviewer must see the version that would publish.'
                    : !permissions.submit
                      ? 'Your role cannot submit work for review.'
                      : asset.scoreDetail?.compliance.findings.some((f) => f.severity === 'high')
                        ? 'A blocking finding will stop this submission. Resolve it above first.'
                        : 'Routed to the approval chain that governs this channel.'}
                </p>
              </>
            ) : asset.status === 'in_review' ? (
              <div className="rounded-lg border border-warn-fg/25 bg-warn-bg p-3">
                <p className="text-[13px] font-semibold text-warn-fg">With a reviewer</p>
                <p className="mt-1 text-xs leading-relaxed text-warn-fg/85">
                  Editing now will withdraw it from review, because the approved version must be the
                  version that goes out.
                </p>
              </div>
            ) : asset.status === 'approved' ? (
              <>
                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  onClick={() => setScheduleOpen(true)}
                  disabled={!permissions.schedule}
                >
                  <CalendarPlus className="h-3.5 w-3.5" />
                  Schedule this
                </Button>
                <p className="text-xs leading-relaxed text-ink-muted">
                  Approved at v{props.approval?.subjectVersion ?? asset.version}. GenAI can pick the
                  send time from how this audience actually engages, or you can set it by hand.
                </p>
              </>
            ) : asset.status === 'scheduled' ? (
              <div className="rounded-lg border border-info-fg/25 bg-info-bg p-3">
                <p className="text-[13px] font-semibold text-info-fg">On the calendar</p>
                <p className="mt-1 text-xs leading-relaxed text-info-fg/85">
                  Waiting for its slot. Manage it from the Scheduler.
                </p>
              </div>
            ) : asset.status === 'published' ? (
              <div className="rounded-lg border border-ok-fg/25 bg-ok-bg p-3">
                <p className="text-[13px] font-semibold text-ok-fg">Published</p>
                <p className="mt-1 text-xs leading-relaxed text-ok-fg/85">
                  Performance is tracked against this asset from here.
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">This asset is archived.</p>
            )}

            {props.blockReason && asset.status !== 'published' && asset.status !== 'approved' && (
              <div className="flex items-start gap-2 rounded-lg bg-bg-subtle p-3">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <p className="text-xs leading-relaxed text-ink-muted">{props.blockReason}</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      <RegenerateModal
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        assetId={asset.id}
        currentTitle={asset.title}
      />
      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        assetId={asset.id}
        channel={asset.channel}
        segments={props.segments}
      />
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        versions={props.versions}
        current={asset.version}
      />
    </div>
  )
}

/* ------------------------------------------------------------- editors */

function BodyFields({
  body,
  onChange,
  channel,
  disabled,
  limits,
}: {
  body: AssetBody
  onChange: (b: AssetBody) => void
  channel: string
  disabled: boolean
  limits: { field: keyof AssetBody; max: number; label: string }[]
}) {
  const limitFor = (field: keyof AssetBody) => limits.find((l) => l.field === field)
  const set = (field: keyof AssetBody, value: string) => onChange({ ...body, [field]: value })

  const counter = (field: keyof AssetBody) => {
    const limit = limitFor(field)
    const value = body[field]
    if (!limit || typeof value !== 'string') return undefined
    const over = value.length > limit.max
    return (
      <span className={cn('tnum text-2xs', over ? 'font-semibold text-danger-fg' : 'text-ink-faint')}>
        {value.length}/{limit.max}
      </span>
    )
  }

  const showSubject = channel === 'email'
  const showHeadline = ['blog', 'google_ads', 'meta_ads', 'push', 'web'].includes(channel)
  const showHashtags = ['linkedin', 'x', 'instagram', 'facebook'].includes(channel)
  const showCta = !['x', 'sms', 'push'].includes(channel)

  return (
    <>
      {showSubject && (
        <>
          <Field
            label={
              <span className="flex w-full items-center justify-between gap-2">
                Subject line {counter('subject')}
              </span>
            }
          >
            <Input value={body.subject ?? ''} onChange={(e) => set('subject', e.target.value)} disabled={disabled} />
          </Field>
          <Field
            label={
              <span className="flex w-full items-center justify-between gap-2">
                Preheader {counter('preheader')}
              </span>
            }
            hint="The line the inbox shows after the subject."
          >
            <Input
              value={body.preheader ?? ''}
              onChange={(e) => set('preheader', e.target.value)}
              disabled={disabled}
            />
          </Field>
        </>
      )}

      {showHeadline && (
        <Field
          label={
            <span className="flex w-full items-center justify-between gap-2">
              Headline {counter('headline')}
            </span>
          }
        >
          <Input value={body.headline ?? ''} onChange={(e) => set('headline', e.target.value)} disabled={disabled} />
        </Field>
      )}

      <Field
        label={
          <span className="flex w-full items-center justify-between gap-2">
            {channel === 'email' ? 'Body' : channel === 'google_ads' ? 'Description' : 'Copy'}{' '}
            {counter('body')}
          </span>
        }
      >
        <Textarea
          rows={channel === 'x' || channel === 'sms' ? 4 : 10}
          value={body.body}
          onChange={(e) => set('body', e.target.value)}
          disabled={disabled}
          className="font-[inherit] text-[14px] leading-relaxed"
        />
      </Field>

      {showCta && (
        <Field label="Call to action">
          <Input value={body.cta ?? ''} onChange={(e) => set('cta', e.target.value)} disabled={disabled} />
        </Field>
      )}

      {showHashtags && (
        <Field label="Hashtags" hint="Comma separated.">
          <Input
            value={(body.hashtags ?? []).join(', ')}
            onChange={(e) =>
              onChange({
                ...body,
                hashtags: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            disabled={disabled}
          />
        </Field>
      )}

      {body.altText !== undefined && (
        <Field label="Image alt text" hint="Required for accessibility on visual channels.">
          <Input value={body.altText ?? ''} onChange={(e) => set('altText', e.target.value)} disabled={disabled} />
        </Field>
      )}
    </>
  )
}

/** Channel-shaped preview, so the copy is judged as it will actually appear. */
function Preview({ body, channel }: { body: AssetBody; channel: string }) {
  return (
    <Card>
      <CardHeader title="Preview" description={`Roughly as it will appear on ${CHANNEL_META[channel as Channel]?.label ?? channel}.`} />
      <div className="p-5">
        <div className="rounded-xl border border-line bg-bg-subtle p-4">
          {channel === 'email' ? (
            <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-4 shadow-card">
              <p className="text-[15px] font-semibold text-ink">{body.subject || 'No subject'}</p>
              <p className="mt-0.5 text-xs text-ink-faint">{body.preheader}</p>
              <div className="my-3 h-px bg-line" />
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{body.body}</p>
              {body.cta && (
                <span className="mt-4 inline-block rounded-lg bg-brand-solid px-4 py-2 text-[13px] font-semibold text-brand-on">
                  {body.cta}
                </span>
              )}
            </div>
          ) : ['linkedin', 'x', 'facebook', 'instagram'].includes(channel) ? (
            <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-4 shadow-card">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-8 w-8 rounded-full bg-brand-600" />
                <div>
                  <p className="text-[13px] font-semibold text-ink">Your brand</p>
                  <p className="text-2xs text-ink-faint">Sponsored · Just now</p>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{body.body}</p>
              {(body.hashtags?.length ?? 0) > 0 && (
                <p className="mt-2 text-[13px] text-brand-600">{body.hashtags?.join(' ')}</p>
              )}
            </div>
          ) : channel === 'google_ads' ? (
            <div className="mx-auto max-w-lg rounded-lg border border-line bg-surface p-4">
              <p className="text-2xs font-bold text-ink">Sponsored</p>
              <p className="mt-1 text-[17px] leading-snug text-info-fg">{body.headline}</p>
              <p className="text-xs text-ok-fg">yourdomain.com</p>
              <p className="mt-1 text-[13px] leading-snug text-ink-muted">{body.body}</p>
            </div>
          ) : channel === 'sms' || channel === 'push' ? (
            <div className="mx-auto max-w-xs rounded-2xl border border-line bg-surface p-3 shadow-card">
              {body.headline && <p className="text-[13px] font-semibold text-ink">{body.headline}</p>}
              <p className="text-[13px] leading-snug text-ink-muted">{body.body}</p>
            </div>
          ) : (
            <article className="mx-auto max-w-2xl">
              {body.headline && (
                <h3 className="text-2xl font-semibold tracking-tight text-ink">{body.headline}</h3>
              )}
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{body.body}</p>
            </article>
          )}
        </div>
      </div>
    </Card>
  )
}

/* -------------------------------------------------------- approval trail */

function ApprovalTrail({
  approval,
  assetVersion,
}: {
  approval: NonNullable<Props['approval']>
  assetVersion: number
}) {
  const stale = approval.status === 'approved' && approval.subjectVersion !== assetVersion

  return (
    <Card>
      <CardHeader
        title="Approval history"
        description={`"${approval.chainName}" — ${approval.steps.length} step${approval.steps.length === 1 ? '' : 's'}.`}
        actions={
          <Badge
            tone={
              approval.status === 'approved'
                ? 'ok'
                : approval.status === 'rejected'
                  ? 'danger'
                  : approval.status === 'pending'
                    ? 'warn'
                    : 'neutral'
            }
            dot
          >
            {approval.status}
          </Badge>
        }
      />

      {stale && (
        <p className="border-b border-line bg-warn-bg px-5 py-2.5 text-[13px] text-warn-fg">
          Approved at v{approval.subjectVersion}, but this asset is now v{assetVersion}. It must go
          back through review before it can publish.
        </p>
      )}

      <ol className="divide-y divide-line">
        {approval.steps.map((step, i) => {
          const decisions = approval.decisions.filter((d) => d.step === i)
          const done = decisions.some((d) => d.decision === 'approve')
          const rejected = decisions.some((d) => d.decision === 'reject')
          const active = approval.status === 'pending' && approval.currentStep === i
          return (
            <li key={i} className="flex items-start gap-3 px-5 py-3">
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold',
                  rejected
                    ? 'bg-danger-bg text-danger-fg'
                    : done
                      ? 'bg-ok-bg text-ok-fg'
                      : active
                        ? 'animate-pulse-ring bg-brand-solid text-brand-on'
                        : 'bg-bg-inset text-ink-faint',
                )}
              >
                {rejected ? <X className="h-3 w-3" /> : done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">
                  {step.name}
                  <span className="ml-2 font-normal text-ink-faint">
                    {step.role} · {step.mode === 'all' ? 'all must approve' : 'any may approve'} ·{' '}
                    {step.slaHours}h SLA
                  </span>
                </p>
                {decisions.map((d, j) => (
                  <div key={j} className="mt-1.5 flex items-start gap-2">
                    {d.userName && <Avatar name={d.userName} hue={d.userHue ?? 250} size={18} />}
                    <div className="min-w-0">
                      <p className="text-xs text-ink-muted">
                        <span className="font-medium text-ink">{d.userName ?? 'Someone'}</span>{' '}
                        {d.decision === 'approve'
                          ? 'approved'
                          : d.decision === 'reject'
                            ? 'requested changes'
                            : d.decision}{' '}
                        · {new Date(d.createdAt).toLocaleString('en-GB')}
                      </p>
                      {d.comment && (
                        <p className="mt-1 rounded-lg bg-bg-subtle px-2.5 py-1.5 text-[13px] leading-relaxed text-ink">
                          {d.comment}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
                {active && decisions.length === 0 && (
                  <p className="mt-1 text-xs text-ink-faint">Waiting for a decision.</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

/* -------------------------------------------------------------- modals */

function RegenerateModal({
  open,
  onClose,
  assetId,
  currentTitle,
}: {
  open: boolean
  onClose: () => void
  assetId: string
  currentTitle: string
}) {
  const router = useRouter()
  const { push } = useToast()
  const [instruction, setInstruction] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const presets = [
    'Make it shorter and more direct.',
    'Less formal, more conversational.',
    'Lead with the number, not the story.',
    'Take the opposite angle.',
    'Make the call to action more specific.',
  ]

  const run = async () => {
    setBusy(true)
    try {
      const r = await regenerateAsset(assetId, instruction.trim() || undefined)
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Regenerated' : 'Could not regenerate', body: r.message })
      if (r.ok) {
        onClose()
        setInstruction('')
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Regenerate this asset"
      description="The brief is preserved. Add a steer if you want the new version to differ in a particular way."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={run} loading={busy}>
            Regenerate
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-muted">
        Replacing <span className="font-medium text-ink">“{currentTitle}”</span>. The current version
        stays in history and can be restored.
      </p>
      <Field label="Steer (optional)">
        <Textarea
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Make it shorter and lead with the cost of delay."
        />
      </Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => setInstruction(p)}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {p}
          </button>
        ))}
      </div>
    </Modal>
  )
}

function ScheduleModal({
  open,
  onClose,
  assetId,
  channel,
  segments,
}: {
  open: boolean
  onClose: () => void
  assetId: string
  channel: string
  segments: { id: string; name: string; reachable: number }[]
}) {
  const router = useRouter()
  const { push } = useToast()
  const [segmentId, setSegmentId] = React.useState(segments[0]?.id ?? '')
  const [mode, setMode] = React.useState<'ai' | 'manual'>('ai')
  const [when, setWhen] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    setBusy(true)
    try {
      const r = await scheduleAssetAction({
        assetId,
        segmentId: segmentId || null,
        scheduledAt: mode === 'manual' && when ? new Date(when).toISOString() : undefined,
      })
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Scheduled' : 'Could not schedule', body: r.message })
      if (r.ok) {
        onClose()
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const selected = segments.find((s) => s.id === segmentId)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule this asset"
      description="Only approved work reaches this dialog — the gate has already been passed."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={run} loading={busy} disabled={mode === 'manual' && !when}>
            Place on the calendar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Audience"
          hint={
            selected
              ? `${selected.reachable.toLocaleString()} contacts are reachable on ${channel.replace('_', ' ')} after consent and suppression.`
              : 'Pick who this goes to.'
          }
        >
          <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
            <option value="">No segment (broadcast)</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.reachable.toLocaleString()} reachable
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Send time">
          <div className="space-y-2">
            <label
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
                mode === 'ai' ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-line-strong',
              )}
            >
              <input
                type="radio"
                checked={mode === 'ai'}
                onChange={() => setMode('ai')}
                className="mt-0.5 accent-[rgb(var(--brand-600))]"
              />
              <span>
                <span className="block text-[13px] font-medium text-ink">Let GenAI choose</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  Picks the slot from when this segment actually engages and how this channel has
                  performed here, and tells you why.
                </span>
              </span>
            </label>

            <label
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
                mode === 'manual' ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-line-strong',
              )}
            >
              <input
                type="radio"
                checked={mode === 'manual'}
                onChange={() => setMode('manual')}
                className="mt-0.5 accent-[rgb(var(--brand-600))]"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">Set it myself</span>
                {mode === 'manual' && (
                  <Input
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    className="mt-2"
                  />
                )}
              </span>
            </label>
          </div>
        </Field>
      </div>
    </Modal>
  )
}

function HistoryModal({
  open,
  onClose,
  versions,
  current,
}: {
  open: boolean
  onClose: () => void
  versions: Props['versions']
  current: number
}) {
  return (
    <Modal open={open} onClose={onClose} title="Version history" description="Every save and regeneration is kept.">
      <ol className="space-y-2">
        {versions.map((v) => (
          <li
            key={v.version}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3',
              v.version === current ? 'border-brand-500 bg-brand-50' : 'border-line',
            )}
          >
            <span className="tnum mt-0.5 shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-2xs font-bold text-ink-muted">
              v{v.version}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink">{v.note ?? 'No note'}</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                {new Date(v.createdAt).toLocaleString('en-GB')}
                {v.composite !== null && ` · scored ${v.composite}/100`}
              </p>
            </div>
            {v.version === current && <Badge tone="brand">Current</Badge>}
          </li>
        ))}
      </ol>
    </Modal>
  )
}
