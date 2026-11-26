import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { BriefComposer } from '@/components/studio/brief-composer'
import { studioOptions } from '../queries'
import { hasLiveModel } from '@/lib/env'
import { competitorContextSummary } from '@/lib/competitors/service'

export const metadata: Metadata = { title: 'New brief' }

export default async function NewBriefPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const auth = await requireAuth()
  if (!can(auth.role, 'asset:create')) redirect('/studio')

  const params = await searchParams
  const [options, notifications, competitorContext] = await Promise.all([
    studioOptions(auth.workspace.id),
    listNotifications(auth.workspace.id, auth.user.id),
    competitorContextSummary(auth.workspace.id),
  ])

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="New brief"
        description="One instruction in; channel-shaped, pre-scored variants out"
        notifications={notifications}
      />
      <PageBody width="wide">
        <BriefComposer
          campaigns={options.campaigns}
          profile={
            options.profile
              ? {
                  name: options.profile.name,
                  voice: options.profile.voice,
                  tone: options.profile.tone,
                  bannedTerms: options.profile.bannedTerms,
                  passThreshold: options.profile.passThreshold,
                  doList: options.profile.doList,
                  dontList: options.profile.dontList,
                }
              : null
          }
          defaultCampaignId={params.campaign ?? null}
          liveModel={hasLiveModel()}
          competitorContext={competitorContext}
          initial={{
            title: params.title?.slice(0, 200),
            objective: params.objective?.slice(0, 1000),
            keyMessages: params.messages?.split('|').map((m) => m.trim()).filter(Boolean).slice(0, 8),
            channels: params.channels?.split(',').filter(Boolean),
          }}
        />
      </PageBody>
    </>
  )
}
