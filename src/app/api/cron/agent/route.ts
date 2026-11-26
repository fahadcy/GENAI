import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { workspaces } from '@/lib/db/schema'
import { agentTick } from '@/lib/agent/service'

/**
 * Growth agent schedule. Called every 20 minutes in UK working hours; each
 * routine runs at most once a day at its own time (agentTick decides), so
 * calling it more often changes nothing. Same authentication as the other
 * cron routes: `Authorization: Bearer $CRON_SECRET`.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BUDGET_MS = 240_000

export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  const started = Date.now()
  const spaces = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
  const results: Record<string, string> = {}
  for (const ws of spaces) {
    if (Date.now() - started > BUDGET_MS) break
    try {
      const r = await agentTick(ws.id)
      if (r.length) results[ws.name] = r.join(', ')
    } catch (e) {
      results[ws.name] = 'failed'
      console.error(`cron: agent tick for ${ws.id} failed`, e)
    }
  }
  return NextResponse.json({ ok: true, ms: Date.now() - started, results })
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
