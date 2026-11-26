/**
 * Video generation tests.
 *
 * The pure ones come first — plan caps, provider capabilities, costing, the
 * acknowledgement handshake and the ceiling — because those are the code that
 * decides whether money is spent, and they should be provable without a
 * database or a clock.
 *
 * Then the loop, end to end against the simulator: refused before spending,
 * generated, measured, submitted, approved, regenerated, approval voided. That
 * half renders and probes a real MP4, so it needs ffmpeg; without it those
 * tests skip with a printed reason rather than failing on an assertion that
 * says nothing about the missing binary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { createWorkspace, destroyWorkspace, db, type Fixture } from './helpers'
import { approvalRequests, videoGenerations, workspaces } from '../src/lib/db/schema'
import {
  checkCeiling,
  enforceCeiling,
  estimateVideoCost,
  resolveVideoPolicy,
  verifyAcknowledgement,
  VideoPolicyError,
} from '../src/lib/video/policy'
import { durationsFor, supportsCombination, videoModel } from '../src/lib/video/catalogue'
import { checkVideoMedia, describeRatio } from '../src/lib/video/media'
import { channelPreflight, craftFindings, referenceFindings } from '../src/lib/video/guardrails'
import { processVideoJobs } from '../src/lib/video/jobs'
import { buildVideoPrompt } from '../src/lib/video/prompt'
import {
  ProviderRegistry,
  SimulatorProvider,
  VeoProvider,
  __setVideoProviders,
  type VideoProvider,
} from '../src/lib/video/providers'
import { quoteVideo, requestVideoGeneration } from '../src/lib/video/service'
import { assertVideoUsable, decide, submitForReview } from '../src/lib/workflow/approvals'
import { verifyChain } from '../src/lib/workflow/audit'
import type { VideoMediaFacts } from '../src/lib/db/schema'

const hasFfmpeg = (() => {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' })
    } catch {
      return false
    }
  }
  return true
})()

if (!hasFfmpeg) {
  console.warn(
    '\n  ffmpeg/ffprobe are not on PATH, so the end-to-end video tests are SKIPPED.\n' +
      '  Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Debian: apt-get install ffmpeg\n' +
      '  Both binaries are also needed by the app and worker images in production.\n',
  )
}

/* ------------------------------------------------------------ plan caps */

const base = {
  plan: 'growth' as const,
  primaryProvider: 'google' as const,
  resolution: '720p' as const,
  durationSeconds: 6,
  aspectRatio: '9:16' as const,
  variants: 4,
  audio: true,
}

test('a plan cap clamps the request and says so, rather than silently differing', () => {
  const r = resolveVideoPolicy({ ...base, plan: 'studio', resolution: '1080p', variants: 4, audio: true })
  assert.equal(r.resolution, '720p')
  assert.equal(r.variants, 2)
  assert.equal(r.audio, false)
  assert.ok(r.adjustments.join(' ').includes('studio'))
})

test('the trial plan cannot reach a paid provider at all', () => {
  const r = resolveVideoPolicy({ ...base, plan: 'trial' })
  assert.equal(r.model.providerId, 'simulator')
})

test('an unknown plan falls back to the most restrictive caps, not the most generous', () => {
  const r = resolveVideoPolicy({ ...base, plan: 'nonsense' as never })
  assert.equal(r.model.providerId, 'simulator')
})

test('an aspect ratio the model cannot produce is refused rather than reframed', () => {
  assert.throws(
    () => resolveVideoPolicy({ ...base, aspectRatio: '4:5', requestedModel: 'veo-3.1-lite-generate-preview' }),
    (e: unknown) => {
      assert.ok(e instanceof VideoPolicyError)
      assert.equal(e.code, 'unsupported_aspect')
      // A refusal that does not name the alternatives costs somebody a search.
      assert.match(e.message, /16:9/)
      assert.match(e.message, /nothing has been generated/i)
      return true
    },
  )
})

test('a duration the model does not offer is refused, and the message lists the ones it does', () => {
  assert.throws(
    () =>
      resolveVideoPolicy({
        ...base,
        plan: 'enterprise',
        durationSeconds: 7,
        requestedModel: 'veo-3.1-generate-preview',
      }),
    (e: unknown) => {
      assert.ok(e instanceof VideoPolicyError)
      assert.match(e.message, /4, 6, 8s/)
      return true
    },
  )
})

