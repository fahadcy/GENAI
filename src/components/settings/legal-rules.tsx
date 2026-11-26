'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Gavel, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, CardHeader, EmptyState, Input, Select, Textarea } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { ChannelChip } from '@/components/domain'
import type { LegalRule } from '@/lib/db/schema'
import { deleteLegalRule, saveLegalRule } from '@/app/(app)/settings/actions'
import { ChannelPicker, Toggle } from './bits'

type Draft = {
  id?: string
  name: string
  pattern: string
  severity: 'high' | 'medium' | 'low'
  message: string
  remedy: string
  channels: string[]
  active: boolean
}

const BLANK: Draft = {
  name: '',
  pattern: '',
  severity: 'high',
  message: '',
  remedy: '',
  channels: [],
  active: true,
}

const SEVERITY_TONE = { high: 'danger', medium: 'warn', low: 'neutral' } as const

const SEVERITY_COST = {
  high: 'costs 34 points and blocks submission entirely',
  medium: 'costs 14 points; the reviewer decides',
  low: 'costs 5 points; shown as a suggestion',
}

export function LegalRulesCard({
  rules,
  hits,
  canEdit,
}: {
  rules: LegalRule[]
  /** How many findings each rule has produced across scored assets. */
  hits: Record<string, number>
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = React.useState<Draft | null>(null)
  const [busy, setBusy] = React.useState(false)

  const save = async (draft: Draft) => {
    setBusy(true)
    try {
      const result = await saveLegalRule({ ...draft, remedy: draft.remedy || undefined })
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: LegalRule) => {
    setBusy(true)
    try {
      const result = await deleteLegalRule(rule.id)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setEditing(null)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (rule: LegalRule, active: boolean) => {
    const result = await saveLegalRule({
      id: rule.id,
      name: rule.name,
      pattern: rule.pattern,
      severity: rule.severity as Draft['severity'],
      message: rule.message,
      remedy: rule.remedy ?? undefined,
      channels: rule.channels,
      active,
    })
    toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
    if (result.ok) router.refresh()
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Legal rules"
        description="Pattern checks run on every generated asset before scoring. A high-severity match cannot be submitted for review at all."
        icon={<Gavel className="h-4 w-4" />}
        actions={
          canEdit && (
            <Button size="xs" variant="secondary" onClick={() => setEditing({ ...BLANK })}>
              <Plus className="h-3 w-3" />
              New rule
            </Button>
          )
        }
      />

      {rules.length === 0 ? (
        <EmptyState
          icon={<Gavel className="h-5 w-5" />}
          title="No legal rules yet"
          description="Without rules, compliance scoring only checks banned terms and disclaimers. Most teams start with unqualified guarantees and unsubstantiated superlatives."
          action={
            canEdit && (
              <Button size="sm" variant="primary" onClick={() => setEditing({ ...BLANK })}>
                Add the first rule
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-2 font-semibold">Rule</th>
                <th className="px-3 py-2 font-semibold">Pattern</th>
                <th className="px-3 py-2 font-semibold">Channels</th>
                <th className="px-3 py-2 text-right font-semibold">Caught</th>
                <th className="px-3 py-2 font-semibold">Active</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rules.map((rule) => (
                <tr key={rule.id} className={cn('align-top', !rule.active && 'opacity-55')}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={SEVERITY_TONE[rule.severity as Draft['severity']] ?? 'neutral'}>
                        {rule.severity}
                      </Badge>
                      <span className="text-[13px] font-medium text-ink">{rule.name}</span>
                    </div>
                    <p className="mt-1 max-w-md text-xs leading-snug text-ink-muted">{rule.message}</p>
                  </td>
                  <td className="px-3 py-3">
                    <code className="block max-w-[220px] truncate rounded bg-bg-inset px-1.5 py-0.5 font-mono text-2xs text-ink-muted" title={rule.pattern}>
                      {rule.pattern}
                    </code>
                  </td>
                  <td className="px-3 py-3">
                    {rule.channels.length === 0 ? (
                      <span className="text-xs text-ink-faint">All channels</span>
                    ) : (
                      <div className="flex max-w-[200px] flex-wrap gap-1">
                        {rule.channels.slice(0, 3).map((c) => (
                          <ChannelChip key={c} channel={c} size="sm" showLabel={false} />
                        ))}
                        {rule.channels.length > 3 && (
                          <span className="text-2xs text-ink-faint">+{rule.channels.length - 3}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="tnum px-3 py-3 text-right text-[13px] text-ink">
                    {hits[rule.name] ?? 0}
                  </td>
                  <td className="px-3 py-3">
                    <Toggle
                      checked={rule.active}
                      disabled={!canEdit}
                      label={`${rule.name} active`}
                      onChange={(next) => void toggle(rule, next)}
                    />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            id: rule.id,
                            name: rule.name,
                            pattern: rule.pattern,
                            severity: rule.severity as Draft['severity'],
                            message: rule.message,
                            remedy: rule.remedy ?? '',
                            channels: rule.channels,
                            active: rule.active,
                          })
                        }
                        className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
                        aria-label={`Edit ${rule.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <RuleModal
          draft={editing}
          busy={busy}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={() => void save(editing)}
          onDelete={
            editing.id
              ? () => {
                  const rule = rules.find((r) => r.id === editing.id)
                  if (rule) void remove(rule)
                }
              : undefined
          }
        />
      )}
    </Card>
  )
}

/* --------------------------------------------------------------- modal */

function RuleModal({
  draft,
  busy,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  draft: Draft
  busy: boolean
  onChange: (next: Draft) => void
  onClose: () => void
  onSave: () => void
  onDelete?: () => void
}) {
  const [probe, setProbe] = React.useState(
    'Our platform delivers guaranteed results and is clinically proven to beat HubSpot.',
  )

  // Compiling here rather than on save means a broken pattern is obvious while
  // you are still typing it, and the match preview proves what it catches.
  const compiled = React.useMemo(() => {
    if (!draft.pattern.trim()) return { error: null as string | null, matches: [] as string[] }
    try {
      const re = new RegExp(draft.pattern, 'gi')
      return { error: null, matches: [...probe.matchAll(re)].map((m) => m[0]).slice(0, 6) }
    } catch (e) {
      return { error: (e as Error).message, matches: [] }
    }
  }, [draft.pattern, probe])

  const valid = draft.name.trim().length >= 3 && draft.pattern.trim() && draft.message.trim().length >= 5 && !compiled.error

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={draft.id ? 'Edit legal rule' : 'New legal rule'}
      description="Rules run as case-insensitive expressions against the whole asset — subject, body, call to action and hashtags."
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
            {draft.id ? 'Save rule' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
          <div className="space-y-1.5">
            <label htmlFor="rule-name" className="text-[13px] font-medium text-ink">
              Rule name
            </label>
            <Input
              id="rule-name"
              value={draft.name}
              placeholder="Unqualified guarantee"
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="rule-severity" className="text-[13px] font-medium text-ink">
              Severity
            </label>
            <Select
              id="rule-severity"
              value={draft.severity}
              onChange={(e) => onChange({ ...draft, severity: e.target.value as Draft['severity'] })}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          </div>
        </div>
        <p className="-mt-2 text-2xs text-ink-faint">A {draft.severity}-severity finding {SEVERITY_COST[draft.severity]}.</p>

        <div className="space-y-1.5">
          <label htmlFor="rule-pattern" className="text-[13px] font-medium text-ink">
            Pattern
          </label>
          <Input
            id="rule-pattern"
            value={draft.pattern}
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder="\\b(guarantee[sd]?|risk[- ]free)\\b"
            onChange={(e) => onChange({ ...draft, pattern: e.target.value })}
          />
          {compiled.error ? (
            <p className="text-xs text-danger-fg">Not a valid expression: {compiled.error}</p>
          ) : (
            <p className="text-xs text-ink-faint">
              JavaScript regular expression, applied with the global and case-insensitive flags.
            </p>
          )}
        </div>

        {/* Live match preview — a rule you cannot test is a rule you cannot trust. */}
        <div className="rounded-lg border border-line bg-bg-subtle p-3">
          <p className="label mb-1.5">Test the pattern</p>
          <Textarea
            rows={2}
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            aria-label="Text to test the pattern against"
            className="bg-surface text-[13px]"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {compiled.error ? (
              <span className="text-xs text-ink-faint">Fix the pattern to see matches.</span>
            ) : compiled.matches.length === 0 ? (
              <span className="text-xs text-ink-faint">No match in this text.</span>
            ) : (
              <>
                <span className="text-xs text-ink-muted">Catches:</span>
                {compiled.matches.map((m, i) => (
                  <code
                    key={i}
                    className="rounded bg-danger-bg px-1.5 py-0.5 font-mono text-2xs text-danger-fg"
                  >
                    {m}
                  </code>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="rule-message" className="text-[13px] font-medium text-ink">
            What the reviewer is told
          </label>
          <Textarea
            id="rule-message"
            rows={2}
            value={draft.message}
            placeholder="Absolute guarantees create a contractual claim we cannot support."
            onChange={(e) => onChange({ ...draft, message: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="rule-remedy" className="text-[13px] font-medium text-ink">
            Suggested fix <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <Input
            id="rule-remedy"
            value={draft.remedy}
            placeholder='Replace with a qualified statement, e.g. "in our pilot, teams saw…".'
            onChange={(e) => onChange({ ...draft, remedy: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-[13px] font-medium text-ink">Applies to</p>
          <ChannelPicker
            value={draft.channels}
            onChange={(channels) => onChange({ ...draft, channels })}
            emptyMeans="the rule runs on every channel"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-line px-3.5 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-ink">Active</p>
            <p className="text-xs text-ink-muted">Paused rules stay on file but stop scoring.</p>
          </div>
          <Toggle
            checked={draft.active}
            label="Rule active"
            onChange={(active) => onChange({ ...draft, active })}
          />
        </div>
      </div>
    </Modal>
  )
}
