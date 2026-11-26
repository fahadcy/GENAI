import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { workspaces } from '@/lib/db/schema'
import { budgetTick } from '@/lib/budget/service'

/**
 * Budget refresh: pull Aurea's own spend, sync connected cards (at most every
 * six hours each), and reconcile every live plan. New high-severity
 * discrepancies notify owners and marketing ops.
 *
 * Its own route and time budget, like competitor rescans, so a slow bank API
 * cannot hold up the publish tick. Same authentication: `Authorization:
 * Bearer $CRON_SECRET`.
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
      const r = await budgetTick(ws.id)
      results[ws.name] = r.reconciled ? `reconciled, ${r.cards} card(s) synced` : 'no live plan'
    } catch (e) {
      results[ws.name] = 'failed'
      console.error(`cron: budget tick for ${ws.id} failed`, e)
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