test('Veo 1080p is eight seconds only, and the picker knows it', () => {
  const veo = videoModel('veo-3.1-generate-preview')!
  assert.equal(supportsCombination(veo, '1080p', 8), true)
  assert.equal(supportsCombination(veo, '1080p', 4), false)
  assert.deepEqual(durationsFor(veo, '1080p'), [8])
  assert.deepEqual(durationsFor(veo, '720p'), [4, 6, 8])
})

test('Veo Lite refuses reference images before a paid API request', () => {
  assert.throws(
    () =>
      resolveVideoPolicy({
        ...base,
        requestedModel: 'veo-3.1-lite-generate-preview',
        referenceCount: 1,
      }),
    (e: unknown) => {
      assert.ok(e instanceof VideoPolicyError)
      assert.equal(e.code, 'references_unsupported')
      assert.match(e.message, /full Veo 3\.1/)
      return true
    },
  )
})

test('full Veo reference-image generations are quoted at the supported 8 seconds', () => {
  const r = resolveVideoPolicy({
    ...base,
    plan: 'scale',
    requestedModel: 'veo-3.1-generate-preview',
    durationSeconds: 6,
    referenceCount: 1,
  })
  assert.equal(r.durationSeconds, 8)
  assert.ok(r.adjustments.join(' ').includes('reference images at that duration'))
})

test('Veo requests do not send negativePrompt, even if an old row has one', async () => {
  const bodies: Array<Record<string, any>> = []
  const provider = new VeoProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json({ name: 'operations/test' })
    },
  })

  await provider.submit({
    model: 'veo-3.1-generate-preview',
    prompt: GOOD_PROMPT,
    negativePrompt: 'malformed text, distorted logo',
    aspectRatio: '9:16',
    resolution: '720p',
    durationSeconds: 8,
    audio: true,
    idempotencyKey: 'veo-negative-prompt-regression',
  })

  assert.equal(bodies[0]?.parameters?.negativePrompt, undefined)
})

test('Veo Lite provider rejects old queued rows with reference images locally', async () => {
  const provider = new VeoProvider({
    apiKey: 'test-key',
    fetchImpl: async () => {
      throw new Error('the API should not be called')
    },
  })

  await assert.rejects(
    provider.submit({
      model: 'veo-3.1-lite-generate-preview',
      prompt: GOOD_PROMPT,
      aspectRatio: '9:16',
      resolution: '720p',
      durationSeconds: 8,
      audio: true,
      referenceAssets: [{ kind: 'product', url: 'https://example.com/product.png' }],
      idempotencyKey: 'veo-lite-reference-regression',
    }),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /does not accept reference images/)
      return true
    },
  )
})

test('Runway WAN 3.0 exposes the 15s and 30s presets for longer social clips', () => {
  const wan = videoModel('wan3')!
  assert.deepEqual(durationsFor(wan, '720p'), [15, 30])
  assert.equal(supportsCombination(wan, '720p', 30), true)
  assert.equal(supportsCombination(wan, '720p', 10), false)
})

test('the default model is the cheapest the plan allows, never the dearest', () => {
  const r = resolveVideoPolicy({ ...base, requestedModel: null })
  assert.notEqual(r.model.id, 'veo-3.1-generate-preview')
})

/* --------------------------------------------------------------- costing */

test('a clip is priced from the per-second rate, the length and the variants', () => {
  const policy = resolveVideoPolicy({ ...base, durationSeconds: 8, variants: 4, audio: true })
  const e = estimateVideoCost(policy)
  // Veo 3.1 Fast: 10c/s + 5c/s audio = 15c/s × 8s = $1.20 each, $4.80 for four.
  assert.equal(e.perVariantCents, 120)
  assert.equal(e.totalCents, 480)
  assert.equal(Number.isInteger(e.totalCents), true)
})

test('the acknowledgement accepts the figure that was actually displayed', () => {
  const e = estimateVideoCost(resolveVideoPolicy(base))
  assert.doesNotThrow(() =>
    verifyAcknowledgement({
      current: e,
      presentedFingerprint: e.fingerprint,
      presentedTotalCents: e.totalCents,
    }),
  )
})

