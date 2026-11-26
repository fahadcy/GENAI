import 'server-only'
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { usageCounters, videoGenerations, type VideoGeneration } from '@/lib/db/schema'
import { recordAudit } from '@/lib/workflow/audit'
import { totalCentsPerSecond, videoModel } from './catalogue'
import { checkVideoMedia, MediaCheckError, probeVideo } from './media'
import { money } from './policy'
import { videoProviders, VideoProviderError, type ProviderJob } from './providers'
import { putVideo, videoStorageKey } from './storage'
import type { VideoAspect } from './catalogue'
import type { VideoReferenceAsset } from './prompt'

/**
 * The video half of the worker tick.
 *
 * Generation is minutes of waiting, so it belongs beside `publishDue` on the
 * existing worker rather than in a request handler, and it reuses the same
 * shape: state lives on the row, retries use exponential backoff with a cap,
 * and anything terminal lands in `dead_letter` — visible, explicable, never
 * silently dropped.
 *
 * Two operational notes that belong in the runbook as much as here.
 *
 * A video job holds the worker for minutes rather than milliseconds, so
 * `VIDEO_MAX_JOBS_PER_TICK` caps how many are advanced per workspace per tick.
 * Without that cap one enthusiastic afternoon in the studio starves the
 * publish queue and scheduled email quietly stops going out — a failure that
 * looks nothing like its cause.
 *
 * And the worker has no health check. A crash-looping worker looks perfectly
 * fine from the app. The dead-letter count is the place this shows up, which
 * is why it is on the weekly list.
 */

const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 15_000

export type VideoOutcome = {
  id: string
  status: 'advanced' | 'ready' | 'retrying' | 'dead_letter' | 'waiting'
  message: string
}

const IN_FLIGHT = ['queued', 'submitted', 'generating', 'storing'] as const
type InFlight = (typeof IN_FLIGHT)[number]

export async function processVideoJobs(workspaceId: string, limit = 10): Promise<VideoOutcome[]> {
  const now = new Date()
  const due = await db
    .select()
    .from(videoGenerations)
    .where(
      and(
        eq(videoGenerations.workspaceId, workspaceId),
        inArray(videoGenerations.status, IN_FLIGHT as unknown as InFlight[]),
        or(isNull(videoGenerations.nextRetryAt), lte(videoGenerations.nextRetryAt, now)),
      ),
    )
    .orderBy(asc(videoGenerations.createdAt))
    .limit(limit)

  const outcomes: VideoOutcome[] = []
  for (const row of due) {
    outcomes.push(await advance(row))
  }
  return outcomes
}

/** Advance one generation by exactly one step. Idempotent and safe to re-run. */
export async function advanceVideo(workspaceId: string, id: string): Promise<VideoOutcome> {
  const [row] = await db
    .select()
    .from(videoGenerations)
    .where(and(eq(videoGenerations.workspaceId, workspaceId), eq(videoGenerations.id, id)))
    .limit(1)
  if (!row) return { id, status: 'waiting', message: 'Not found.' }
  return advance(row)
}

async function advance(row: VideoGeneration): Promise<VideoOutcome> {
  try {
    switch (row.status) {
      case 'queued':
        return await submit(row)
      case 'submitted':
      case 'generating':
        return await poll(row)
      case 'storing':
        return await store(row)
      default:
        return { id: row.id, status: 'waiting', message: `Nothing to do in status "${row.status}".` }
    }
  } catch (e) {
    return fail(row, e)
  }
}

/* ---------------------------------------------------------------- submit */

