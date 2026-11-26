import 'server-only'
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { contacts } from '@/lib/db/schema'

/**
 * Reading the contact list.
 *
 * Every query in here starts from the workspace id and narrows from there.
 * That is not defensive style for its own sake: a contact list is the most
 * sensitive thing in the product, and a missing filter would be a cross-tenant
 * disclosure rather than a display bug.
 */

const PAGE_SIZE = 50

export type ContactRow = {
  id: string
  email: string
  name: string | null
  phone: string | null
  company: string | null
  jobTitle: string | null
  country: string | null
  lifecycleStage: string
  consent: { email: boolean; sms: boolean; push: boolean; ads: boolean; capturedAt: string; basis: string }
  suppressed: boolean
  suppressionReason: string | null
  createdAt: string
}

export type ContactFilter = 'all' | 'emailable' | 'textable' | 'suppressed' | 'no_consent'

export async function listContacts(
  workspaceId: string,
  opts: { q?: string; filter?: ContactFilter; page?: number } = {},
): Promise<{ rows: ContactRow[]; total: number; page: number; pages: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const where = and(eq(contacts.workspaceId, workspaceId), searchClause(opts.q), filterClause(opts.filter))

  const [[count], rows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where),
    db
      .select({
        id: contacts.id,
        email: contacts.email,
        name: contacts.name,
        phone: contacts.phone,
        company: contacts.company,
        jobTitle: contacts.jobTitle,
        country: contacts.country,
        lifecycleStage: contacts.lifecycleStage,
        consent: contacts.consent,
        suppressed: contacts.suppressed,
        suppressionReason: contacts.suppressionReason,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(where)
      // Newest first: after an import, the rows someone wants to check are the
      // ones that just arrived.
      .orderBy(desc(contacts.createdAt), asc(contacts.email))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ])

  const total = count?.n ?? 0
  return {
    rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  }
}

function searchClause(q?: string): SQL | undefined {
  const term = q?.trim()
  if (!term) return undefined
  // Drizzle parameterises this, so a name containing % or _ searches for those
  // characters literally rather than becoming a wildcard.
  const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`
  return or(
    ilike(contacts.email, like),
    ilike(contacts.name, like),
    ilike(contacts.company, like),
    ilike(contacts.phone, like),
  )
}

function filterClause(filter?: ContactFilter): SQL | undefined {
  switch (filter) {
    case 'emailable':
      return and(eq(contacts.suppressed, false), sql`(${contacts.consent} ->> 'email')::boolean is true`)
    case 'textable':
      return and(
        eq(contacts.suppressed, false),
        sql`(${contacts.consent} ->> 'sms')::boolean is true`,
        sql`${contacts.phone} is not null and ${contacts.phone} <> ''`,
      )
    case 'suppressed':
      return eq(contacts.suppressed, true)
    case 'no_consent':
      return and(
        eq(contacts.suppressed, false),
        sql`(${contacts.consent} ->> 'email')::boolean is not true`,
        sql`(${contacts.consent} ->> 'sms')::boolean is not true`,
      )
    default:
      return undefined
  }
}

/**
 * The headline numbers.
 *
 * "How many contacts" is the wrong question — the number that matters is how
 * many can actually be reached, because that is what a campaign will go to.
 * They are shown side by side so the gap is visible.
 */
export async function contactStats(workspaceId: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      emailable: sql<number>`count(*) filter (where ${contacts.suppressed} = false and (${contacts.consent} ->> 'email')::boolean is true)::int`,
      textable: sql<number>`count(*) filter (where ${contacts.suppressed} = false and (${contacts.consent} ->> 'sms')::boolean is true and ${contacts.phone} is not null and ${contacts.phone} <> '')::int`,
      suppressed: sql<number>`count(*) filter (where ${contacts.suppressed})::int`,
      noConsent: sql<number>`count(*) filter (where ${contacts.suppressed} = false and (${contacts.consent} ->> 'email')::boolean is not true and (${contacts.consent} ->> 'sms')::boolean is not true)::int`,
      withPhone: sql<number>`count(*) filter (where ${contacts.phone} is not null and ${contacts.phone} <> '')::int`,
    })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId))

  return row ?? { total: 0, emailable: 0, textable: 0, suppressed: 0, noConsent: 0, withPhone: 0 }
}

/** Where the list came from, grouped, so an unexplained bulk import is visible. */
export async function basisBreakdown(workspaceId: string) {
  return db
    .select({
      basis: sql<string>`coalesce(${contacts.consent} ->> 'basis', 'unknown')`,
      n: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId))
    .groupBy(sql`coalesce(${contacts.consent} ->> 'basis', 'unknown')`)
    .orderBy(desc(sql`count(*)`))
}
