'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  assets,
  assetVersions,
  brandProfiles,
  briefs,
  legalRules,
  type AssetBody,
  type Channel,
} from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'
import { assertCan } from '@/lib/auth/rbac'
import { generateVariants } from '@/lib/ai/agents/content'
import { scoreAsset } from '@/lib/ai/guardrails'
import { recordAudit } from '@/lib/workflow/audit'
import { submitAssetForReview, GateError } from '@/lib/workflow/approvals'
import { competitorBrandNames, competitorContextFor } from '@/lib/competitors/service'

/**
 * `data` is carried on the failure branch too, and deliberately so.
 *
 * A failure is often the most information-rich result an action produces — the
 * list of reasons Google would reject a campaign is exactly what the user needs
 * to see, and it arrives with `ok: false`. Narrowing it away meant the caller
 * had to cast the result back to reach the very thing the message referred to.
 */
export type ActionResult<T = undefined> =
  | { ok: true; message: string; data?: T }
  | { ok: false; message: string; data?: T }

const briefSchema = z.object({
  title: z.string().min(3, 'Give the brief a title.'),
  objective: z.string().min(10, 'Describe what this should achieve.'),
  audienceNote: z.string().optional(),
  keyMessages: z.array(z.string()).default([]),
  channels: z.array(z.string()).min(1, 'Pick at least one channel.'),
  callToAction: z.string().optional(),
  mustInclude: z.array(z.string()).default([]),
  mustAvoid: z.array(z.string()).default([]),
  campaignId: z.string().uuid().nullable().optional(),
  variantsPerChannel: z.number().int().min(1).max(4).default(2),
  /** Steer the copy with the latest competitor landscape, when there is one. */
  useCompetitorContext: z.boolean().default(false),
})

/**
 * Brief → generated, scored variants (PRD CS-1 + CS-2 in one step).
 * Scoring happens here rather than on demand, so no asset can reach a human
 * without a brand and legal verdict already attached.
 */
export async function createBriefAndGenerate(
  input: z.input<typeof briefSchema>,
): Promise<ActionResult<{ briefId: string; assetIds: string[]; simulated: boolean }>> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'asset:create')
  } catch {
    return { ok: false, message: 'Your role cannot create content.' }
  }

  const parsed = briefSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join(' ') }
  }
  const data = parsed.data

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
    .limit(1)
  if (!profile) return { ok: false, message: 'No default brand profile. Add one in Settings → Brand.' }

  const competitorContext = data.useCompetitorContext ? await competitorContextFor(auth.workspace.id) : null

  const [brief] = await db
    .insert(briefs)
    .values({
      workspaceId: auth.workspace.id,
      campaignId: data.campaignId ?? null,
      title: data.title,
      objective: data.objective,
      audienceNote: data.audienceNote || null,
      keyMessages: data.keyMessages.filter(Boolean),
      channels: data.channels,
      callToAction: data.callToAction || null,
      mustInclude: data.mustInclude.filter(Boolean),
      mustAvoid: data.mustAvoid.filter(Boolean),
      brandProfileId: profile.id,
      variantsPerChannel: data.variantsPerChannel,
      competitorContext,
      createdBy: auth.user.id,
    })
    .returning()

  const { variants, simulated } = await generateVariants({
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    brief,
    profile,
    competitiveContext: competitorContext?.text ?? null,
  })

  const rules = await db.select().from(legalRules).where(eq(legalRules.workspaceId, auth.workspace.id))
  const competitorNames = competitorContext?.brandNames ?? (await competitorBrandNames(auth.workspace.id))
  const assetIds: string[] = []

  for (const v of variants) {
    const detail = scoreAsset({ body: v.body, channel: v.channel, profile, legalRules: rules, competitorNames })
    const [asset] = await db
      .insert(assets)
      .values({
        workspaceId: auth.workspace.id,
        briefId: brief.id,
        campaignId: data.campaignId ?? null,
        channel: v.channel as Channel,
        variantLabel: v.variantLabel,
        title: v.title,
        body: v.body as AssetBody,
        imagePrompt: v.imagePrompt ?? null,
        brandScore: detail.brand.score,
        complianceScore: detail.compliance.score,
        compositeScore: detail.composite,
        scoreDetail: detail,
        createdBy: auth.user.id,
      })
      .returning({ id: assets.id })

    await db.insert(assetVersions).values({
      assetId: asset.id,
      version: 1,
      body: v.body as AssetBody,
      scoreDetail: detail,
      note: `Initial generation — ${v.angle}`,
      createdBy: auth.user.id,
    })

    await recordAudit({
      workspaceId: auth.workspace.id,
      actorId: auth.user.id,
      actorType: 'system',
      action: 'asset.generated',
      subjectType: 'asset',
      subjectId: asset.id,
      summary: `Generated "${v.title}" (${v.channel}, variant ${v.variantLabel}). Scored ${detail.composite}/100 — ${detail.passed ? 'passed' : 'below threshold'}.`,
      payload: {
        briefId: brief.id,
        composite: detail.composite,
        passed: detail.passed,
        simulated,
        competitorLandscapeId: competitorContext?.landscapeId ?? null,
      },
    })
    assetIds.push(asset.id)
  }

  revalidatePath('/studio')
  revalidatePath('/command-center')
  return {
    ok: true,
    message: `Generated ${assetIds.length} variants across ${data.channels.length} channel(s)${
      competitorContext ? `, steered by ${competitorContext.competitorIds.length} competitors` : ''
    }.`,
    data: { briefId: brief.id, assetIds, simulated },
  }
}

