'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { brandProfiles, legalRules } from '@/lib/db/schema'
import type { ScoreDetail } from '@/lib/db/schema'
import { getAuth } from '@/lib/auth/session'
import { scoreAsset } from '@/lib/ai/guardrails'

const draftSchema = z.object({
  channel: z.string().min(1),
  subject: z.string().max(400).optional().default(''),
  body: z.string().min(1, 'Write a line or two first.').max(6000),
  cta: z.string().max(200).optional().default(''),
})

export type ScoreResult = { ok: true; detail: ScoreDetail } | { ok: false; error: string }

/**
 * Scores a new user's first draft with the same deterministic guardrail engine
 * the Studio runs on every generated variant. Nothing is written to the
 * database — onboarding shows the check, it does not create an asset behind the
 * user's back.
 */
export async function scoreFirstDraftAction(input: unknown): Promise<ScoreResult> {
  const auth = await getAuth()
  if (!auth) return { ok: false, error: 'Your session has expired. Sign in again to continue.' }

  const parsed = draftSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That draft could not be read.' }
  }

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
    .limit(1)

  if (!profile) {
    return {
      ok: false,
      error: 'This workspace has no default brand profile yet. Create one in Settings → Brand.',
    }
  }

  const rules = await db
    .select()
    .from(legalRules)
    .where(and(eq(legalRules.workspaceId, auth.workspace.id), eq(legalRules.active, true)))

  const detail = scoreAsset({
    body: {
      subject: parsed.data.subject || undefined,
      body: parsed.data.body,
      cta: parsed.data.cta || undefined,
    },
    channel: parsed.data.channel,
    profile,
    legalRules: rules,
  })

  return { ok: true, detail }
}
