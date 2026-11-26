'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { contacts, segmentMembers } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { recordAudit } from '@/lib/workflow/audit'
import { parseCsv, readRows, guessColumns, surnameColumn, isEmail, type ColumnMap } from '@/lib/contacts/csv'
import { consentFor, type ConsentBasis, BASIS_BY_VALUE } from '@/lib/contacts/consent'
import { toE164 } from '@/lib/channels/clicksend'
import type { ActionResult } from './content'

/**
 * The contact list.
 *
 * Two rules run through all of this. Every query is filtered by workspace, so
 * one client's list can never be read or written from another. And consent is
 * never inferred from the act of adding somebody — it is always an explicit
 * answer to "why are you allowed to contact them", recorded with a timestamp.
 */

const BASIS_VALUES = ['opt_in', 'soft_opt_in', 'b2b_legitimate_interest', 'unknown'] as const

const contactSchema = z.object({
  email: z.string().trim().toLowerCase().refine(isEmail, 'That is not a valid email address.'),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(32).optional(),
  company: z.string().trim().max(200).optional(),
  jobTitle: z.string().trim().max(200).optional(),
  country: z.string().trim().length(2).optional().or(z.literal('')),
  industry: z.string().trim().max(120).optional(),
  lifecycleStage: z.enum(['lead', 'mql', 'sql', 'customer', 'churned', 'evangelist']).default('lead'),
  basis: z.enum(BASIS_VALUES),
})

export type ContactInput = z.input<typeof contactSchema>

/* ------------------------------------------------------------ one at a time */

export async function saveContactAction(
  input: ContactInput & { id?: string },
): Promise<ActionResult<{ id: string }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'contact:manage')
  } catch {
    return { ok: false, message: 'Your role cannot edit the contact list.' }
  }

  const parsed = contactSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the details and try again.' }
  }
  const c = parsed.data

  // A number that cannot be dialled is refused here rather than at send time,
  // where it would fail silently and cost money.
  if (c.phone && !toE164(c.phone)) {
    return { ok: false, message: 'That mobile number cannot be dialled. A UK mobile looks like 07700 900123.' }
  }

  const values = {
    workspaceId: auth.workspace.id,
    email: c.email,
    name: c.name || null,
    phone: c.phone || null,
    company: c.company || null,
    jobTitle: c.jobTitle || null,
    country: c.country ? c.country.toUpperCase() : null,
    industry: c.industry || null,
    lifecycleStage: c.lifecycleStage,
    consent: consentFor(c.basis as ConsentBasis),
  }

  if (input.id) {
    const [existing] = await db
      .select({ id: contacts.id, suppressed: contacts.suppressed, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))
      .limit(1)
    if (!existing) return { ok: false, message: 'That contact no longer exists.' }

    /* Suppression outranks anything typed on this form. Someone who has
       unsubscribed stays unsubscribed even if their record is edited and the
       basis re-declared — otherwise an opt-out could be undone by accident. */
    const consent = existing.suppressed
      ? { ...values.consent, email: false, sms: false, ads: false }
      : values.consent

    await db
      .update(contacts)
      .set({ ...values, consent })
      .where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))

    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      action: 'contact.updated',
      subjectType: 'contact',
      subjectId: input.id,
      summary: `Contact ${c.email} updated.`,
      payload: { basis: c.basis, suppressed: existing.suppressed },
    })
    revalidatePath('/contacts')
    return {
      ok: true,
      message: existing.suppressed
        ? 'Saved. They stay unsubscribed — an opt-out is not undone by editing the record.'
        : 'Saved.',
      data: { id: input.id },
    }
  }

  /* The uniqueness rule is on lower(email), which is an expression index —
     Drizzle's typed `onConflictDoUpdate` only takes plain columns, so the
     upsert is written out. Doing it as one statement rather than
     select-then-insert is what stops two people adding the same address at
     the same moment from producing an error instead of a contact. */
  const [row] = await db.execute<{ id: string }>(sql`
    insert into ${contacts}
      (workspace_id, email, name, phone, company, job_title, country, industry, lifecycle_stage, consent)
    values (
      ${values.workspaceId}, ${values.email}, ${values.name}, ${values.phone}, ${values.company},
      ${values.jobTitle}, ${values.country}, ${values.industry}, ${values.lifecycleStage},
      ${JSON.stringify(values.consent)}::jsonb
    )
    on conflict (workspace_id, lower(email)) do update set
      name = excluded.name,
      phone = excluded.phone,
      company = excluded.company,
      job_title = excluded.job_title,
      country = excluded.country,
      industry = excluded.industry,
      lifecycle_stage = excluded.lifecycle_stage,
      -- An existing opt-out survives being re-added.
      consent = case when ${contacts}.suppressed then ${contacts}.consent else excluded.consent end
    returning id
  `)

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'contact.created',
    subjectType: 'contact',
    subjectId: row.id,
    summary: `Contact ${c.email} added (${BASIS_BY_VALUE.get(c.basis as ConsentBasis)?.label ?? c.basis}).`,
    payload: { basis: c.basis },
  })
  revalidatePath('/contacts')
  return { ok: true, message: `${c.email} added.`, data: { id: row.id } }
}

