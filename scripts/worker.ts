/**
 * Publish worker.
 *
 * Walks every workspace, publishes anything due, retries anything in backoff,
 * and refreshes the copilot's recommendations. Designed to be idempotent and
 * safe to run concurrently: the publisher re-checks the approval gate per item
 * and the retry state lives on the row itself.
 *
 * Run it however suits the deployment:
 *   - Vercel Cron hitting /api/cron/publish (see vercel.json)
 *   - a container running `npm run worker -- --loop`
 *   - a Kubernetes CronJob running `npm run worker`
 */
import '../src/lib/load-env'

import { db } from '../src/lib/db'
import { workspaces } from '../src/lib/db/schema'
import { publishDue, queueHealth } from '../src/lib/scheduler/publish'
import { processVideoJobs, videoQueueHealth } from '../src/lib/video/jobs'
import { refreshRecommendations } from '../src/lib/copilot/analyze'
import { refreshDue as refreshCompetitors } from '../src/lib/competitors/service'
import { budgetTick } from '../src/lib/budget/service'
import { agentTick } from '../src/lib/agent/service'

const LOOP = process.argv.includes('--loop')
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000)
const ANALYSE_EVERY = 15 // ticks between copilot re-analysis

async function tick(cycle: number) {
  const spaces = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
  const stamp = new Date().toISOString()

  for (const ws of spaces) {
    try {
      /* Video first, and capped. A generation holds the worker for minutes
         rather than milliseconds, so an uncapped queue would starve publishing
         and scheduled email would quietly stop going out — a failure that
         looks nothing like its cause. */
      const videoOutcomes = await processVideoJobs(ws.id, Number(process.env.VIDEO_MAX_JOBS_PER_TICK ?? 6))
      if (videoOutcomes.length > 0) {
        const ready = videoOutcomes.filter((o) => o.status === 'ready').length
        const working = videoOutcomes.filter((o) => o.status === 'advanced' || o.status === 'waiting').length
        const videoDead = videoOutcomes.filter((o) => o.status === 'dead_letter').length
        console.log(`${stamp} [${ws.name}] video ready=${ready} in_progress=${working} dead_letter=${videoDead}`)
        for (const o of videoOutcomes.filter((x) => x.status === 'dead_letter' || x.status === 'retrying')) {
          console.log(`  video ${o.status}: ${o.message}`)
        }
      }

      const outcomes = await publishDue(ws.id, 50)
      if (outcomes.length > 0) {
        const published = outcomes.filter((o) => o.status === 'published').length
        const retrying = outcomes.filter((o) => o.status === 'retrying').length
        const dead = outcomes.filter((o) => o.status === 'dead_letter').length
        console.log(
          `${stamp} [${ws.name}] published=${published} retrying=${retrying} dead_letter=${dead}`,
        )
        for (const o of outcomes.filter((x) => x.status !== 'published')) {
          console.log(`  ${o.status}: ${o.message}`)
        }
      }

      if (cycle % ANALYSE_EVERY === 0) {
        /* Competitors due a rescan, two per workspace per pass. A scan reads
           websites and paid APIs, so it is paced rather than done in bulk. */
        const rescanned = await refreshCompetitors(ws.id, 2).catch((e) => {
          console.error(`${stamp} [${ws.name}] competitor rescan failed:`, e instanceof Error ? e.message : e)
          return 0
        })
        if (rescanned > 0) console.log(`${stamp} [${ws.name}] competitors rescanned=${rescanned}`)
        /* Budget: Aurea's own spend, connected cards (each at most every six
           hours) and the three-way reconciliation of the live plan. */
        const budget = await budgetTick(ws.id).catch((e) => {
          console.error(`${stamp} [${ws.name}] budget tick failed:`, e instanceof Error ? e.message : e)
          return null
        })
        if (budget?.reconciled) console.log(`${stamp} [${ws.name}] budget reconciled cards_synced=${budget.cards}`)
        /* Growth agent: the daily brief, lead finding and due emails, each at
           most once a day at its UK time. Skips quietly when not connected. */
        const agent = await agentTick(ws.id).catch((e) => {
          console.error(`${stamp} [${ws.name}] agent tick failed:`, e instanceof Error ? e.message : e)
          return [] as string[]
        })
        if (agent.length) console.log(`${stamp} [${ws.name}] agent ${agent.join(' ')}`)
        const n = await refreshRecommendations(ws.id)
        const health = await queueHealth(ws.id)
        const video = await videoQueueHealth(ws.id)
        console.log(
          `${stamp} [${ws.name}] copilot=${n} scheduled=${health.scheduled} dead_letter=${health.deadLetter} video_in_flight=${video.inFlight} video_dead_letter=${video.deadLetter}`,
        )
      }
    } catch (e) {
      // One workspace failing must never stop the others.
      console.error(`${stamp} [${ws.name}] worker error:`, e instanceof Error ? e.message : e)
    }
  }
}

async function main() {
  if (!LOOP) {
    await tick(0)
    return
  }

  console.log(`Worker started. Interval ${INTERVAL_MS}ms. Ctrl-C to stop.`)
  let cycle = 0
  let stopping = false
  process.on('SIGINT', () => {
    console.log('\nStopping after the current tick…')
    stopping = true
  })
  process.on('SIGTERM', () => {
    stopping = true
  })

  while (!stopping) {
    await tick(cycle++)
    if (stopping) break
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

main()
  .then(async () => {
    await db.$client.end()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error(e)
    await db.$client.end().catch(() => {})
    process.exit(1)
  })