/** CS-3: inline edit. Re-scores and versions on every save. */
export async function updateAssetBody(assetId: string, body: AssetBody): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'asset:edit')
  } catch {
    return { ok: false, message: 'Your role cannot edit assets.' }
  }

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, auth.workspace.id), eq(assets.id, assetId)))
    .limit(1)
  if (!asset) return { ok: false, message: 'Asset not found.' }
  if (asset.status === 'published') return { ok: false, message: 'Published assets cannot be edited.' }

  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
    .limit(1)
  if (!profile) return { ok: false, message: 'No default brand profile.' }

  const rules = await db.select().from(legalRules).where(eq(legalRules.workspaceId, auth.workspace.id))
  const detail = scoreAsset({
    body,
    channel: asset.channel,
    profile,
    legalRules: rules,
    competitorNames: await competitorBrandNames(auth.workspace.id),
  })
  const version = asset.version + 1

  await db
    .update(assets)
    .set({
      body,
      version,
      brandScore: detail.brand.score,
      complianceScore: detail.compliance.score,
      compositeScore: detail.composite,
      scoreDetail: detail,
      editedByHuman: true,
      // An approved asset that is edited must go back through the gate.
      status: asset.status === 'approved' || asset.status === 'scheduled' ? 'draft' : asset.status,
      stage: asset.status === 'approved' || asset.status === 'scheduled' ? 'generate' : asset.stage,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, assetId))

  await db.insert(assetVersions).values({
    assetId,
    version,
    body,
    scoreDetail: detail,
    note: 'Edited by hand.',
    createdBy: auth.user.id,
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    action: 'asset.edited',
    subjectType: 'asset',
    subjectId: assetId,
    summary: `"${asset.title}" edited to v${version}. Score moved ${asset.compositeScore ?? 0} → ${detail.composite}.`,
    payload: { from: asset.compositeScore, to: detail.composite, version },
  })

  revalidatePath(`/studio/${assetId}`)
  revalidatePath('/studio')
  return {
    ok: true,
    message:
      asset.status === 'approved' || asset.status === 'scheduled'
        ? `Saved as v${version}. Because this was already approved, it has returned to draft and needs re-review.`
        : `Saved as v${version}. Now scoring ${detail.composite}/100.`,
  }
}