test('the acknowledgement refuses when the price moved between display and confirmation', () => {
  const current = estimateVideoCost(resolveVideoPolicy({ ...base, durationSeconds: 8 }))
  const stale = estimateVideoCost(resolveVideoPolicy({ ...base, durationSeconds: 4 }))
  assert.throws(
    () =>
      verifyAcknowledgement({
        current,
        presentedFingerprint: stale.fingerprint,
        presentedTotalCents: stale.totalCents,
      }),
    (e: unknown) => {
      assert.ok(e instanceof VideoPolicyError)
      assert.equal(e.code, 'estimate_stale')
      // Both figures in the message: the user has to see what changed.
      assert.match(e.message, /\$2\.40/)
      assert.match(e.message, /\$4\.80/)
      return true
    },
  )
})

test('the acknowledgement refuses when the settings changed but the total happens to match', () => {
  const a = estimateVideoCost(resolveVideoPolicy({ ...base, durationSeconds: 8, variants: 2, audio: true }))
  const b = estimateVideoCost(
    resolveVideoPolicy({ ...base, plan: 'enterprise', requestedModel: 'veo-3.1-generate-preview', durationSeconds: 6, variants: 2, audio: false }),
  )
  assert.equal(a.totalCents, b.totalCents)
  assert.throws(() =>
    verifyAcknowledgement({ current: a, presentedFingerprint: b.fingerprint, presentedTotalCents: b.totalCents }),
  )
})

test('the ceiling refuses rather than quietly generating fewer variants', () => {
  const check = checkCeiling({ ceilingCents: 5_000, spentCents: 4_900, requestedCents: 480 })
  assert.equal(check.wouldExceed, true)
  assert.throws(enforceCeiling.bind(null, check), (e: unknown) => {
    assert.ok(e instanceof VideoPolicyError)
    assert.equal(e.code, 'ceiling_reached')
    assert.match(e.message, /\$4\.80/)
    assert.match(e.message, /\$1\.00 left/)
    return true
  })
})

test('exactly hitting the ceiling is allowed; one cent over is not', () => {
  assert.equal(checkCeiling({ ceilingCents: 1000, spentCents: 0, requestedCents: 1000 }).wouldExceed, false)
  assert.equal(checkCeiling({ ceilingCents: 1000, spentCents: 0, requestedCents: 1001 }).wouldExceed, true)
})

/* ------------------------------------------------------- media checking */

const facts = (over: Partial<VideoMediaFacts> = {}): VideoMediaFacts => ({
  durationSeconds: 8,
  width: 720,
  height: 1280,
  aspectRatio: '9:16',
  frameRate: 24,
  hasAudio: true,
  byteSize: 3_000_000,
  container: 'mov,mp4,m4a',
  videoCodec: 'h264',
  audioCodec: 'aac',
  ...over,
})

test('aspect ratios are named the way a human would name them', () => {
  assert.equal(describeRatio(1920, 1080), '16:9')
  assert.equal(describeRatio(1080, 1920), '9:16')
  assert.equal(describeRatio(1080, 1350), '4:5')
  // Encoder rounding should not produce 959:540.
  assert.equal(describeRatio(1918, 1080), '16:9')
})

test('a clip matching the order and the channel passes', () => {
  const r = checkVideoMedia({
    facts: facts(),
    channel: 'instagram',
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: true,
  })
  assert.equal(r.passed, true)
})

test('the wrong aspect ratio blocks, and names the channel that would reject it', () => {
  const r = checkVideoMedia({
    facts: facts({ width: 1280, height: 720, aspectRatio: '16:9' }),
    channel: 'instagram',
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: true,
  })
  assert.equal(r.passed, false)
  assert.ok(r.findings.some((f) => f.ruleId === 'video.aspect_mismatch'))
  assert.ok(r.findings.some((f) => f.ruleId === 'video.channel_aspect'))
})

test('audio that was paid for and did not arrive is a blocking finding', () => {
  const r = checkVideoMedia({
    facts: facts({ hasAudio: false, audioCodec: null }),
    channel: null,
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: true,
  })
  assert.equal(r.findings.find((f) => f.ruleId === 'video.audio_missing')?.severity, 'high')
})

