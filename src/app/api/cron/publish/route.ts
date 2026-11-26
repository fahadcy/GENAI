import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { workspaces } from '@/lib/db/schema'
import { publishDue } from '@/lib/scheduler/publish'
import { processVideoJobs } from '@/lib/video/jobs'
import { refreshRecommendations } from '@/lib/copilot/analyze'

/**
 * Scheduled publish tick, for platforms whose scheduler calls an HTTP endpoint
 * (Vercel Cron, Cloud Scheduler, GitHub Actions). The same work is available as
 * a long-running process via `npm run worker -- --loop`.
 *
 * Authentication: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. If no
 * secret is configured the route refuses in production rather than running
 * unauthenticated.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const started = Date.now()
  const spaces = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
  const results: Record<
    string,
    { published: number; retrying: number; deadLetter: number; recommendations: number; videoAdvanced: number }
  > = {}

  for (const ws of spaces) {
    try {
      const videoOutcomes = await processVideoJobs(ws.id, Number(process.env.VIDEO_MAX_JOBS_PER_TICK ?? 6))
      const outcomes = await publishDue(ws.id, 50)
      const recommendations = await refreshRecommendations(ws.id)
      results[ws.name] = {
        published: outcomes.filter((o) => o.status === 'published').length,
        retrying: outcomes.filter((o) => o.status === 'retrying').length,
        deadLetter: outcomes.filter((o) => o.status === 'dead_letter').length,
        recommendations,
        videoAdvanced: videoOutcomes.length,
      }
    } catch (e) {
      // A failure in one tenant must not abort the tick for the rest.
      results[ws.name] = { published: 0, retrying: 0, deadLetter: 0, recommendations: -1, videoAdvanced: 0 }
      console.error(`cron: workspace ${ws.id} failed`, e)
    }
  }

  return NextResponse.json({ ok: true, ms: Date.now() - started, workspaces: results })
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // Convenience in development; never in production.
    return process.env.NODE_ENV !== 'production'
  }
  const header = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
