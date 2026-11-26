'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, FileText, GitCompare, ShieldCheck, UserPlus, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar, Badge, Button, Card, CardHeader, Field, Select, Textarea } from '@/components/ui/primitives'
import { Modal, Tabs, useToast } from '@/components/ui/client'
import { ScoreReport } from '@/components/governance/score-report'
import { channelLabel } from '@/components/domain'
import { decideAction, delegateAction } from '@/app/actions/approvals'
import type { ApprovalStep, AssetBody, ScoreDetail, Role, ToneAxis } from '@/lib/db/schema'

type Props = {
  requestId: string
  status: string
  asset: {
    id: string
    title: string
    channel: string
    body: AssetBody
    version: number
    scoreDetail: ScoreDetail | null
    editedByHuman: boolean
  }
  priorBody: AssetBody | null
  priorVersion: number | null
  brief: {
    title: string
    objective: string
    audienceNote: string | null
    keyMessages: string[]
    callToAction: string | null
    mustInclude: string[]
    mustAvoid: string[]
  } | null
  profile: { tone: ToneAxis; passThreshold: number; name: string } | null
  legalRuleCount: number
  chain: { name: string; steps: ApprovalStep[]; currentStep: number; dueAt: string | null }
  decisions: {
    decision: string
    comment: string | null
    step: number
    createdAt: string
    userName: string | null
    userHue: number | null
  }[]
  delegates: { id: string; name: string; role: string; avatarHue: number }[]
  viewer: { eligible: boolean; canDecide: boolean; role: Role }
}

/**
 * The reviewer's screen. Three things have to be true here for approval to be
 * fast rather than a chore: the reviewer sees exactly what will publish, they
 * see what the guardrails already found, and — on a re-review — they see what
 * actually changed rather than re-reading the whole thing.
 */
