import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { workspaces } from '@/lib/db/schema'
import { refreshDue } from '@/lib/competitors/service'

/**
 * Competitor rescans, on their own schedule and their own time budget.
 *
 * Kept out of the publish tick on purpose: a scan reads websites and paid
 * APIs and asks a model, so one slow competitor could otherwise use up the
 * publish route's minute and stop scheduled email going out. Here, work stops
 * starting once the budget is spent and picks up on the next run.
 *
 * Same authentication as the publish route: `Authorization: Bearer $CRON_SECRET`.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BUDGET_MS = 240_000

export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const started = Date.now()
  const spaces = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
  const results: Record<string, number> = {}
  for (const ws of spaces) {
    if (Date.now() - started > BUDGET_MS) break
    try {
      results[ws.name] = await refreshDue(ws.id, 2)
    } catch (e) {
      results[ws.name] = -1
      console.error(`cron: competitor rescan for ${ws.id} failed`, e)
    }
  }
  return NextResponse.json({ ok: true, ms: Date.now() - started, rescanned: results })
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  const header = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