async function submit(row: VideoGeneration): Promise<VideoOutcome> {
  const registry = videoProviders()
  const { job, provider, failedOverFrom } = await registry.submitWithFailover(
    {
      model: row.model,
      prompt: row.prompt,
      negativePrompt: row.negativePrompt,
      aspectRatio: row.aspectRatio as VideoAspect,
      resolution: row.resolution as '480p' | '720p' | '1080p' | '4k',
      durationSeconds: row.durationSeconds,
      audio: row.audio,
      seed: row.seed,
      referenceAssets: (row.referenceAssets ?? []) as VideoReferenceAsset[],
      idempotencyKey: row.id,
    },
    row.providerId as 'google' | 'runway' | 'simulator',
  )

  await db
    .update(videoGenerations)
    .set({
      status: 'submitted',
      providerJobId: job.providerJobId,
      providerId: provider.id,
      simulated: provider.id === 'simulator',
      failedOverFrom,
      lastError: null,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(videoGenerations.id, row.id))

  await recordAudit({
    workspaceId: row.workspaceId,
    actorType: 'system',
    action: 'video.submitted',
    subjectType: 'video',
    subjectId: row.id,
    summary: failedOverFrom
      ? `"${row.title}" sent to ${provider.id} after ${failedOverFrom} was unreachable.`
      : `"${row.title}" sent to ${provider.id}.`,
    payload: { providerJobId: job.providerJobId, provider: provider.id, failedOverFrom, model: row.model },
  })

  return { id: row.id, status: 'advanced', message: `Submitted to ${provider.id}.` }
}

/* ------------------------------------------------------------------ poll */

async function poll(row: VideoGeneration): Promise<VideoOutcome> {
  if (!row.providerJobId) {
    return fail(row, new VideoProviderError('bad_state', 'Submitted with no provider job id.'))
  }

  const provider = videoProviders().get(row.providerId as 'google' | 'runway' | 'simulator')
  const job: ProviderJob = await provider.poll(row.providerJobId)

  if (job.status === 'queued' || job.status === 'running') {
    await db
      .update(videoGenerations)
      .set({ status: 'generating', updatedAt: new Date() })
      .where(eq(videoGenerations.id, row.id))
    return { id: row.id, status: 'waiting', message: `Generating${job.progress !== null ? ` (${job.progress}%)` : ''}.` }
  }

  if (job.status === 'failed') {
    const err = job.error
    return fail(
      row,
      new VideoProviderError(err?.code ?? 'failed', err?.message ?? 'The provider failed the job without explanation.', {
        retryable: err?.retryable ?? false,
        contentRefusal: err?.contentRefusal ?? false,
        providerMessage: err?.message ?? null,
      }),
    )
  }

  // Succeeded upstream. Store it promptly — the provider's copy is on a clock.
  await db
    .update(videoGenerations)
    .set({ status: 'storing', providerExpiresAt: job.expiresAt, updatedAt: new Date() })
    .where(eq(videoGenerations.id, row.id))

  return { id: row.id, status: 'advanced', message: 'Generated; storing.' }
}

/* ----------------------------------------------------------------- store */

async function store(row: VideoGeneration): Promise<VideoOutcome> {
  if (!row.providerJobId) {
    return fail(row, new VideoProviderError('bad_state', 'Storing with no provider job id.'))
  }

  const provider = videoProviders().get(row.providerId as 'google' | 'runway' | 'simulator')
  const job = await provider.poll(row.providerJobId)
  const download = await provider.download(job)

  const key = videoStorageKey(row.workspaceId, row.id, row.version)
  const stored = await putVideo(key, download.bytes)

  const facts = await probeVideo(download.bytes)
  const check = checkVideoMedia({
    facts,
    channel: row.channel,
    requestedAspect: row.aspectRatio as VideoAspect,
    requestedDurationSeconds: row.durationSeconds,
    requestedAudio: row.audio,
  })

  const spec = videoModel(row.model)
  const provenance = spec
    ? {
        watermark: spec.provenance.watermark,
        visibleWatermark: spec.provenance.visibleWatermark,
        note: spec.provenance.note,
      }
    : null

  /* Bill for what actually arrived, not what was ordered. A provider that
     returns 5.4 seconds when 6 were requested should not be invoiced for 6. */
  const perSecond = spec ? totalCentsPerSecond(spec, facts.hasAudio, row.resolution as '480p' | '720p' | '1080p' | '4k') : 0
  const actualCostCents = Math.ceil(perSecond * facts.durationSeconds)

  await db
    .update(videoGenerations)
    .set({
      status: 'ready',
      stage: 'review',
      storageKey: stored.key,
      checksumSha256: stored.checksumSha256,
      mediaFacts: facts,
      mediaCheck: check,
      provenance,
      actualCostCents,
      lastError: null,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(videoGenerations.id, row.id))

  /* Metering: real spend only. Simulated runs are shadow-billed in the studio
     so the ceiling path is exercised, but they never reach an invoice. */
  if (!row.simulated) {
    const period = new Date().toISOString().slice(0, 7)
    await db
      .insert(usageCounters)
      .values({ workspaceId: row.workspaceId, period, metric: 'video_cents', value: actualCostCents })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.period, usageCounters.metric],
        set: { value: sql`${usageCounters.value} + ${actualCostCents}` },
      })
    await db
      .insert(usageCounters)
      .values({ workspaceId: row.workspaceId, period, metric: 'video_clips', value: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.period, usageCounters.metric],
        set: { value: sql`${usageCounters.value} + 1` },
      })
  }

  await recordAudit({
    workspaceId: row.workspaceId,
    actorType: 'system',
    action: 'video.generated',
    subjectType: 'video',
    subjectId: row.id,
    summary: `"${row.title}" generated: ${facts.width}×${facts.height}, ${facts.durationSeconds.toFixed(1)}s, ${facts.hasAudio ? 'with audio' : 'silent'}${row.simulated ? ' (simulated)' : `, ${money(actualCostCents)}`}. Mechanical checks ${check.passed ? 'passed' : 'failed'}.`,
    payload: {
      provider: row.providerId,
      model: row.model,
      storageKey: stored.key,
      checksum: stored.checksumSha256,
      actualCostCents,
      estimatedCostCents: row.estimatedCostCents,
      durationSeconds: facts.durationSeconds,
      width: facts.width,
      height: facts.height,
      hasAudio: facts.hasAudio,
      watermark: provenance?.watermark ?? null,
      mediaCheckPassed: check.passed,
      simulated: row.simulated,
    },
  })

  return {
    id: row.id,
    status: 'ready',
    message: check.passed
      ? 'Ready for review.'
      : `Ready, but ${check.findings.filter((f) => f.severity === 'high').length} delivery check(s) failed.`,
  }
}

