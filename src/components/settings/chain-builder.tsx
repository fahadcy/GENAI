'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Pencil,
  Plus,
  Route,
  Timer,
  Trash2,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { ChannelChip, channelLabel, formatDurationMs } from '@/components/domain'
import { ROLE_LABEL } from '@/lib/auth/rbac'
import type { ApprovalChain, ApprovalStep, Channel, Role } from '@/lib/db/schema'
import { deleteApprovalChain, saveApprovalChain, testChainMatch } from '@/app/(app)/settings/actions'
import { ChannelPicker, Toggle } from './bits'

export type ChainView = {
  chain: ApprovalChain
  requests: number
  pending: number
  avgResolutionMs: number | null
  unstaffedSteps: string[]
}

type Draft = {
  id?: string
  name: string
  description: string
  channels: string[]
  spendThreshold: number | null
  steps: ApprovalStep[]
  isDefault: boolean
  active: boolean
  priority: number
}

const ROLES: Role[] = ['owner', 'admin', 'creator', 'strategist', 'approver', 'analyst']

const BLANK: Draft = {
  name: '',
  description: '',
  channels: [],
  spendThreshold: null,
  steps: [{ name: 'Review', role: 'approver', mode: 'any', slaHours: 24 }],
  isDefault: false,
  active: true,
  priority: 10,
}