/* ------------------------------------------------------------------ import */

export type ImportSummary = {
  created: number
  updated: number
  skipped: number
  problems: { line: number; email: string; reason: string }[]
}

export async function importContactsAction(input: {
  csv: string
  basis: ConsentBasis
  columns?: ColumnMap
}): Promise<ActionResult<ImportSummary>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'contact:manage')
  } catch {
    return { ok: false, message: 'Your role cannot import contacts.' }
  }
  if (!BASIS_VALUES.includes(input.basis)) {
    return { ok: false, message: 'Say where this list came from before importing it.' }
  }
  if (input.csv.length > 8_000_000) {
    return { ok: false, message: 'That file is too large to import in one go. Split it into a few smaller files.' }
  }

  const table = parseCsv(input.csv)
  const map = input.columns ?? guessColumns(table.headers)
  const preview = readRows(table, map, { surnameAt: surnameColumn(table.headers) })

  if (preview.contacts.length === 0) {
    return {
      ok: false,
      message:
        preview.problems[0]?.reason ??
        'Nothing in that file could be imported. Check it has a header row with an email column.',
      data: { created: 0, updated: 0, skipped: preview.problems.length, problems: preview.problems.slice(0, 50) },
    }
  }

  const consent = consentFor(input.basis)

  /* Which of these we already hold, asked once rather than per row: the
     difference between "added" and "updated" is what tells someone whether
     their list actually grew. */
  const emails = preview.contacts.map((c) => c.email)
  const existing = new Set(
    (
      await db
        .select({ email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, auth.workspace.id), inArray(sql`lower(${contacts.email})`, emails)))
    ).map((r) => r.email.toLowerCase()),
  )

  let written = 0
  const CHUNK = 500
  for (let i = 0; i < preview.contacts.length; i += CHUNK) {
    const chunk = preview.contacts.slice(i, i + CHUNK)
    const consentJson = JSON.stringify(consent)
    const rows = chunk.map(
      (c) => sql`(
        ${auth.workspace.id}::uuid, ${c.email}, ${c.name}, ${c.phone}, ${c.company},
        ${c.jobTitle}, ${c.country}, ${c.industry}, ${c.lifecycleStage}, ${consentJson}::jsonb
      )`,
    )

    /* `coalesce(excluded.x, existing)` rather than a straight overwrite: a
       spreadsheet with a blank Company column should not wipe the company
       already on file. An import adds what it knows; it does not erase. */
    await db.execute(sql`
      insert into ${contacts}
        (workspace_id, email, name, phone, company, job_title, country, industry, lifecycle_stage, consent)
      values ${sql.join(rows, sql`, `)}
      on conflict (workspace_id, lower(email)) do update set
        name = coalesce(excluded.name, ${contacts}.name),
        phone = coalesce(excluded.phone, ${contacts}.phone),
        company = coalesce(excluded.company, ${contacts}.company),
        job_title = coalesce(excluded.job_title, ${contacts}.job_title),
        country = coalesce(excluded.country, ${contacts}.country),
        industry = coalesce(excluded.industry, ${contacts}.industry),
        lifecycle_stage = excluded.lifecycle_stage,
        -- An import must never re-subscribe somebody who has opted out. Their
        -- consent is left exactly as it is; everyone else takes the basis
        -- declared for this import.
        consent = case when ${contacts}.suppressed then ${contacts}.consent else excluded.consent end
    `)
    written += chunk.length
  }

  const created = preview.contacts.filter((c) => !existing.has(c.email)).length
  const summary: ImportSummary = {
    created,
    updated: written - created,
    skipped: preview.problems.length,
    problems: preview.problems.slice(0, 50),
  }

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'contact.imported',
    subjectType: 'contact',
    subjectId: 'import',
    summary: `Imported ${written.toLocaleString('en-GB')} contacts (${created} new) on the basis "${BASIS_BY_VALUE.get(input.basis)?.label ?? input.basis}". ${preview.problems.length} rows skipped.`,
    payload: {
      basis: input.basis,
      created,
      updated: summary.updated,
      skipped: preview.problems.length,
      duplicatesInFile: preview.duplicatesInFile,
    },
  })

  revalidatePath('/contacts')
  return {
    ok: true,
    message: `${created.toLocaleString('en-GB')} added, ${summary.updated.toLocaleString('en-GB')} updated${preview.problems.length ? `, ${preview.problems.length} skipped` : ''}.`,
    data: summary,
  }
}