/* --------------------------------------------------------------- failure */

/**
 * One failure path for all three steps, so the retry policy lives in one place
 * and a dead-lettered row always looks the same.
 *
 * A content refusal is terminal however retryable it looks: the prompt has to
 * change and a person needs to see why. An expired asset is terminal too — the
 * bytes are gone from the provider and no amount of retrying brings them back.
 */
async function fail(row: VideoGeneration, error: unknown): Promise<VideoOutcome> {
  const isProviderError = error instanceof VideoProviderError
  const mediaProblem = error instanceof MediaCheckError
  const message = error instanceof Error ? error.message : String(error)
  const providerMessage = isProviderError ? error.providerMessage : null
  const contentRefusal = isProviderError && error.contentRefusal
  const expired = isProviderError && error.code === 'asset_expired'

  const retryable = isProviderError && error.retryable && !contentRefusal && !expired && !mediaProblem
  const attempts = row.attempts + 1
  const terminal = !retryable || attempts >= MAX_ATTEMPTS

  if (terminal) {
    await db
      .update(videoGenerations)
      .set({
        status: 'dead_letter',
        attempts,
        lastError: providerMessage ? `${message} — ${providerMessage}` : message,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(videoGenerations.id, row.id))

    await recordAudit({
      workspaceId: row.workspaceId,
      actorType: 'system',
      action: 'video.failed',
      subjectType: 'video',
      subjectId: row.id,
      summary: contentRefusal
        ? `"${row.title}" was refused by the provider on content grounds. The prompt has to change — retrying it would be refused again.`
        : `Generating "${row.title}" failed permanently after ${attempts} attempt(s): ${message}`,
      payload: { error: message, providerMessage, attempts, contentRefusal, retryable, expired },
    })

    return { id: row.id, status: 'dead_letter', message }
  }

  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, 10 * 60_000)
  await db
    .update(videoGenerations)
    .set({
      // Back to the step it was on, so the retry repeats the failed step only.
      attempts,
      lastError: message,
      nextRetryAt: new Date(Date.now() + backoff),
      updatedAt: new Date(),
    })
    .where(eq(videoGenerations.id, row.id))

  await recordAudit({
    workspaceId: row.workspaceId,
    actorType: 'system',
    action: 'video.retrying',
    subjectType: 'video',
    subjectId: row.id,
    summary: `Attempt ${attempts} for "${row.title}" failed: ${message} Retrying in ${Math.round(backoff / 1000)}s.`,
    payload: { error: message, attempts, backoffMs: backoff },
  })

  return { id: row.id, status: 'retrying', message: `${message} Retry in ${Math.round(backoff / 1000)}s.` }
}

/* ---------------------------------------------------------------- health */

export async function videoQueueHealth(workspaceId: string) {
  const [row] = await db
    .select({
      inFlight: sql<number>`count(*) filter (where ${videoGenerations.status} in ('queued','submitted','generating','storing'))::int`,
      ready: sql<number>`count(*) filter (where ${videoGenerations.status} = 'ready')::int`,
      deadLetter: sql<number>`count(*) filter (where ${videoGenerations.status} = 'dead_letter')::int`,
      failedChecks: sql<number>`count(*) filter (where ${videoGenerations.status} = 'ready' and (${videoGenerations.mediaCheck} -> 'passed')::boolean is false)::int`,
    })
    .from(videoGenerations)
    .where(eq(videoGenerations.workspaceId, workspaceId))
  return row ?? { inFlight: 0, ready: 0, deadLetter: 0, failedChecks: 0 }
}

/** Operator action: push a dead-lettered generation back into the queue. */
export async function replayVideo(workspaceId: string, actorId: string, id: string): Promise<VideoOutcome> {
  await db
    .update(videoGenerations)
    .set({ status: 'queued', attempts: 0, lastError: null, nextRetryAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(videoGenerations.workspaceId, workspaceId),
        eq(videoGenerations.id, id),
        eq(videoGenerations.status, 'dead_letter'),
      ),
    )
  await recordAudit({
    workspaceId,
    actorId,
    action: 'video.replayed',
    subjectType: 'video',
    subjectId: id,
    summary: 'Dead-lettered video generation replayed.',
    payload: {},
  })
  return advanceVideo(workspaceId, id)
}