test('a truncated file is caught before it reaches a reviewer', () => {
  const r = checkVideoMedia({
    facts: facts({ byteSize: 28 }),
    channel: null,
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: false,
  })
  assert.equal(r.passed, false)
  assert.ok(r.findings.some((f) => f.ruleId === 'video.truncated'))
})

test('a fraction of a second of encoder rounding is tolerated; a real shortfall is not', () => {
  const rounded = checkVideoMedia({
    facts: facts({ durationSeconds: 8.2 }),
    channel: null,
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: true,
  })
  assert.equal(rounded.findings.some((f) => f.ruleId === 'video.duration_mismatch'), false)

  const short = checkVideoMedia({
    facts: facts({ durationSeconds: 5 }),
    channel: null,
    requestedAspect: '9:16',
    requestedDurationSeconds: 8,
    requestedAudio: true,
  })
  assert.equal(short.findings.some((f) => f.ruleId === 'video.duration_mismatch'), true)
})

/* ------------------------------------------------------- craft guardrails */

test('craft findings advise and never block', () => {
  const out = craftFindings({
    title: 'x',
    prompt: 'Our logo spinning over a city skyline.',
    script: null,
    channel: 'instagram',
    durationSeconds: 6,
    aspectRatio: '9:16',
    resolution: '720p',
    audio: true,
    profile: {} as never,
    legalRules: [],
  })
  assert.ok(out.some((f) => f.ruleId === 'video:text_rendering'))
  assert.equal(out.every((f) => f.severity === 'low'), true)
})

test('a script too long for the clip is flagged with the number of words to cut', () => {
  const out = craftFindings({
    title: 'x',
    prompt: 'A calm product shot on a white background, soft light.',
    script: Array.from({ length: 60 }, () => 'word').join(' '),
    channel: 'instagram',
    durationSeconds: 6,
    aspectRatio: '9:16',
    resolution: '720p',
    audio: true,
    profile: {} as never,
    legalRules: [],
  })
  const finding = out.find((f) => f.ruleId === 'video:script_too_long')
  assert.ok(finding)
  assert.match(finding.remedy ?? '', /Cut about \d+ words/)
})

test('a speaker image must confirm likeness permission before generation', () => {
  const out = referenceFindings(
    [{ kind: 'speaker', url: 'https://example.com/person.jpg', likenessConfirmed: false }],
    { script: 'This is our launch.', audio: true },
  )
  assert.equal(out.find((f) => f.ruleId === 'video:speaker_likeness_permission')?.severity, 'high')
})

test('the director prompt turns one line and references into a timed recipe', () => {
  const prompt = buildVideoPrompt({
    title: 'Launch teaser',
    prompt: 'Show our new booking app helping a salon owner fill empty appointments.',
    script: 'Fill tomorrow before today ends.',
    channel: 'instagram',
    durationSeconds: 15,
    aspectRatio: '9:16',
    audio: true,
    creativeMode: 'ugc',
    references: [
      {
        kind: 'speaker',
        url: 'https://example.com/founder.jpg',
        label: 'Founder',
        likenessConfirmed: true,
      },
      { kind: 'logo', url: 'https://example.com/logo.png' },
    ],
  })
  assert.match(prompt, /0-2s/)
  assert.match(prompt, /speaker likeness "Founder"/)
  assert.match(prompt, /supplied logo/)
})

test('a resolution the channel would reject blocks before any spend', () => {
  const findings = channelPreflight({
    channel: 'instagram',
    aspectRatio: '9:16',
    resolution: '480p',
    durationSeconds: 6,
    audio: true,
  })
  const blocker = findings.find((f) => f.ruleId === 'video:preflight_resolution')
  assert.ok(blocker, 'expected a blocking resolution finding')
  assert.equal(blocker.severity, 'high')
  // Instagram wants a 500px short edge; 480p vertical is 480px.
  assert.match(blocker.message, /500px/)
  assert.match(blocker.message, /480×852/)
})

test('a resolution the channel accepts raises nothing', () => {
  const findings = channelPreflight({
    channel: 'instagram',
    aspectRatio: '9:16',
    resolution: '720p',
    durationSeconds: 6,
    audio: true,
  })
  assert.equal(findings.filter((f) => f.severity === 'high').length, 0)
})