export function ChainBuilder({
  chains,
  roleHeadcount,
  currency,
  canEdit,
}: {
  chains: ChainView[]
  roleHeadcount: Record<string, number>
  currency: string
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = React.useState<Draft | null>(null)
  const [busy, setBusy] = React.useState(false)

  const save = async (draft: Draft) => {
    setBusy(true)
    try {
      const result = await saveApprovalChain({
        ...draft,
        description: draft.description || undefined,
        // ApprovalStep.role is a plain string in the schema; the action narrows
        // it to the role enum, so assert it back at the boundary.
        steps: draft.steps.map((s) => ({ ...s, role: s.role as Role })),
      })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      const result = await deleteApprovalChain(id)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const toDraft = (view: ChainView): Draft => ({
    id: view.chain.id,
    name: view.chain.name,
    description: view.chain.description ?? '',
    channels: view.chain.scope.channels ?? [],
    spendThreshold: view.chain.scope.spendThreshold ?? null,
    steps: view.chain.steps,
    isDefault: view.chain.isDefault,
    active: view.chain.active,
    priority: view.chain.priority,
  })

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Approval chains"
          description="The most specific matching chain governs an asset. Channel scope beats spend scope; the workspace default catches everything else."
          icon={<GitBranch className="h-4 w-4" />}
          actions={
            canEdit && (
              <Button size="xs" variant="secondary" onClick={() => setEditing({ ...BLANK })}>
                <Plus className="h-3 w-3" />
                New chain
              </Button>
            )
          }
        />

        {chains.length === 0 ? (
          <EmptyState
            icon={<GitBranch className="h-5 w-5" />}
            title="No approval chains"
            description="Without a chain nothing can be submitted for review, which means nothing can be published. Start with a single-step chain marked as the workspace default."
            action={
              canEdit && (
                <Button size="sm" variant="primary" onClick={() => setEditing({ ...BLANK, isDefault: true })}>
                  Create the default chain
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {chains.map((view) => (
              <li key={view.chain.id}>
                <ChainRow
                  view={view}
                  currency={currency}
                  roleHeadcount={roleHeadcount}
                  canEdit={canEdit}
                  onEdit={() => setEditing(toDraft(view))}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <ChainModal
          draft={editing}
          busy={busy}
          currency={currency}
          roleHeadcount={roleHeadcount}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => void save(editing)}
          onDelete={editing.id ? () => void remove(editing.id!) : undefined}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------- chain row */

function ChainRow({
  view,
  currency,
  roleHeadcount,
  canEdit,
  onEdit,
}: {
  view: ChainView
  currency: string
  roleHeadcount: Record<string, number>
  canEdit: boolean
  onEdit: () => void
}) {
  const { chain } = view
  const totalSla = chain.steps.reduce((a, s) => a + (s.slaHours || 0), 0)

  return (
    <div className={cn('px-5 py-4', !chain.active && 'opacity-60')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink">{chain.name}</h3>
            {chain.isDefault && <Badge tone="brand">Workspace default</Badge>}
            {!chain.active && <Badge tone="neutral">Retired</Badge>}
            {view.pending > 0 && <Badge tone="warn">{view.pending} in flight</Badge>}
          </div>
          {chain.description && (
            <p className="mt-1 max-w-2xl text-[13px] leading-snug text-ink-muted">{chain.description}</p>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label={`Edit ${chain.name}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="label">Applies to</span>
        {(chain.scope.channels ?? []).length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {chain.scope.channels!.map((c) => (
              <ChannelChip key={c} channel={c} size="sm" />
            ))}
          </span>
        ) : typeof chain.scope.spendThreshold !== 'number' ? (
          <span className="text-ink-muted">anything without a more specific chain</span>
        ) : null}
        {typeof chain.scope.spendThreshold === 'number' && (
          <span className="tnum inline-flex items-center gap-1 rounded-md bg-bg-inset px-2 py-0.5 text-ink">
            spend ≥ {currencySymbol(currency)}
            {chain.scope.spendThreshold.toLocaleString('en-GB')}
          </span>
        )}
        <span className="text-ink-faint">priority {chain.priority}</span>
      </div>

      <StepFlow steps={chain.steps} roleHeadcount={roleHeadcount} className="mt-3" />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3 w-3" />
          {totalSla}h total SLA
        </span>
        <span>
          {view.requests} request{view.requests === 1 ? '' : 's'} governed
        </span>
        {view.avgResolutionMs !== null && (
          <span>average resolution {formatDurationMs(view.avgResolutionMs)}</span>
        )}
        {view.unstaffedSteps.length > 0 && (
          <span className="inline-flex items-center gap-1 text-danger-fg">
            <AlertTriangle className="h-3 w-3" />
            nobody holds the role for {view.unstaffedSteps.join(', ')} — work would stall here
          </span>
        )}
      </div>
    </div>
  )
}

function StepFlow({
  steps,
  roleHeadcount,
  className,
}: {
  steps: ApprovalStep[]
  roleHeadcount?: Record<string, number>
  className?: string
}) {
  if (steps.length === 0) {
    return <p className={cn('text-xs text-danger-fg', className)}>No steps — this chain approves nothing.</p>
  }
  return (
    <ol className={cn('flex flex-wrap items-stretch gap-1.5', className)}>
      {steps.map((step, i) => {
        const staffed = !roleHeadcount || (step.approverIds?.length ?? 0) > 0 || (roleHeadcount[step.role] ?? 0) > 0
        return (
          <li key={i} className="flex items-stretch gap-1.5">
            <div
              className={cn(
                'rounded-lg border px-2.5 py-1.5',
                staffed ? 'border-line bg-bg-subtle' : 'border-danger-fg/40 bg-danger-bg',
              )}
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
                <span className="tnum flex h-4 w-4 items-center justify-center rounded bg-brand-solid text-2xs font-semibold text-brand-on">
                  {i + 1}
                </span>
                {step.name}
              </p>
              <p className="mt-0.5 text-2xs text-ink-muted">
                {ROLE_LABEL[step.role as Role] ?? step.role} ·{' '}
                {step.mode === 'all' ? 'all must approve' : 'any one approves'} · {step.slaHours}h
                {step.approverIds?.length ? ` · ${step.approverIds.length} named` : ''}
              </p>
            </div>
            {i < steps.length - 1 && (
              <span className="flex items-center text-ink-faint">
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/* ---------------------------------------------------------- chain modal */

function ChainModal({
  draft,
  busy,
  currency,
  roleHeadcount,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  draft: Draft
  busy: boolean
  currency: string
  roleHeadcount: Record<string, number>
  onChange: (next: Draft) => void
  onClose: () => void
  onSave: () => void
  onDelete?: () => void
}) {
  const setStep = (index: number, patch: Partial<ApprovalStep>) =>
    onChange({
      ...draft,
      steps: draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    })

  const move = (index: number, delta: number) => {
    const next = [...draft.steps]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange({ ...draft, steps: next })
  }

  const valid = draft.name.trim().length >= 3 && draft.steps.length > 0 && draft.steps.every((s) => s.name.trim())

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={draft.id ? 'Edit approval chain' : 'New approval chain'}
      description="Steps run in order. Everything on a step must be satisfied before the next one is notified."
      footer={
        <>
          {onDelete && (
            <Button size="sm" variant="ghost" className="mr-auto text-danger-fg" onClick={onDelete} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onSave} loading={busy} disabled={!valid}>
            {draft.id ? 'Save chain' : 'Create chain'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <div className="space-y-1.5">
            <label htmlFor="chain-name" className="text-[13px] font-medium text-ink">
              Chain name
            </label>
            <Input
              id="chain-name"
              value={draft.name}
              placeholder="Paid media"
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="chain-priority" className="text-[13px] font-medium text-ink">
              Priority
            </label>
            <Input
              id="chain-priority"
              type="number"
              min={0}
              max={100}
              className="tnum"
              value={draft.priority}
              onChange={(e) => onChange({ ...draft, priority: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="chain-desc" className="text-[13px] font-medium text-ink">
            What this chain is for
          </label>
          <Textarea
            id="chain-desc"
            rows={2}
            value={draft.description}
            placeholder="Anything with spend behind it goes through legal, then ops."
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
        </div>

        {/* ------------------------------------------------------- scope */}
        <div className="rounded-lg border border-line p-3.5">
          <p className="text-[13px] font-medium text-ink">Scope</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            A chain with no scope only ever matches as the workspace default. Adding a channel makes it
            beat the default for that channel; adding a spend threshold makes it beat a channel match.
          </p>

          <div className="mt-3">
            <p className="label mb-1.5">Channels</p>
            <ChannelPicker
              value={draft.channels}
              onChange={(channels) => onChange({ ...draft, channels })}
              emptyMeans="channel is not part of the match"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={draft.spendThreshold !== null}
                onChange={(e) => onChange({ ...draft, spendThreshold: e.target.checked ? 2500 : null })}
                className="h-3.5 w-3.5 accent-brand-600"
              />
              Only above a spend threshold
            </label>
            {draft.spendThreshold !== null && (
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-ink-faint">{currencySymbol(currency)}</span>
                <Input
                  type="number"
                  min={0}
                  step={500}
                  className="tnum h-8 w-32 py-1 text-[13px]"
                  value={draft.spendThreshold}
                  aria-label="Spend threshold"
                  onChange={(e) => onChange({ ...draft, spendThreshold: Number(e.target.value) })}
                />
              </div>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------- steps */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[13px] font-medium text-ink">Steps</p>
            <Button
              size="xs"
              variant="secondary"
              disabled={draft.steps.length >= 6}
              onClick={() =>
                onChange({
                  ...draft,
                  steps: [...draft.steps, { name: '', role: 'approver', mode: 'any', slaHours: 24 }],
                })
              }
            >
              <Plus className="h-3 w-3" />
              Add step
            </Button>
          </div>

          <ul className="space-y-2">
            {draft.steps.map((step, i) => {
              const headcount = roleHeadcount[step.role] ?? 0
              return (
                <li key={i} className="rounded-lg border border-line bg-bg-subtle p-3">
                  <div className="flex items-start gap-2">
                    <span className="tnum mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-brand-solid text-2xs font-semibold text-brand-on">
                      {i + 1}
                    </span>
                    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_150px_120px_90px]">
                      <Input
                        value={step.name}
                        placeholder="Legal review"
                        aria-label={`Step ${i + 1} name`}
                        className="h-8 py-1 text-[13px]"
                        onChange={(e) => setStep(i, { name: e.target.value })}
                      />
                      <Select
                        value={step.role}
                        aria-label={`Step ${i + 1} role`}
                        className="h-8 py-1 text-[13px]"
                        onChange={(e) => setStep(i, { role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                      <Select
                        value={step.mode}
                        aria-label={`Step ${i + 1} mode`}
                        className="h-8 py-1 text-[13px]"
                        onChange={(e) => setStep(i, { mode: e.target.value as 'any' | 'all' })}
                      >
                        <option value="any">Any one</option>
                        <option value="all">All of them</option>
                      </Select>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          max={336}
                          value={step.slaHours}
                          aria-label={`Step ${i + 1} SLA hours`}
                          className="tnum h-8 py-1 text-[13px]"
                          onChange={(e) => setStep(i, { slaHours: Number(e.target.value) })}
                        />
                        <span className="text-2xs text-ink-faint">h</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        className="rounded p-0.5 text-ink-faint transition-colors hover:text-ink disabled:opacity-30"
                        aria-label={`Move step ${i + 1} earlier`}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === draft.steps.length - 1}
                        className="rounded p-0.5 text-ink-faint transition-colors hover:text-ink disabled:opacity-30"
                        aria-label={`Move step ${i + 1} later`}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {draft.steps.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                        className="mt-1.5 shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-danger-fg"
                        aria-label={`Remove step ${i + 1}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p
                    className={cn(
                      'mt-2 pl-7 text-2xs',
                      headcount === 0 ? 'text-danger-fg' : 'text-ink-faint',
                    )}
                  >
                    <Users className="mr-1 inline h-3 w-3" />
                    {headcount === 0
                      ? `Nobody in this workspace holds the ${ROLE_LABEL[step.role as Role] ?? step.role} role. Work would stop at this step.`
                      : step.mode === 'all'
                        ? `All ${headcount} ${ROLE_LABEL[step.role as Role]?.toLowerCase() ?? step.role}${headcount === 1 ? '' : 's'} must approve before the chain moves on.`
                        : `${headcount} person${headcount === 1 ? '' : 's'} can clear this step; the first to act moves it on.`}
                  </p>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
            <div className="min-w-0 pr-4">
              <p className="text-[13px] font-medium text-ink">Workspace default</p>
              <p className="text-xs leading-snug text-ink-muted">
                Catches anything no other chain matches. Exactly one chain can hold this, so setting it
                here removes it from whichever chain has it now.
              </p>
            </div>
            <Toggle
              checked={draft.isDefault}
              label="Workspace default"
              onChange={(isDefault) => onChange({ ...draft, isDefault })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
            <div className="min-w-0 pr-4">
              <p className="text-[13px] font-medium text-ink">Active</p>
              <p className="text-xs leading-snug text-ink-muted">
                A retired chain stops matching new work but keeps its history.
              </p>
            </div>
            <Toggle checked={draft.active} label="Chain active" onChange={(active) => onChange({ ...draft, active })} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------ the tester */

/**
 * Chain matching is otherwise invisible until an asset is already in review.
 * This runs the real `matchChain` on the server against real chains, so what it
 * says here is what would actually happen.
 */
export function ChainMatchTester({
  channels,
  currency,
  defaultSpend,
}: {
  channels: Channel[]
  currency: string
  defaultSpend: number
}) {
  const [channel, setChannel] = React.useState<string>(channels[0] ?? 'email')
  const [spend, setSpend] = React.useState(defaultSpend)
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof testChainMatch>> | null>(null)
  const [busy, setBusy] = React.useState(false)

  const run = React.useCallback(async (c: string, s: number) => {
    setBusy(true)
    try {
      setResult(await testChainMatch(c, s))
    } finally {
      setBusy(false)
    }
  }, [])

  // Resolve once on mount so the panel is never an empty prompt.
  React.useEffect(() => {
    void run(channel, spend)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Which chain would this go through?"
        description="Pick a channel and a budget. This runs the real matcher against the chains above."
        icon={<Route className="h-4 w-4" />}
      />
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor="test-channel" className="label block">
            Channel
          </label>
          <Select
            id="test-channel"
            value={channel}
            className="h-8 w-40 py-1 text-[13px]"
            onChange={(e) => {
              setChannel(e.target.value)
              void run(e.target.value, spend)
            }}
          >
            {channels.map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="test-spend" className="label block">
            Spend behind it
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-ink-faint">{currencySymbol(currency)}</span>
            <Input
              id="test-spend"
              type="number"
              min={0}
              step={500}
              value={spend}
              className="tnum h-8 w-32 py-1 text-[13px]"
              onChange={(e) => setSpend(Number(e.target.value))}
              onBlur={() => void run(channel, spend)}
            />
          </div>
        </div>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(channel, spend)}>
          Resolve
        </Button>
      </div>

      {result && (
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.chainId ? 'ok' : 'danger'} dot>
              {result.chainId ? 'Matched' : 'No match'}
            </Badge>
            <span className="text-[13.5px] font-semibold text-ink">{result.chainName}</span>
            {result.chainId && (
              <span className="tnum text-xs text-ink-faint">
                {result.steps.length} step{result.steps.length === 1 ? '' : 's'} · {result.totalSlaHours}h
                total SLA
              </span>
            )}
          </div>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-muted">{result.reason}</p>
          {result.steps.length > 0 && <StepFlow steps={result.steps} className="mt-3" />}
        </div>
      )}
    </Card>
  )
}

function currencySymbol(currency: string): string {
  return currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '£'
}
