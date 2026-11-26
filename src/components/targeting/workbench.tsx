'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Filter, Layers, Lock, Trash2 } from 'lucide-react'
import type { SegmentRuleGroup } from '@/lib/db/schema'
import type { EvaluationResult } from '@/lib/targeting/engine'
import { deleteSegmentAction, saveSegmentAction } from '@/app/actions/targeting'
import { Badge, Button, Card, CardHeader, Field, Input, Textarea } from '@/components/ui/primitives'
import { ConfirmButton, useToast } from '@/components/ui/client'
import { RelativeTime, formatPercent } from '@/components/domain'
import { RuleEditor } from './rule-editor'
import {
  ConsentPanel,
  ReachabilityBreakdown,
  SampleTable,
  SizeHeadline,
  useLiveEvaluation,
  type SampleContact,
} from './evaluation'
import { LookalikeBuilder } from './lookalike'
import { SyncPanel, SyncTargetPicker, type ConnectorStatus } from './sync'
import { countRules, summariseGroup } from './shared'

export type WorkbenchSegment = {
  id: string
  name: string
  description: string | null
  nlQuery: string | null
  rules: SegmentRuleGroup
  sourceType: string
  seedSegmentId: string | null
  seedName: string | null
  similarityThreshold: number
  syncTargets: string[]
  memberCount: number
  /** Size recorded when the segment was last written, for comparison. */
  estimatedSize: number
  lastRefreshedAt: string | null
  createdAt: string
  createdByName: string | null
}