export function ReviewPanel(props: Props) {
  const { asset, profile, chain, viewer } = props
  const router = useRouter()
  const { push } = useToast()

  const [tab, setTab] = React.useState<'copy' | 'diff' | 'brief'>(
    props.priorBody ? 'diff' : 'copy',
  )
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [delegateOpen, setDelegateOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)

  const open = props.status === 'pending'

  const approve = async () => {
    setBusy('approve')
    try {
      const r = await decideAction(props.requestId, 'approve')
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Recorded' : 'Could not record', body: r.message })
      if (r.ok) router.push('/approvals')
    } finally {
      setBusy(null)
    }
  }

  const tabs = [
    { value: 'copy', label: 'What will publish' },
    ...(props.priorBody ? [{ value: 'diff', label: `Changes since v${props.priorVersion}` }] : []),
    ...(props.brief ? [{ value: 'brief', label: 'The brief' }] : []),
  ]

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title={asset.title}
            description={`Variant on ${channelLabel(asset.channel)}${asset.editedByHuman ? ' · edited by hand after generation' : ' · as generated'}`}
            icon={<FileText className="h-4 w-4" />}
          />
          <div className="border-b border-line px-5 py-2.5">
            <Tabs tabs={tabs} value={tab} onChange={(v) => setTab(v as typeof tab)} />
          </div>

          <div className="p-5">
            {tab === 'copy' && <CopyView body={asset.body} />}
            {tab === 'diff' && props.priorBody && (
              <DiffView before={props.priorBody} after={asset.body} />
            )}
            {tab === 'brief' && props.brief && <BriefView brief={props.brief} />}
          </div>
        </Card>

        {props.decisions.length > 0 && (
          <Card>
            <CardHeader title="Decisions so far" description="Recorded and unchangeable." />
            <ul className="divide-y divide-line">
              {props.decisions.map((d, i) => (
                <li key={i} className="flex items-start gap-3 px-5 py-3">
                  {d.userName ? (
                    <Avatar name={d.userName} hue={d.userHue ?? 250} size={24} />
                  ) : (
                    <span className="mt-1.5 h-2 w-2 rounded-full bg-ink-faint" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-ink">
                      <span className="font-medium">{d.userName ?? 'Someone'}</span>{' '}
                      {d.decision === 'approve'
                        ? 'approved'
                        : d.decision === 'reject'
                          ? 'requested changes'
                          : d.decision === 'delegate'
                            ? 'delegated this step'
                            : 'commented'}{' '}
                      at step {d.step + 1}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {new Date(d.createdAt).toLocaleString('en-GB')}
                    </p>
                    {d.comment && (
                      <p className="mt-1.5 rounded-lg bg-bg-subtle px-3 py-2 text-[13px] leading-relaxed text-ink">
                        {d.comment}
                      </p>
                    )}
                  </div>
                  <Badge tone={d.decision === 'approve' ? 'ok' : d.decision === 'reject' ? 'danger' : 'neutral'}>
                    {d.decision}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------- decision */}
      <div className="space-y-4 xl:sticky xl:top-[76px] xl:self-start">
        <Card>
          <CardHeader
            title="Your decision"
            description={
              !open
                ? `This request is already ${props.status}.`
                : viewer.eligible
                  ? `Step ${chain.currentStep + 1}: ${chain.steps[chain.currentStep]?.name}.`
                  : 'This step is assigned to a different role.'
            }
          />
          <div className="space-y-3 p-5">
            <StepLadder chain={chain} decisions={props.decisions} />

            {open && viewer.eligible && viewer.canDecide ? (
              <>
                <div className="flex gap-2">
                  <Button
                    variant="success"
                    size="md"
                    className="flex-1"
                    onClick={approve}
                    loading={busy === 'approve'}
                    disabled={busy !== null}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="md"
                    className="flex-1"
                    onClick={() => setRejectOpen(true)}
                    disabled={busy !== null}
                  >
                    <X className="h-4 w-4" />
                    Request changes
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setDelegateOpen(true)}
                  disabled={busy !== null}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Delegate this step
                </Button>
                <p className="text-xs leading-relaxed text-ink-faint">
                  {chain.currentStep === chain.steps.length - 1
                    ? 'This is the final step — approving releases the asset for scheduling.'
                    : `Approving passes it to "${chain.steps[chain.currentStep + 1]?.name}".`}{' '}
                  Requesting changes requires a comment and returns it to the author.
                </p>
              </>
            ) : (
              <p className="rounded-lg bg-bg-subtle p-3 text-[13px] leading-relaxed text-ink-muted">
                {!open
                  ? 'No further decision is possible on a closed request. The trail below is permanent.'
                  : !viewer.canDecide
                    ? 'Your role does not decide approvals. You can read everything here, which is deliberate — a bottleneck should never be invisible.'
                    : `This step is for ${chain.steps[chain.currentStep]?.role}s. You are not an eligible approver on it.`}
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="What the guardrails found"
            description={
              profile
                ? `Scored before submission against "${profile.name}" and ${props.legalRuleCount} legal rule${props.legalRuleCount === 1 ? '' : 's'}.`
                : 'No brand profile configured.'
            }
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <div className="p-5">
            {asset.scoreDetail && profile ? (
              <ScoreReport
                detail={asset.scoreDetail}
                threshold={profile.passThreshold}
                toneTarget={profile.tone}
              />
            ) : (
              <p className="text-[13px] text-ink-muted">This asset was not scored.</p>
            )}
          </div>
        </Card>
      </div>

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        requestId={props.requestId}
        assetTitle={asset.title}
      />
      <DelegateModal
        open={delegateOpen}
        onClose={() => setDelegateOpen(false)}
        requestId={props.requestId}
        delegates={props.delegates}
      />
    </div>
  )
}

/* --------------------------------------------------------------- views */

function CopyView({ body }: { body: AssetBody }) {
  const rows: [string, string | undefined][] = [
    ['Subject', body.subject],
    ['Preheader', body.preheader],
    ['Headline', body.headline],
  ]
  return (
    <div className="space-y-4">
      {rows.map(([label, value]) =>
        value ? (
          <div key={label}>
            <p className="label mb-1">{label}</p>
            <p className="text-[14px] font-medium text-ink">{value}</p>
          </div>
        ) : null,
      )}
      <div>
        <p className="label mb-1">Body</p>
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{body.body}</p>
      </div>
      {body.cta && (
        <div>
          <p className="label mb-1">Call to action</p>
          <span className="inline-block rounded-lg bg-brand-solid px-3.5 py-1.5 text-[13px] font-semibold text-brand-on">
            {body.cta}
          </span>
        </div>
      )}
      {(body.hashtags?.length ?? 0) > 0 && (
        <div>
          <p className="label mb-1">Hashtags</p>
          <p className="text-[13px] text-brand-600">{body.hashtags?.join(' ')}</p>
        </div>
      )}
      {body.altText && (
        <div>
          <p className="label mb-1">Image alt text</p>
          <p className="text-[13px] text-ink-muted">{body.altText}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Word-level diff (AP-2: "clear content diffs on re-review"). A longest-common-
 * subsequence walk rather than a line diff, because marketing copy is edited
 * mid-sentence far more often than by whole paragraphs.
 */
function DiffView({ before, after }: { before: AssetBody; after: AssetBody }) {
  const fields: (keyof AssetBody)[] = ['subject', 'preheader', 'headline', 'body', 'cta']
  const changed = fields.filter((f) => {
    const a = before[f]
    const b = after[f]
    return typeof a === 'string' || typeof b === 'string' ? (a ?? '') !== (b ?? '') : false
  })

  if (changed.length === 0) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink-muted">
        <GitCompare className="h-3.5 w-3.5" />
        The copy is identical to the previous version.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-ink-muted">
        {changed.length} field{changed.length === 1 ? '' : 's'} changed. Removed text is struck
        through, added text is highlighted.
      </p>
      {changed.map((f) => (
        <div key={String(f)}>
          <p className="label mb-1.5 capitalize">{String(f)}</p>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
            {diffWords(String(before[f] ?? ''), String(after[f] ?? '')).map((part, i) => (
              <span
                key={i}
                className={cn(
                  part.type === 'del' && 'bg-danger-bg text-danger-fg line-through decoration-1',
                  part.type === 'add' && 'bg-ok-bg text-ok-fg',
                  part.type === 'same' && 'text-ink',
                )}
              >
                {part.value}
              </span>
            ))}
          </p>
        </div>
      ))}
    </div>
  )
}

type DiffPart = { type: 'same' | 'add' | 'del'; value: string }

function diffWords(before: string, after: string): DiffPart[] {
  // Split on whitespace but keep it, so reflowed text still reads naturally.
  const a = before.split(/(\s+)/)
  const b = after.split(/(\s+)/)

  const n = a.length
  const m = b.length
  // Standard LCS table. Copy fields are short enough that O(n·m) is fine.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const parts: DiffPart[] = []
  const pushPart = (type: DiffPart['type'], value: string) => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.value += value
    else parts.push({ type, value })
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushPart('same', a[i])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pushPart('del', a[i])
      i++
    } else {
      pushPart('add', b[j])
      j++
    }
  }
  while (i < n) pushPart('del', a[i++])
  while (j < m) pushPart('add', b[j++])

  return parts
}

function BriefView({ brief }: { brief: NonNullable<Props['brief']> }) {
  return (
    <div className="space-y-4 text-[13.5px]">
      <div>
        <p className="label mb-1">Objective</p>
        <p className="leading-relaxed text-ink">{brief.objective}</p>
      </div>
      {brief.audienceNote && (
        <div>
          <p className="label mb-1">Audience</p>
          <p className="leading-relaxed text-ink">{brief.audienceNote}</p>
        </div>
      )}
      {brief.keyMessages.length > 0 && (
        <div>
          <p className="label mb-1.5">Key messages it had to land</p>
          <ul className="space-y-1">
            {brief.keyMessages.map((m, i) => (
              <li key={i} className="leading-relaxed text-ink-muted">
                · {m}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {brief.callToAction && (
          <div>
            <p className="label mb-1">Call to action</p>
            <p className="text-ink">{brief.callToAction}</p>
          </div>
        )}
        {brief.mustInclude.length > 0 && (
          <div>
            <p className="label mb-1">Must include</p>
            <p className="text-ink">{brief.mustInclude.join(', ')}</p>
          </div>
        )}
        {brief.mustAvoid.length > 0 && (
          <div>
            <p className="label mb-1">Must avoid</p>
            <p className="text-ink">{brief.mustAvoid.join(', ')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function StepLadder({
  chain,
  decisions,
}: {
  chain: Props['chain']
  decisions: Props['decisions']
}) {
  return (
    <ol className="space-y-1.5">
      {chain.steps.map((s, i) => {
        const approved = decisions.some((d) => d.step === i && d.decision === 'approve')
        const active = chain.currentStep === i
        return (
          <li
            key={i}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2',
              active ? 'bg-brand-50' : 'bg-bg-subtle',
            )}
          >
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold',
                approved ? 'bg-ok-fg text-ink-invert' : active ? 'bg-brand-solid text-brand-on' : 'bg-bg-inset text-ink-faint',
              )}
            >
              {approved ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{s.name}</span>
            <span className="shrink-0 text-2xs text-ink-faint">{s.role}</span>
          </li>
        )
      })}
    </ol>
  )
}

/* -------------------------------------------------------------- modals */

function RejectModal({
  open,
  onClose,
  requestId,
  assetTitle,
}: {
  open: boolean
  onClose: () => void
  requestId: string
  assetTitle: string
}) {
  const router = useRouter()
  const { push } = useToast()
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!comment.trim()) return
    setBusy(true)
    try {
      const r = await decideAction(requestId, 'reject', comment.trim())
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Sent back' : 'Could not record', body: r.message })
      if (r.ok) router.push('/approvals')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request changes"
      description={`The author will be notified and "${assetTitle}" returns to draft.`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={submit} loading={busy} disabled={!comment.trim()}>
            Send back
          </Button>
        </>
      }
    >
      <Field
        label="What needs to change?"
        required
        hint="Required. A rejection without a reason costs the team another round trip."
      >
        <Textarea
          rows={5}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="The second paragraph implies a performance guarantee. Please restate it as a range observed in the pilot, and name the pilot."
          autoFocus
        />
      </Field>
    </Modal>
  )
}

function DelegateModal({
  open,
  onClose,
  requestId,
  delegates,
}: {
  open: boolean
  onClose: () => void
  requestId: string
  delegates: Props['delegates']
}) {
  const router = useRouter()
  const { push } = useToast()
  const [userId, setUserId] = React.useState(delegates[0]?.id ?? '')
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!userId) return
    setBusy(true)
    try {
      const r = await delegateAction(requestId, userId, comment.trim() || undefined)
      push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Delegated' : 'Could not delegate', body: r.message })
      if (r.ok) {
        onClose()
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
      title="Delegate this step"
      description="They become an eligible approver on this step. The delegation itself is recorded."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy} disabled={!userId}>
            Delegate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Delegate to">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {delegates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.role}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note (optional)">
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Out until Thursday — could you take this one?"
          />
        </Field>
      </div>
    </Modal>
  )
}