/* ------------------------------------------------------------ end to end */

const GOOD_PROMPT =
  'A slow push-in on a ceramic mug of coffee on a windowsill, soft morning light, steam rising, shallow depth of field.'

async function growthWorkspace(): Promise<Fixture> {
  const fx = await createWorkspace()
  // The seeded fixture is on trial, which is simulator-only by design. Growth
  // is the plan the loop is actually exercised on.
  await db.update(workspaces).set({ plan: 'growth' }).where(eq(workspaces.id, fx.ws.id))
  return fx
}

const quoteInput = {
  title: 'Morning ritual',
  prompt: GOOD_PROMPT,
  script: 'Mornings, made simple.',
  channel: 'instagram' as const,
  resolution: '720p' as const,
  durationSeconds: 6,
  variants: 1,
  audio: false,
  requestedModel: 'simulator-v1',
}

test('quoting prices the brief and spends nothing', { skip: !hasFfmpeg }, async () => {
  const fx = await growthWorkspace()
  try {
    const quote = await quoteVideo({
      workspaceId: fx.ws.id,
      role: 'owner',
      plan: 'growth',
      input: quoteInput,
    })
    assert.equal(quote.canProceed, true)
    assert.ok(quote.estimate.totalCents > 0)

    const rows = await db.select().from(videoGenerations).where(eq(videoGenerations.workspaceId, fx.ws.id))
    assert.equal(rows.length, 0)
  } finally {
    await destroyWorkspace(fx)
  }
})

test('a banned term in the script refuses before anything is generated', { skip: !hasFfmpeg }, async () => {
  const fx = await growthWorkspace()
  try {
    const input = { ...quoteInput, script: 'Guaranteed results, every morning.' }
    const quote = await quoteVideo({ workspaceId: fx.ws.id, role: 'owner', plan: 'growth', input })
    assert.equal(quote.canProceed, false)

    await assert.rejects(
      requestVideoGeneration({
        workspaceId: fx.ws.id,
        actorId: fx.owner.id,
        role: 'owner',
        plan: 'growth',
        input,
        acknowledgedFingerprint: quote.estimate.fingerprint,
        acknowledgedTotalCents: quote.estimate.totalCents,
      }),
      (e: unknown) => {
        assert.ok(e instanceof VideoPolicyError)
        assert.equal(e.code, 'guardrail_blocked')
        assert.match(e.message, /nothing has been spent/i)
        return true
      },
    )

    // No row, no provider call — and the refusal itself is on the record.
    const rows = await db.select().from(videoGenerations).where(eq(videoGenerations.workspaceId, fx.ws.id))
    assert.equal(rows.length, 0)
    const chain = await verifyChain(fx.ws.id)
    assert.equal(chain.ok, true)
  } finally {
    await destroyWorkspace(fx)
  }
})

test('a stale acknowledgement is refused even when everything else is fine', { skip: !hasFfmpeg }, async () => {
  const fx = await growthWorkspace()
  try {
    await assert.rejects(
      requestVideoGeneration({
        workspaceId: fx.ws.id,
        actorId: fx.owner.id,
        role: 'owner',
        plan: 'growth',
        input: quoteInput,
        acknowledgedFingerprint: 'a-figure-from-some-other-quote',
        acknowledgedTotalCents: 1,
      }),
      (e: unknown) => {
        assert.ok(e instanceof VideoPolicyError)
        assert.equal(e.code, 'estimate_stale')
        return true
      },
    )
    const rows = await db.select().from(videoGenerations).where(eq(videoGenerations.workspaceId, fx.ws.id))
    assert.equal(rows.length, 0)
  } finally {
    await destroyWorkspace(fx)
  }
})

test('a role that cannot spend cannot generate', { skip: !hasFfmpeg }, async () => {
  const fx = await growthWorkspace()
  try {
    await assert.rejects(
      quoteVideo({ workspaceId: fx.ws.id, role: 'analyst', plan: 'growth', input: quoteInput }),
      (e: unknown) => {
        assert.ok(e instanceof VideoPolicyError)
        assert.equal(e.code, 'not_permitted')
        return true
      },
    )
  } finally {
    await destroyWorkspace(fx)
  }
})

