import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { VideoDetail } from '@/components/video/detail'
import { loadVideo, videoPlaybackUrl } from '@/lib/video/service'
import { videoBlockReason } from '@/lib/workflow/approvals'
import { defaultBrandProfile, openRequestFor } from '../queries'

export const metadata: Metadata = { title: 'Clip' }

export default async function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params

  const video = await loadVideo(auth.workspace.id, id)
  if (!video) notFound()

  const [profile, request, blockReason, notifications] = await Promise.all([
    defaultBrandProfile(auth.workspace.id),
    openRequestFor(auth.workspace.id, id),
    // Non-throwing: the submit button explains itself rather than failing on click.
    video.status === 'ready' ? Promise.resolve(null) : videoBlockReason(auth.workspace.id, id),
    listNotifications(auth.workspace.id, auth.user.id),
  ])

  /**
   * A reviewer may only decide when the clip is genuinely with them. The
   * engine re-checks this on the server; this only governs what is rendered,
   * so a disabled button is never the only thing standing between someone and
   * an approval they should not be making.
   */
  const canDecide = Boolean(request) && can(auth.role, 'approval:decide')

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title={video.title}
        description={`v${video.version} · ${video.aspectRatio} · ${video.durationSeconds}s${video.simulated ? ' · simulated' : ''}`}
        notifications={notifications}
      />

      <PageBody>
        <Link
          href="/studio/video"
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Video Studio
        </Link>

        <VideoDetail
          video={{
            id: video.id,
            title: video.title,
            status: video.status,
            version: video.version,
            simulated: video.simulated,
            model: video.model,
            providerId: video.providerId,
            failedOverFrom: video.failedOverFrom,
            prompt: video.prompt,
            script: video.script,
            referenceAssets: video.referenceAssets ?? [],
            channel: video.channel,
            aspectRatio: video.aspectRatio,
            resolution: video.resolution,
            durationSeconds: video.durationSeconds,
            audio: video.audio,
            estimatedCostCents: video.estimatedCostCents,
            actualCostCents: video.actualCostCents,
            scoreDetail: video.scoreDetail,
            mediaFacts: video.mediaFacts,
            mediaCheck: video.mediaCheck,
            provenance: video.provenance,
            lastError: video.lastError,
            playbackUrl: videoPlaybackUrl(video),
          }}
          profile={profile ? { tone: profile.tone, passThreshold: profile.passThreshold } : null}
          request={request ? { id: request.id, chainName: request.chainName, stepName: request.stepName } : null}
          viewer={{
            canSubmit: can(auth.role, 'asset:submit'),
            canDecide,
            canGenerate: can(auth.role, 'video:create'),
          }}
          blockReason={video.status === 'ready' ? null : blockReason}
        />
      </PageBody>
    </>
  )
}
