'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Eye, Sparkles, Wand2, X } from 'lucide-react'
import type { SegmentRuleGroup } from '@/lib/db/schema'
import type { EvaluationResult } from '@/lib/targeting/engine'
import { interpretAudienceAction, saveSegmentAction } from '@/app/actions/targeting'
import { Badge, Button, Card, CardHeader, Field, Input, Textarea } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { RuleEditor } from './rule-editor'
import { ConsentPanel, ReachabilityBreakdown, SizeHeadline, useLiveEvaluation } from './evaluation'
import { SyncTargetPicker, type ConnectorStatus } from './sync'
import { countRules, summariseGroup } from './shared'

const EXAMPLES = [
  'Heads of marketing at SaaS companies with more than 200 employees',
  'UK customers who have been active in the last 14 days',
  'Trial users in Germany or France who have gone quiet',
]

type Interpretation = {
  name: string
  rules: SegmentRuleGroup
  interpretation: string
  unmapped: string[]
  evaluation: EvaluationResult
  simulated: boolean
}

/**
 * AT-1 front door. The sentence is only ever an input method: the moment the
 * model answers, the marketer is looking at the rules it produced and can
 * change any of them before anything is saved.
 */
export function AudienceBuilder({
  connectors,
  suppressionReasons,
  canCreate,
}: {
  connectors: Record<string, ConnectorStatus>
  suppressionReasons: { reason: string; count: number }[]
  canCreate: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [query, setQuery] = React.useState('')
  const [interpreting, setInterpreting] = React.useState(false)
  const [draft, setDraft] = React.useState<Interpretation | null>(null)
  const [rules, setRules] = React.useState<SegmentRuleGroup>({ combinator: 'and', rules: [] })
  const [name, setName] = React.useState('')
  const [targets, setTargets] = React.useState<string[]>(['email'])
  const [saving, setSaving] = React.useState(false)

  const { result, pending, error } = useLiveEvaluation(rules, draft?.evaluation ?? null)

  const interpret = async () => {
    if (!query.trim()) return
    setInterpreting(true)
    try {
      const res = await interpretAudienceAction(query)
      if (!res.ok || !res.data) {
        toast.push({ tone: 'danger', title: 'Could not read that', body: res.message })
        return
      }
      setDraft(res.data)
      setRules(res.data.rules)
      setName(res.data.name)
      toast.push({
        tone: 'ok',
        title: `${res.data.evaluation.matched.toLocaleString('en-GB')} contacts match`,
        body: 'Check the rules below — they are what will actually run.',
      })
    } catch {
      toast.push({
        tone: 'danger',
        title: 'The interpreter did not respond',
        body: 'Nothing was saved. Try again, or build the rules by hand after saving an empty draft.',
      })
    } finally {
      setInterpreting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await saveSegmentAction({
        name: name.trim() || 'Untitled segment',
        nlQuery: query,
        rules,
        syncTargets: targets,
      })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Segment saved' : 'Not saved',
        body: res.message,
      })
      if (res.ok && res.data) router.push(`/targeting/${res.data.id}`)
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Save failed',
        body: 'The segment was not written. Your rules are still here — try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  const discard = () => {
    setDraft(null)
    setRules({ combinator: 'and', rules: [] })
    setName('')
    setQuery('')
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Describe your audience"
        description="Write it the way you would brief a colleague. GenAI turns it into rules you can inspect and edit before anything is saved."
        icon={<Sparkles className="h-4 w-4 text-brand-600" />}
        actions={draft?.simulated ? <Badge tone="neutral">Simulated model</Badge> : undefined}
      />

      <div className="space-y-3 p-5">
        <Textarea
          rows={2}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void interpret()
          }}
          placeholder="Senior marketers at UK SaaS companies with more than 100 employees who have been active in the last 30 days"
          className="text-[13.5px]"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-ink-faint">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setQuery(ex)}
                className="rounded-md border border-line bg-bg-subtle px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                {ex.length > 46 ? `${ex.slice(0, 46)}…` : ex}
              </button>
            ))}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={interpret}
            loading={interpreting}
            disabled={!query.trim()}
          >
            {!interpreting && <Wand2 className="h-3.5 w-3.5" />}
            Interpret
          </Button>
        </div>
      </div>

      {draft && (
        <div className="animate-fade-up border-t border-line">
          {/* What the model claims it understood, stated before the rules so the
              two can be compared line by line. */}
          <div className="flex items-start gap-3 bg-brand-50/60 px-5 py-3.5">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <div className="min-w-0 flex-1">
              <p className="label">Understood as</p>
              <p className="mt-1 text-[13.5px] leading-snug text-ink">{draft.interpretation}</p>
              {draft.unmapped.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-warn-fg">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  Not expressed as rules: {draft.unmapped.join('; ')}. Add a condition below if it
                  matters.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={discard}
              className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
              aria-label="Discard this draft"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="border-line p-5 lg:border-r">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">
                  {countRules(rules)} rule{countRules(rules) === 1 ? '' : 's'}
                </h3>
                <p className="truncate text-xs text-ink-faint" title={summariseGroup(rules)}>
                  {summariseGroup(rules)}
                </p>
              </div>
              <RuleEditor group={rules} onChange={setRules} />

              <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                <Field label="Segment name" required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this audience" />
                </Field>
                <Field label="Sync targets" hint="Where this segment is pushed once saved.">
                  <SyncTargetPicker value={targets} onChange={setTargets} connectors={connectors} />
                </Field>
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                {!canCreate && (
                  <p className="mr-auto text-xs text-ink-faint">
                    Your role can size audiences but not save them.
                  </p>
                )}
                <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
                  Discard
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  loading={saving}
                  disabled={!canCreate || !name.trim() || countRules(rules) === 0}
                >
                  Save segment
                </Button>
              </div>
            </div>

            <div className="bg-bg-subtle">
              <SizeHeadline result={result} pending={pending} compact />
              {error && <p className="px-4 pb-2 text-xs text-danger-fg">{error}</p>}
              {result && (
                <>
                  <div className="border-t border-line">
                    <p className="label px-5 pb-1 pt-3">Reachability by channel</p>
                    <ReachabilityBreakdown
                      reachability={result.reachability}
                      matched={result.matched}
                      syncTargets={targets}
                    />
                  </div>
                  <div className="border-t border-line p-4">
                    <ConsentPanel
                      matched={result.matched}
                      suppressed={result.suppressed}
                      reachability={result.reachability}
                      suppressionReasons={suppressionReasons}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