/**
 * A deterministic simulator for the loop tests.
 *
 * The default one fails 4% of submissions with a retryable error on purpose,
 * so the retry and dead-letter paths are genuinely exercised in normal use.
 * That is right for the product and wrong for a test asserting the happy path:
 * it would fail roughly one run in twenty-five, and a suite that fails
 * occasionally teaches people to re-run rather than to look. The retry path
 * has its own test, below, which triggers it deliberately.
 */
function useDeterministicSimulator() {
  __setVideoProviders(
    new ProviderRegistry({
      providers: new Map<'simulator', VideoProvider>([
        ['simulator', new SimulatorProvider({ generationMs: 0, failureRate: 0 })],
      ]) as never,
      primary: 'simulator',
      fallback: null,
    }),
  )
}

/** Drive the worker until nothing is in flight, exactly as the tick does. */
async function drain(workspaceId: string, max = 30) {
  for (let i = 0; i < max; i++) {
    const outcomes = await processVideoJobs(workspaceId, 5)
    if (outcomes.length === 0) return
    if (outcomes.every((o) => o.status === 'ready' || o.status === 'dead_letter')) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

test(
  'the whole loop: generate, measure, review, approve, regenerate, void',
  { skip: !hasFfmpeg },
  async () => {
    useDeterministicSimulator()
    const fx = await growthWorkspace()
    try {
      const quote = await quoteVideo({
        workspaceId: fx.ws.id,
        role: 'owner',
        plan: 'growth',
        input: quoteInput,
      })

      const [created] = await requestVideoGeneration({
        workspaceId: fx.ws.id,
        actorId: fx.owner.id,
        role: 'owner',
        plan: 'growth',
        input: quoteInput,
        acknowledgedFingerprint: quote.estimate.fingerprint,
        acknowledgedTotalCents: quote.estimate.totalCents,
      })
      assert.equal(created.status, 'queued')

      await drain(fx.ws.id)

      const [ready] = await db.select().from(videoGenerations).where(eq(videoGenerations.id, created.id))
      assert.equal(ready.status, 'ready', ready.lastError ?? 'expected the clip to be ready')
      assert.ok(ready.storageKey)
      assert.match(ready.checksumSha256 ?? '', /^[0-9a-f]{64}$/)

      // Real media, really measured.
      assert.equal(ready.mediaFacts?.width, 720)
      assert.equal(ready.mediaFacts?.height, 1280)
      assert.equal(ready.mediaFacts?.aspectRatio, '9:16')
      assert.equal(Math.round(ready.mediaFacts?.durationSeconds ?? 0), 6)
      assert.equal(ready.mediaCheck?.passed, true)

      // Simulated runs are never metered.
      assert.equal(ready.simulated, true)

      /* The gate refuses before approval… */
      await assert.rejects(assertVideoUsable(fx.ws.id, created.id), /not been submitted/i)

      await submitForReview({
        workspaceId: fx.ws.id,
        subjectType: 'video',
        subjectId: created.id,
        actorId: fx.owner.id,
      })

      const [req] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.subjectId, created.id))
      assert.equal(req.subjectType, 'video')
      assert.equal(req.subjectVersion, 1)

      await decide({
        workspaceId: fx.ws.id,
        requestId: req.id,
        actorId: fx.approver.id,
        actorRole: 'approver',
        decision: 'approve',
      })

      /* …and permits it once approved. */
      const usable = await assertVideoUsable(fx.ws.id, created.id)
      assert.equal(usable.status, 'approved')

      /* Regenerating produces different footage, so the approval must go. */
      const quote2 = await quoteVideo({
        workspaceId: fx.ws.id,
        role: 'owner',
        plan: 'growth',
        input: quoteInput,
      })
      const [second] = await requestVideoGeneration({
        workspaceId: fx.ws.id,
        actorId: fx.owner.id,
        role: 'owner',
        plan: 'growth',
        input: quoteInput,
        acknowledgedFingerprint: quote2.estimate.fingerprint,
        acknowledgedTotalCents: quote2.estimate.totalCents,
        supersedesId: created.id,
      })
      assert.equal(second.version, 2)
      assert.equal(second.lineageId, ready.lineageId)

      await assert.rejects(assertVideoUsable(fx.ws.id, created.id), /reviewer asked for changes|regenerated/i)

      /* The audit chain covers all of it and still verifies. */
      const chain = await verifyChain(fx.ws.id)
      assert.equal(chain.ok, true, chain.reason ?? '')
    } finally {
      await destroyWorkspace(fx)
    }
  },
)