/* ---------------------------------------------------------- suppression */

export async function setSuppressedAction(input: {
  id: string
  suppressed: boolean
  reason?: string
}): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'contact:manage')
  } catch {
    return { ok: false, message: 'Your role cannot change the contact list.' }
  }

  const [contact] = await db
    .select({ email: contacts.email, consent: contacts.consent })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))
    .limit(1)
  if (!contact) return { ok: false, message: 'That contact no longer exists.' }

  await db
    .update(contacts)
    .set({
      suppressed: input.suppressed,
      suppressionReason: input.suppressed ? (input.reason?.slice(0, 200) ?? 'Suppressed manually') : null,
      // Re-subscribing does not restore consent: somebody has to say why they
      // are allowed to contact them again.
      consent: input.suppressed
        ? { ...contact.consent, email: false, sms: false, ads: false }
        : contact.consent,
    })
    .where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: input.suppressed ? 'contact.suppressed' : 'contact.unsuppressed',
    subjectType: 'contact',
    subjectId: input.id,
    summary: input.suppressed
      ? `${contact.email} suppressed: ${input.reason ?? 'no reason given'}.`
      : `${contact.email} taken off the suppression list.`,
    payload: { reason: input.reason },
  })

  revalidatePath('/contacts')
  return {
    ok: true,
    message: input.suppressed
      ? `${contact.email} will not be contacted again.`
      : `${contact.email} is off the suppression list. Set their consent before sending anything.`,
  }
}

/* -------------------------------------------------------------- deletion */

export async function deleteContactAction(input: { id: string }): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'contact:manage')
  } catch {
    return { ok: false, message: 'Your role cannot delete contacts.' }
  }

  const [contact] = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))
    .limit(1)
  if (!contact) return { ok: false, message: 'That contact no longer exists.' }

  await db.delete(segmentMembers).where(eq(segmentMembers.contactId, input.id))
  await db.delete(contacts).where(and(eq(contacts.workspaceId, auth.workspace.id), eq(contacts.id, input.id)))

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'contact.deleted',
    subjectType: 'contact',
    subjectId: input.id,
    summary: `${contact.email} erased at their request or on review.`,
    payload: {},
  })

  revalidatePath('/contacts')
  return {
    ok: true,
    message: `${contact.email} erased. If they might be re-imported later, suppressing is safer than deleting — a deleted contact can be added back by the next import.`,
  }
}