export function SegmentWorkbench({
  segment,
  initialEvaluation,
  lookalikeStats,
  lookalikeSample,
  connectors,
  suppressionReasons,
  workspaceSuppressed,
  canEdit,
}: {
  segment: WorkbenchSegment
  /** Rule segments: sized live from the rules the marketer is editing. */
  initialEvaluation: EvaluationResult | null
  /** Lookalike segments: counted from materialised membership instead. */
  lookalikeStats: {
    matched: number
    reachable: number
    reachability: Record<string, number>
    predictedConversion: number
  } | null
  lookalikeSample: SampleContact[]
  connectors: Record<string, ConnectorStatus>
  suppressionReasons: { reason: string; count: number }[]
  workspaceSuppressed: number
  canEdit: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const isLookalike = segment.sourceType === 'lookalike'

  const [name, setName] = React.useState(segment.name)
  const [description, setDescription] = React.useState(segment.description ?? '')
  const [rules, setRules] = React.useState<SegmentRuleGroup>(segment.rules)
  const [targets, setTargets] = React.useState<string[]>(segment.syncTargets)
  const [saving, setSaving] = React.useState(false)

  const baseline = React.useRef(
    JSON.stringify({ name: segment.name, description: segment.description ?? '', rules: segment.rules, targets: segment.syncTargets }),
  )
  const current = JSON.stringify({ name, description, rules, targets })
  const dirty = current !== baseline.current

  // Lookalike membership is fixed at build time, so there is nothing to size live.
  const live = useLiveEvaluation(rules, isLookalike ? null : initialEvaluation, !isLookalike)

  const stats = isLookalike ? lookalikeStats : live.result
  const sample = isLookalike ? lookalikeSample : (live.result?.sample ?? [])
  const suppressedInSegment = isLookalike ? 0 : (live.result?.suppressed ?? 0)
  const expectedConversions = Math.round((stats?.reachable ?? 0) * (stats?.predictedConversion ?? 0))

  const save = async () => {
    setSaving(true)
    try {
      const res = await saveSegmentAction({
        id: segment.id,
        name: name.trim() || segment.name,
        description: description.trim() || undefined,
        nlQuery: segment.nlQuery ?? undefined,
        rules,
        syncTargets: targets,
      })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Saved and recomputed' : 'Not saved',
        body: res.message,
      })
      if (res.ok) {
        baseline.current = current
        router.refresh()
      }
    } catch {
      toast.push({
        tone: 'danger',
        title: 'Save failed',
        body: 'Membership was not recomputed. The segment is unchanged and your edits are still on screen.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      {/* ------------------------------------------------------ left column */}
      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardHeader
            title={isLookalike ? 'How this audience was built' : 'Rules'}
            description={
              isLookalike
                ? 'Membership was scored once against the seed profile and written down. It does not re-run.'
                : 'Exactly what the segment engine compiles to SQL. Change anything here and the numbers on the right follow.'
            }
            icon={isLookalike ? <Layers className="h-4 w-4" /> : <Filter className="h-4 w-4" />}
            actions={
              !isLookalike && (
                <>
                  {dirty && <Badge tone="warn">Unsaved</Badge>}
                  <Button
                    size="xs"
                    variant={dirty ? 'primary' : 'secondary'}
                    onClick={save}
                    loading={saving}
                    disabled={!canEdit || !dirty || countRules(rules) === 0}
                    title={!canEdit ? 'Your role cannot edit segments' : undefined}
                  >
                    Save and recompute
                  </Button>
                </>
              )
            }
          />

          {isLookalike ? (
            <LookalikeProvenance segment={segment} workspaceSuppressed={workspaceSuppressed} />
          ) : (
            <div className="p-5">
              {segment.nlQuery && (
                <div className="mb-4 rounded-lg border border-line bg-bg-subtle px-3.5 py-2.5">
                  <p className="label">Originally described as</p>
                  <p className="mt-1 text-[13px] italic leading-snug text-ink-muted">
                    “{segment.nlQuery}”
                  </p>
                </div>
              )}
              <RuleEditor group={rules} onChange={setRules} disabled={!canEdit} />
              <p className="mt-3 rounded-lg bg-bg-subtle px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted">
                <span className="label mr-2">Reads as</span>
                {summariseGroup(rules)}
              </p>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Segment details"
            description="Name and destination. Saving re-materialises membership from the current rules."
          />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit || isLookalike} />
            </Field>
            <Field label="Sync targets" hint="Channels this segment is pushed to.">
              <SyncTargetPicker
                value={targets}
                onChange={setTargets}
                connectors={connectors}
                disabled={!canEdit || isLookalike}
              />
            </Field>
            <Field label="Description" className="sm:col-span-2" hint="Why this audience exists, for whoever inherits it.">
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canEdit || isLookalike}
                placeholder="What this audience is for and when to use it."
              />
            </Field>
          </div>
          {isLookalike && (
            <p className="border-t border-line px-5 py-2.5 text-xs leading-relaxed text-ink-faint">
              A lookalike carries no rules, so editing it here would ask the engine to re-materialise
              from an empty rule set. Build a fresh lookalike from the seed instead.
            </p>
          )}
        </Card>

        <SampleTable
          sample={sample}
          total={stats?.reachable ?? 0}
          description={
            isLookalike
              ? `The ${sample.length} closest matches of ${segment.memberCount.toLocaleString('en-GB')} members. Suppressed records were never candidates.`
              : undefined
          }
        />

        <Card className="overflow-hidden">
          <CardHeader title="Provenance" description="Who made this and when it last ran." />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-5 py-4 text-[13px]">
            <dt className="text-ink-faint">Source</dt>
            <dd className="text-ink">{isLookalike ? 'Lookalike expansion' : 'Rule-based'}</dd>
            <dt className="text-ink-faint">Created</dt>
            <dd className="text-ink">
              <RelativeTime date={segment.createdAt} />
              {segment.createdByName ? ` by ${segment.createdByName}` : ''}
            </dd>
            <dt className="text-ink-faint">Last refreshed</dt>
            <dd className="text-ink">
              {segment.lastRefreshedAt ? <RelativeTime date={segment.lastRefreshedAt} /> : 'Never'}
            </dd>
            <dt className="text-ink-faint">Members</dt>
            <dd className="tnum text-ink">{segment.memberCount.toLocaleString('en-GB')}</dd>
          </dl>
          <div className="flex items-center justify-between gap-3 border-t border-line bg-bg-subtle px-5 py-3">
            <p className="text-xs text-ink-faint">Deleting removes membership, not contacts.</p>
            <ConfirmButton
              size="xs"
              variant="ghost"
              className="text-danger-fg hover:bg-danger-bg"
              disabled={!canEdit}
              title="Delete this segment"
              description={`"${segment.name}" and its ${segment.memberCount.toLocaleString('en-GB')} memberships will be removed. The contacts themselves are untouched.`}
              confirmLabel="Delete segment"
              onConfirm={async () => {
                try {
                  const res = await deleteSegmentAction(segment.id)
                  toast.push({
                    tone: res.ok ? 'ok' : 'danger',
                    title: res.ok ? 'Segment deleted' : 'Not deleted',
                    body: res.message,
                  })
                  if (res.ok) router.push('/targeting')
                } catch {
                  toast.push({
                    tone: 'danger',
                    title: 'Delete failed',
                    body: 'The segment is still there. Anything referencing it may be blocking removal.',
                  })
                }
              }}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </ConfirmButton>
          </div>
        </Card>
      </div>

      {/* ----------------------------------------------------- right column */}
      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardHeader
            title="Before you launch"
            description={
              isLookalike
                ? 'Counted from materialised membership.'
                : live.pending
                  ? 'Recounting against the contact table…'
                  : 'Counted against the contact table just now.'
            }
          />
          <SizeHeadline
            result={
              stats
                ? {
                    matched: stats.matched,
                    reachable: stats.reachable,
                    predictedConversion: stats.predictedConversion,
                  }
                : null
            }
            pending={!isLookalike && live.pending}
          />
          {live.error && !isLookalike && (
            <p className="border-t border-line px-5 py-2.5 text-xs text-danger-fg">{live.error}</p>
          )}
          <div className="border-t border-line">
            <p className="label px-5 pb-1 pt-3">Reachability by channel</p>
            <ReachabilityBreakdown
              reachability={stats?.reachability ?? {}}
              matched={stats?.matched ?? 0}
              syncTargets={targets}
            />
            <p className="border-t border-line px-5 py-2.5 text-xs leading-relaxed text-ink-faint">
              Predicted conversion blends average engagement with existing-customer density, then
              regresses large segments toward the mean. At {formatPercent(stats?.predictedConversion ?? 0, 2)} on{' '}
              {(stats?.reachable ?? 0).toLocaleString('en-GB')} reachable contacts that is roughly{' '}
              {expectedConversions.toLocaleString('en-GB')} conversion{expectedConversions === 1 ? '' : 's'}.
            </p>
          </div>
        </Card>

        <ConsentPanel
          matched={stats?.matched ?? 0}
          suppressed={suppressedInSegment}
          reachability={stats?.reachability ?? {}}
          suppressionReasons={suppressionReasons}
        />

        <SyncPanel
          segmentId={segment.id}
          syncTargets={segment.syncTargets}
          connectors={connectors}
          memberCount={segment.memberCount}
          canSync={canEdit}
        />

        {!isLookalike && (
          <LookalikeBuilder
            seedSegmentId={segment.id}
            seedName={segment.name}
            seedSize={segment.memberCount}
            canCreate={canEdit}
          />
        )}

      </div>
    </div>
  )
}

function LookalikeProvenance({
  segment,
  workspaceSuppressed,
}: {
  segment: WorkbenchSegment
  workspaceSuppressed: number
}) {
  // A build that failed part-way leaves the segment row behind with an estimate
  // but no membership. Saying so is better than showing a silent set of zeros.
  const membershipMissing = segment.memberCount === 0 && segment.estimatedSize > 0

  return (
    <div className="space-y-4 p-5">
      {membershipMissing && (
        <div className="flex items-start gap-2.5 rounded-lg border border-danger-fg/25 bg-danger-bg px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <div>
            <p className="text-[13px] font-semibold text-ink">Membership was never written</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              The build recorded an estimate of {segment.estimatedSize.toLocaleString('en-GB')}{' '}
              contacts but stored no members, so this segment cannot be sampled or synced. Delete it
              and rebuild from the seed.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">Lookalike</Badge>
        <span className="text-[13px] text-ink-muted">
          seeded from{' '}
          {segment.seedSegmentId ? (
            <Link href={`/targeting/${segment.seedSegmentId}`} className="font-medium text-brand-600 hover:underline">
              {segment.seedName ?? 'the seed segment'}
            </Link>
          ) : (
            <span className="font-medium text-ink">a segment that has since been deleted</span>
          )}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-bg-subtle p-4 sm:grid-cols-4">
        <div>
          <dt className="label">Threshold</dt>
          <dd className="tnum mt-1 text-lg font-semibold text-ink">
            {segment.similarityThreshold.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt className="label">Company size</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">30%</dd>
        </div>
        <div>
          <dt className="label">Engagement</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">30%</dd>
        </div>
        <div>
          <dt className="label">Industry / geo</dt>
          <dd className="mt-1 text-lg font-semibold text-ink">25% / 15%</dd>
        </div>
      </dl>

      <p className="text-[13px] leading-relaxed text-ink-muted">
        Every non-suppressed contact outside the seed was scored against the seed&apos;s average
        company size, engagement, modal industry and modal country. Everyone at or above{' '}
        {segment.similarityThreshold.toFixed(2)} was admitted.
      </p>

      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-faint">
        <Lock className="mt-px h-3 w-3 shrink-0" />
        The {workspaceSuppressed.toLocaleString('en-GB')} suppressed contacts in this workspace were
        removed from the candidate pool before scoring — they could not have been admitted at any
        threshold.
      </p>
    </div>
  )
}
