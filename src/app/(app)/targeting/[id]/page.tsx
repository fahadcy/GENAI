import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { evaluateRules, type EvaluationResult } from '@/lib/targeting/engine'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { RefreshButton } from '@/components/targeting/sync'
import { SegmentWorkbench } from '@/components/targeting/workbench'
import {
  audienceOverview,
  connectorStatuses,
  getSegment,
  memberEvaluation,
  memberSample,
  suppressionReasons,
} from '../queries'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const auth = await requireAuth()
  const segment = await getSegment(auth.workspace.id, id)
  return { title: segment ? segment.name : 'Segment' }
}

export default async function SegmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const segment = await getSegment(wsId, id)
  if (!segment) notFound()

  const isLookalike = segment.sourceType === 'lookalike'

  // A lookalike carries no rules, so evaluating them would match the whole
  // workspace. Its numbers come from materialised membership instead.
  const [evaluation, lookalikeStats, lookalikeSample, reasons, connectors, overview, notifications] =
    await Promise.all([
      isLookalike
        ? Promise.resolve<EvaluationResult | null>(null)
        : evaluateRules(wsId, segment.rules),
      isLookalike ? memberEvaluation(segment.id) : Promise.resolve(null),
      isLookalike ? memberSample(segment.id, 8) : Promise.resolve([]),
      suppressionReasons(wsId),
      connectorStatuses(wsId),
      audienceOverview(wsId),
      listNotifications(wsId, auth.user.id),
    ])

  const canEdit = can(auth.role, 'segment:edit') && can(auth.role, 'segment:create')

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={segment.name}
        description={
          isLookalike
            ? `Lookalike at ${segment.similarityThreshold.toFixed(2)} similarity · ${segment.memberCount.toLocaleString('en-GB')} members`
            : `Rule-based segment · ${segment.memberCount.toLocaleString('en-GB')} members materialised`
        }
        notifications={notifications}
        actions={!isLookalike && <RefreshButton segmentId={segment.id} size="sm" variant="secondary" />}
      />

      <PageBody>
        <Link
          href="/targeting"
          className="mb-4 inline-flex items-center gap-1 text-[13px] text-ink-muted transition-colors hover:text-ink"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          All segments
        </Link>

        <SegmentWorkbench
          segment={{
            id: segment.id,
            name: segment.name,
            description: segment.description,
            nlQuery: segment.nlQuery,
            rules: segment.rules,
            sourceType: segment.sourceType,
            seedSegmentId: segment.seedSegmentId,
            seedName: segment.seedName,
            similarityThreshold: segment.similarityThreshold,
            syncTargets: segment.syncTargets,
            memberCount: segment.memberCount,
            estimatedSize: segment.estimatedSize,
            lastRefreshedAt: segment.lastRefreshedAt?.toISOString() ?? null,
            createdAt: segment.createdAt.toISOString(),
            createdByName: segment.createdByName,
          }}
          initialEvaluation={evaluation}
          lookalikeStats={lookalikeStats}
          lookalikeSample={lookalikeSample}
          connectors={connectors}
          suppressionReasons={reasons}
          workspaceSuppressed={overview.suppressed}
          canEdit={canEdit}
        />
      </PageBody>
    </>
  )
}
