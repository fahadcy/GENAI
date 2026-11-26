import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { hasLiveModel } from '@/lib/env'

/**
 * Liveness and readiness in one. Container orchestrators and uptime monitors
 * both need to know that the process is up *and* that its database is
 * reachable — a web process that answers 200 while its pool is dead is worse
 * than one that answers 503.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const started = Date.now()
  try {
    await db.execute(sql`select 1`)
    return NextResponse.json({
      status: 'ok',
      database: 'reachable',
      model: hasLiveModel() ? 'live' : 'simulator',
      latencyMs: Date.now() - started,
    })
  } catch (e) {
    return NextResponse.json(
      {
        status: 'degraded',
        database: 'unreachable',
        error: e instanceof Error ? e.message : 'unknown',
      },
      { status: 503 },
    )
  }
}