test('a content refusal is dead-lettered without being retried', { skip: !hasFfmpeg }, async () => {
  const fx = await growthWorkspace()
  try {
    const input = { ...quoteInput, prompt: `${GOOD_PROMPT} simulate-content-refusal` }
    const quote = await quoteVideo({ workspaceId: fx.ws.id, role: 'owner', plan: 'growth', input })
    const [created] = await requestVideoGeneration({
      workspaceId: fx.ws.id,
      actorId: fx.owner.id,
      role: 'owner',
      plan: 'growth',
      input,
      acknowledgedFingerprint: quote.estimate.fingerprint,
      acknowledgedTotalCents: quote.estimate.totalCents,
    })

    await drain(fx.ws.id)

    const [row] = await db.select().from(videoGenerations).where(eq(videoGenerations.id, created.id))
    assert.equal(row.status, 'dead_letter')
    // Straight to terminal: retrying a blocked prompt only spends again.
    assert.equal(row.attempts, 1)
    assert.match(row.lastError ?? '', /content/i)
  } finally {
    await destroyWorkspace(fx)
  }
})

test('a transient provider outage is retried, then dead-lettered', { skip: !hasFfmpeg }, async () => {
  useDeterministicSimulator()
  const fx = await growthWorkspace()
  try {
    const input = { ...quoteInput, prompt: `${GOOD_PROMPT} simulate-provider-outage` }
    const quote = await quoteVideo({ workspaceId: fx.ws.id, role: 'owner', plan: 'growth', input })
    const [created] = await requestVideoGeneration({
      workspaceId: fx.ws.id,
      actorId: fx.owner.id,
      role: 'owner',
      plan: 'growth',
      input,
      acknowledgedFingerprint: quote.estimate.fingerprint,
      acknowledgedTotalCents: quote.estimate.totalCents,
    })

    // One tick submits, the next polls and hits the simulated outage.
    await processVideoJobs(fx.ws.id, 5)
    await processVideoJobs(fx.ws.id, 5)

    const [row] = await db.select().from(videoGenerations).where(eq(videoGenerations.id, created.id))
    // Retryable, so it waits rather than dying on the first failure.
    assert.equal(row.attempts, 1)
    assert.ok(row.nextRetryAt, 'expected a scheduled retry')
    assert.notEqual(row.status, 'dead_letter')
    assert.match(row.lastError ?? '', /outage/i)
  } finally {
    await destroyWorkspace(fx)
  }
})

test('a clip that fails its delivery checks cannot be submitted for review', { skip: !hasFfmpeg }, async () => {
  useDeterministicSimulator()
  const fx = await growthWorkspace()
  try {
    const quote = await quoteVideo({ workspaceId: fx.ws.id, role: 'owner', plan: 'growth', input: quoteInput })
    const [created] = await requestVideoGeneration({
      workspaceId: fx.ws.id,
      actorId: fx.owner.id,
      role: 'owner',
      plan: 'growth',
      input: quoteInput,
      acknowledgedFingerprint: quote.estimate.fingerprint,
      acknowledgedTotalCents: quote.estimate.totalCents,
    })
    await drain(fx.ws.id)

    const [ready] = await db.select().from(videoGenerations).where(eq(videoGenerations.id, created.id))
    await db
      .update(videoGenerations)
      .set({
        mediaCheck: {
          passed: false,
          facts: ready.mediaFacts as VideoMediaFacts,
          findings: [
            {
              ruleId: 'video.channel_aspect',
              ruleName: 'Instagram aspect ratio',
              severity: 'high',
              message: 'Instagram accepts 9:16, 1:1, 4:5 and this clip is 16:9.',
            },
          ],
        },
      })
      .where(eq(videoGenerations.id, created.id))

    await assert.rejects(
      submitForReview({
        workspaceId: fx.ws.id,
        subjectType: 'video',
        subjectId: created.id,
        actorId: fx.owner.id,
      }),
      /rejected at upload/i,
    )
  } finally {
    await destroyWorkspace(fx)
  }
})
