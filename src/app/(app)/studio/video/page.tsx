import type { Metadata } from 'next'
import { Clapperboard, TriangleAlert } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody, RequirementNote, SectionHeading } from '@/components/shell/page'
import { Badge, Card, EmptyState, StatTile } from '@/components/ui/primitives'
import { VideoComposer } from '@/components/video/composer'
import { VideoGallery } from '@/components/video/gallery'
import { channelLabel } from '@/components/domain'
import { hasLiveVideo, videoMissing } from '@/lib/env'
import { storageWarning } from '@/lib/video/storage'
import { composerOptions, listVideos, toGalleryItem } from './queries'

export const metadata: Metadata = { title: 'Video Studio' }

/**
 * The video surface.
 *
 * The same governed loop as everything else, with one difference the page has
 * to keep in front of people at all times: generating costs money per attempt.
 * So the budget is a headline stat rather than a setting buried in billing,
 * and the composer shows the price before it shows the button.
 */
const CHANNELS = [
  { value: 'instagram', label: channelLabel('instagram') },
  { value: 'facebook', label: channelLabel('facebook') },
  { value: 'linkedin', label: channelLabel('linkedin') },
  { value: 'x', label: channelLabel('x') },
  { value: 'meta_ads', label: channelLabel('meta_ads') },
  { value: 'google_ads', label: channelLabel('google_ads') },
  { value: 'web', label: channelLabel('web') },
]

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export default async function VideoStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const auth = await requireAuth()
  const params = await searchParams

  const [rows, options, notifications] = await Promise.all([
    listVideos(auth.workspace.id),
    composerOptions(auth.workspace.id),
    listNotifications(auth.workspace.id, auth.user.id),
  ])

  const canGenerate = can(auth.role, 'video:create')
  const live = hasLiveVideo()
  const missing = videoMissing()
  const storeWarning = storageWarning()
  const items = rows.map(toGalleryItem)

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Video Studio"
        description="Briefs become short clips — scored before they cost anything, reviewed before they go anywhere"
        notifications={notifications}
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Left this month"
            value={money(options.remainingCents)}
            hint={`of ${money(options.ceilingCents)} on the ${options.plan} plan`}
          />
          <StatTile label="Spent this month" value={money(options.spentCents)} hint="Simulated runs are never billed" />
          <StatTile label="Clips" value={String(items.length)} hint="Newest first" />
        </div>

        {!live && (
          <RequirementNote>
            Running on the simulator: every clip is real, playable video with a burned-in label, generated
            without a vendor account and never billed. The whole loop — budget, guardrails, review, approval,
            audit — works exactly as it will with a provider key.
            {missing.length > 0 && (
              <>
                {' '}
                To go live, set <code className="font-mono text-2xs">{missing.join(', ')}</code> and redeploy.
              </>
            )}
          </RequirementNote>
        )}

        {storeWarning && (
          <Card className="flex items-start gap-2 border-danger-fg/30 p-4 text-[13px] text-danger-fg">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{storeWarning}</span>
          </Card>
        )}

        <section className="space-y-3">
          <SectionHeading
            title="New clip"
            description="Pick a model, write the brief. The price is shown before you commit, and the figure you confirm is the figure the server checks."
          />
          {canGenerate ? (
            options.ceilingCents === 0 ? (
              <Card className="p-6 text-center text-[13px] text-ink-muted">
                Video generation is not included on the {options.plan} plan. An owner or marketing ops can set a
                monthly video budget to enable it.
              </Card>
            ) : (
              <Card className="p-5">
                <VideoComposer
                  channels={CHANNELS}
                  models={options.models}
                  defaultModel={options.defaultModel}
                  maxVariants={options.maxVariants}
                  initial={{
                    title: params.title?.slice(0, 120),
                    prompt: params.prompt?.slice(0, 1500),
                    script: params.script?.slice(0, 1500),
                    channel: params.channel,
                  }}
                />
              </Card>
            )
          ) : (
            <Card className="p-6 text-center text-[13px] text-ink-muted">
              Your role can review video but not generate it — generating spends from the workspace budget.
            </Card>
          )}
        </section>

        <section className="space-y-3">
          <SectionHeading title="Clips" description="Everything generated in this workspace" />
          {items.length === 0 ? (
            <EmptyState
              icon={<Clapperboard className="h-5 w-5" />}
              title="No clips yet"
              description="Write a brief above. The first one costs nothing on the simulator."
            />
          ) : (
            <VideoGallery initial={items} />
          )}
        </section>
      </PageBody>
    </>
  )
}