/** CS-3: regenerate one asset, preserving the brief. */
export async function regenerateAsset(assetId: string, instruction?: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'asset:edit')
  } catch {
    return { ok: false, message: 'Your role cannot regenerate assets.' }
  }

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, auth.workspace.id), eq(assets.id, assetId)))
    .limit(1)
  if (!asset) return { ok: false, message: 'Asset not found.' }
  if (!asset.briefId) return { ok: false, message: 'This asset has no brief to regenerate from.' }

  const [brief] = await db.select().from(briefs).where(eq(briefs.id, asset.briefId)).limit(1)
  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.workspaceId, auth.workspace.id), eq(brandProfiles.isDefault, true)))
    .limit(1)
  if (!brief || !profile) return { ok: false, message: 'Brief or brand profile missing.' }

  const { variants } = await generateVariants({
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    brief: { ...brief, variantsPerChannel: 1 },
    profile,
    onlyChannel: asset.channel,
    instruction: instruction || `Take a different angle from: "${asset.title}".`,
    // The same context the brief was written with, not a newer one.
    competitiveContext: brief.competitorContext?.text ?? null,
  })

  const v = variants[0]
  if (!v) return { ok: false, message: 'No variant was returned.' }

  const rules = await db.select().from(legalRules).where(eq(legalRules.workspaceId, auth.workspace.id))
  const detail = scoreAsset({
    body: v.body,
    channel: asset.channel,
    profile,
    legalRules: rules,
    competitorNames: brief.competitorContext?.brandNames ?? (await competitorBrandNames(auth.workspace.id)),
  })
  const version = asset.version + 1

  await db
    .update(assets)
    .set({
      title: v.title,
      body: v.body as AssetBody,
      version,
      brandScore: detail.brand.score,
      complianceScore: detail.compliance.score,
      compositeScore: detail.composite,
      scoreDetail: detail,
      status: 'draft',
      stage: 'generate',
      editedByHuman: false,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, assetId))

  await db.insert(assetVersions).values({
    assetId,
    version,
    body: v.body as AssetBody,
    scoreDetail: detail,
    note: instruction ? `Regenerated: ${instruction}` : `Regenerated — ${v.angle}`,
    createdBy: auth.user.id,
  })

  await recordAudit({
    workspaceId: auth.workspace.id,
    actorId: auth.user.id,
    actorType: 'system',
    action: 'asset.regenerated',
    subjectType: 'asset',
    subjectId: assetId,
    summary: `Regenerated from brief "${brief.title}" to v${version}. Scored ${detail.composite}/100.`,
    payload: { instruction: instruction ?? null, composite: detail.composite },
  })

  revalidatePath(`/studio/${assetId}`)
  return { ok: true, message: `Regenerated. Now scoring ${detail.composite}/100.` }
}

export async function submitForReviewAction(assetId: string): Promise<ActionResult> {
  const auth = await requireAuth()
  try {
    assertCan(auth.role, 'asset:submit')
  } catch {
    return { ok: false, message: 'Your role cannot submit assets for review.' }
  }
  try {
    const r = await submitAssetForReview({
      workspaceId: auth.workspace.id,
      assetId,
      actorId: auth.user.id,
    })
    revalidatePath('/studio')
    revalidatePath('/approvals')
    revalidatePath('/command-center')
    return { ok: true, message: `Sent to "${r.chainName}" — now with ${r.stepName}.` }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof GateError ? e.message : 'Could not submit this asset for review.',
    }
  }
}

export async function restoreVersion(assetId: string, version: number): Promise<ActionResult> {
  const auth = await requireAuth()
  const [v] = await db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.version, version)))
    .limit(1)
  if (!v) return { ok: false, message: 'That version no longer exists.' }
  void auth
  return updateAssetBody(assetId, v.body)
}

/**
 * Version history for one asset.
 *
 * Every export from a `'use server'` module is a public POST endpoint, so this
 * needs its own authentication and its own workspace predicate — being called
 * only from an authenticated page is not a control. Joining through `assets`
 * rather than filtering `assetVersions` directly is what scopes it, because
 * the versions table has no workspace column of its own.
 */
export async function listVersions(assetId: string) {
  const auth = await requireAuth()
  return db
    .select({ version: assetVersions })
    .from(assetVersions)
    .innerJoin(
      assets,
      and(eq(assets.id, assetVersions.assetId), eq(assets.workspaceId, auth.workspace.id)),
    )
    .where(eq(assetVersions.assetId, assetId))
    .orderBy(desc(assetVersions.version))
    .then((rows) => rows.map((r) => r.version))
}

export async function goToStudio(assetId: string) {
  redirect(`/studio/${assetId}`)
}
