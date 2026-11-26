import 'server-only'
import { createHash } from 'node:crypto'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { auditEvents } from '@/lib/db/schema'

/**
 * Immutable audit trail (PRD AP-3: "every state change is logged and cannot be
 * edited after the fact").
 *
 * Each row stores sha256(prevHash ‖ canonical(event)). Editing or deleting any
 * historical row breaks every hash after it, and `verifyChain` will name the
 * exact sequence number where the break occurs. That turns "trust us" into
 * something a compliance reviewer can check.
 *
 * Appends take a per-workspace transaction-scoped advisory lock so concurrent
 * writers cannot interleave and fork the chain.
 */

export type AuditInput = {
  workspaceId: string
  actorId?: string | null
  actorType?: 'user' | 'system' | 'copilot'
  action: string
  subjectType: string
  subjectId?: string | null
  summary: string
  payload?: Record<string, unknown>
}

/** Deterministic serialisation — key order must not change the hash. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export function hashEvent(prevHash: string | null, body: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${prevHash ?? 'GENESIS'}|${canonical(body)}`)
    .digest('hex')
}

export async function recordAudit(input: AuditInput): Promise<{ hash: string; seq: number }> {
  return db.transaction(async (tx) => {
    // Serialise appends per workspace without locking the whole table.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.workspaceId}))`)

    const [prev] = await tx
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, input.workspaceId))
      .orderBy(desc(auditEvents.seq))
      .limit(1)

    const createdAt = new Date()
    const body = {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? 'user',
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      summary: input.summary,
      payload: input.payload ?? {},
      createdAt: createdAt.toISOString(),
    }
    const hash = hashEvent(prev?.hash ?? null, body)

    const [row] = await tx
      .insert(auditEvents)
      .values({
        workspaceId: input.workspaceId,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'user',
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        summary: input.summary,
        payload: input.payload ?? {},
        prevHash: prev?.hash ?? null,
        hash,
        createdAt,
      })
      .returning({ seq: auditEvents.seq })

    return { hash, seq: row.seq }
  })
}

export type ChainVerification = {
  ok: boolean
  checked: number
  brokenAtSeq: number | null
  reason: string | null
  firstEventAt: Date | null
  lastEventAt: Date | null
}

/** Walk the whole workspace chain and confirm every link. */
export async function verifyChain(workspaceId: string): Promise<ChainVerification> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(asc(auditEvents.seq))

  let prevHash: string | null = null
  for (const row of rows) {
    if ((row.prevHash ?? null) !== prevHash) {
      return {
        ok: false,
        checked: rows.length,
        brokenAtSeq: row.seq,
        reason: 'Previous-hash pointer does not match the preceding event. A row was inserted, removed or reordered.',
        firstEventAt: rows[0]?.createdAt ?? null,
        lastEventAt: rows.at(-1)?.createdAt ?? null,
      }
    }
    const expected = hashEvent(prevHash, {
      workspaceId: row.workspaceId,
      actorId: row.actorId,
      actorType: row.actorType,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      summary: row.summary,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    })
    if (expected !== row.hash) {
      return {
        ok: false,
        checked: rows.length,
        brokenAtSeq: row.seq,
        reason: 'Recomputed hash does not match the stored hash. This event was modified after it was written.',
        firstEventAt: rows[0]?.createdAt ?? null,
        lastEventAt: rows.at(-1)?.createdAt ?? null,
      }
    }
    prevHash = row.hash
  }

  return {
    ok: true,
    checked: rows.length,
    brokenAtSeq: null,
    reason: null,
    firstEventAt: rows[0]?.createdAt ?? null,
    lastEventAt: rows.at(-1)?.createdAt ?? null,
  }
}

/** CSV export for compliance (AP-3). */
export async function exportAuditCsv(workspaceId: string): Promise<string> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(asc(auditEvents.seq))

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = 'seq,timestamp,actor_type,actor_id,action,subject_type,subject_id,summary,payload,hash,prev_hash'
  const lines = rows.map((r) =>
    [
      r.seq,
      r.createdAt.toISOString(),
      r.actorType,
      r.actorId ?? '',
      r.action,
      r.subjectType,
      r.subjectId ?? '',
      r.summary,
      JSON.stringify(r.payload),
      r.hash,
      r.prevHash ?? '',
    ]
      .map(esc)
      .join(','),
  )
  return [header, ...lines].join('\n')
}

/**
 * Labels live in ./audit-labels.ts — a plain module with no `server-only`
 * import — so client components can render them without a round trip.
 * Re-exported here for callers that already import from this module.
 */
export { AUDIT_LABELS, auditLabel } from './audit-labels'
