import type { Metadata } from 'next'
import { AlertOctagon, CalendarClock, CheckCircle2, RefreshCw, Zap } from 'lucide-react'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { listNotifications } from '@/lib/notifications'
import { queueHealth } from '@/lib/scheduler/publish'
import { Topbar } from '@/components/shell/topbar'
import { PageBody } from '@/components/shell/page'
import { StatTile } from '@/components/ui/primitives'
import { SchedulerBoard } from '@/components/scheduler/board'
import { RunPublisherButton } from '@/components/scheduler/run-publisher'
import { dayKeyIn } from '@/components/scheduler/time'
import type {
  AttentionView,
  BlackoutView,
  CandidateView,
  ItemView,
  SegmentOption,
} from '@/components/scheduler/types'
import {
  activeChannels,
  blackouts,
  calendarItems,
  capPressure,
  needsAttention,
  scheduleCandidates,
  sendTimeSummary,
  targetableSegments,
  upcomingBlackouts,
} from './queries'

export const metadata: Metadata = { title: 'Scheduler' }

export default async function SchedulerPage() {
  const auth = await requireAuth()
  const wsId = auth.workspace.id
  const tz = auth.workspace.settings.defaultTimezone
  const weekStartsOn = auth.workspace.settings.weekStartsOn ?? 1
  const todayKey = dayKeyIn(new Date(), tz)

  // The calendar loads a fixed window rather than paging month by month: at this
  // volume one query beats a round trip per arrow press, and it keeps drag,
  // conflict preview and the constraint panels reading from the same snapshot.
  const [year, month] = todayKey.split('-').map(Number)
  const from = new Date(Date.UTC(year, month - 4, 1))
  const to = new Date(Date.UTC(year, month + 6, 1))

  const [queue, items, windows, ahead, candidates, attention, pressure, segments, sendTime, channels, notifications] =
    await Promise.all([
      queueHealth(wsId),
      calendarItems(wsId, from, to),
      blackouts(wsId, from, to),
      upcomingBlackouts(wsId),
      scheduleCandidates(wsId),
      needsAttention(wsId),
      capPressure(wsId),
      targetableSegments(wsId),
      sendTimeSummary(wsId),
      activeChannels(wsId),
      listNotifications(wsId, auth.user.id),
    ])

  const caps = {
    create: can(auth.role, 'schedule:create'),
    edit: can(auth.role, 'schedule:edit'),
    publish: can(auth.role, 'schedule:publish'),
  }

  const itemViews: ItemView[] = items.map((i) => ({
    id: i.id,
    scheduledAt: i.scheduledAt.toISOString(),
    timezone: i.timezone,
    channel: i.channel,
    status: i.status,
    sendTimeSource: i.sendTimeSource,
    predictedLift: i.predictedLift,
    sendTimeRationale: i.sendTimeRationale,
    publishedAt: i.publishedAt?.toISOString() ?? null,
    externalRef: i.externalRef,
    attempts: i.attempts,
    lastError: i.lastError,
    nextRetryAt: i.nextRetryAt?.toISOString() ?? null,
    assetId: i.assetId,
    assetTitle: i.assetTitle,
    assetStatus: i.assetStatus,
    compositeScore: i.compositeScore,
    segmentId: i.segmentId,
    segmentName: i.segmentName,
    // The same figure the publisher will use: consent-filtered reach for this channel.
    reach: i.segmentId ? (i.segmentReachability?.[i.channel] ?? i.segmentReachable ?? null) : null,
    campaignId: i.campaignId,
    campaignName: i.campaignName,
    createdByName: i.createdByName,
    createdByHue: i.createdByHue,
  }))

  const toBlackout = (b: (typeof windows)[number]): BlackoutView => ({
    id: b.id,
    name: b.name,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    channels: b.channels,
    reason: b.reason,
  })

  const candidateViews: CandidateView[] = candidates.map((c) => ({
    ...c,
    updatedAt: c.updatedAt.toISOString(),
  }))

  const attentionViews: AttentionView[] = attention.map((a) => ({
    id: a.id,
    status: a.status,
    channel: a.channel,
    scheduledAt: a.scheduledAt.toISOString(),
    attempts: a.attempts,
    lastError: a.lastError,
    nextRetryAt: a.nextRetryAt?.toISOString() ?? null,
    assetId: a.assetId,
    assetTitle: a.assetTitle,
    campaignName: a.campaignName,
  }))

  const segmentOptions: SegmentOption[] = segments.map((s) => ({
    id: s.id,
    name: s.name,
    reachableSize: s.reachableSize,
    reachability: s.reachability,
  }))

  const readyCount = candidateViews.filter((c) => c.ready).length
  const retrying = queue.failed

  return (
    <>
      <Topbar
        user={auth.user}
        role={auth.role}
        title="Scheduler"
        description={`One calendar for every channel · ${queue.scheduled} slot${queue.scheduled === 1 ? '' : 's'} booked · times shown in ${tz}`}
        notifications={notifications}
        actions={
          caps.publish ? (
            <RunPublisherButton dueNow={queue.dueNow} retrying={retrying} />
          ) : undefined
        }
      />

      <PageBody>
        {/* ------------------------------------------------ SC-4 queue health */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile
            label="Scheduled"
            value={queue.scheduled}
            hint={readyCount > 0 ? `${readyCount} approved and waiting for a slot` : 'Every approved asset is placed'}
            icon={<CalendarClock className="h-4 w-4" />}
          />
          <StatTile
            label="Due now"
            value={queue.dueNow}
            delta={
              queue.dueNow > 0
                ? { value: 'awaiting the worker', direction: 'up', good: false }
                : undefined
            }
            hint={queue.dueNow === 0 ? 'Nothing has passed its send time' : undefined}
            icon={<Zap className="h-4 w-4" />}
          />
          <StatTile
            label="Retrying"
            value={retrying}
            hint={retrying === 0 ? 'No attempt has failed' : 'Backing off exponentially'}
            icon={<RefreshCw className="h-4 w-4" />}
          />
          <StatTile
            label="Dead letter"
            value={queue.deadLetter}
            delta={
              queue.deadLetter > 0
                ? { value: 'replay required', direction: 'up', good: false }
                : undefined
            }
            hint={queue.deadLetter === 0 ? 'Nothing has exhausted its retries' : undefined}
            icon={<AlertOctagon className="h-4 w-4" />}
          />
          <StatTile
            label="Published"
            value={queue.published}
            hint="Confirmed by the channel, with an external reference"
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
        </div>

        <div className="mt-5">
          <SchedulerBoard
            items={itemViews}
            blackoutsInRange={windows.map(toBlackout)}
            upcomingBlackouts={ahead.map(toBlackout)}
            candidates={candidateViews}
            attention={attentionViews}
            capPressure={pressure}
            segments={segmentOptions}
            sendTime={sendTime}
            channels={channels}
            tz={tz}
            weekStartsOn={weekStartsOn}
            todayKey={todayKey}
            caps={caps}
          />
        </div>

        <p className="mt-6 text-xs leading-relaxed text-ink-faint">
          Nothing reaches this calendar without a completed approval, and the gate is re-checked at publish time —
          an asset edited after sign-off is refused rather than sent. Blackout windows, frequency caps and
          same-hour collisions can be overridden by someone with scheduling rights; every override is written to
          the audit trail.
        </p>
      </PageBody>
    </>
  )
}
