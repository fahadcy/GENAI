import type { AssetBody, GuardrailFinding, LegalRule, ScoreDetail } from '@/lib/db/schema'
import { scoreAsset, type ScoreInput } from '@/lib/ai/guardrails'
import { dimensionsFor, type VideoAspect, type VideoResolution } from './catalogue'
import { CHANNEL_VIDEO_SPECS } from './policy'
import { usableReferenceUrl, type VideoReferenceAsset } from './prompt'

/**
 * Pre-generation guardrails for video.
 *
 * This deliberately does not implement its own brand rules. The prompt and the
 * script go through `scoreAsset` — the same banned terms, legal rules,
 * disclaimers, preferred wording and tone the workspace already applies to
 * every email and post. One brand profile, one source of truth, and a legal
 * rule added in Settings covers video the moment it is saved, with nobody
 * having to remember a second place.
 *
 * What is added here is the handful of checks that only make sense for video,
 * and the reason they run *before* generation rather than after.
 *
 * With text, scoring is free and generation is nearly free, so ordering barely
 * matters. With video, generating costs real money — four variants of an
 * 8-second clip with audio is $4.80 on Veo Fast and $12.80 on the full model.
 * So the scoring that was built as pure functions with no model call earns its
 * keep twice over: it is free, which means it can gate a spend. A prohibited
 * claim in the script is caught for nothing rather than for five dollars after
 * four variants have rendered.
 */

export type VideoScoreInput = {
  title: string
  /** The visual description sent to the model. */
  prompt: string
  /** Spoken or on-screen words. Where most brand and legal risk lives. */
  script: string | null
  channel: string
  durationSeconds: number
  aspectRatio: VideoAspect
  resolution: VideoResolution
  audio: boolean
  references?: VideoReferenceAsset[]
  profile: ScoreInput['profile']
  legalRules: LegalRule[]
}

/**
 * Will the channel accept what we are about to order?
 *
 * The delivery checks in `media.ts` measure the file that came back, which is
 * the right place to catch a provider that under-delivered. But the settings
 * on the form are known before a penny is spent, and some of them are already
 * guaranteed to fail: a 480p clip cannot meet Instagram's 500px minimum edge
 * no matter how well the model renders it.
 *
 * Discovering that after paying is the failure this whole module is arranged
 * to avoid, so the same specification is applied twice — once to the order,
 * for free, and once to the delivery.
 */
export function channelPreflight(input: {
  channel: string
  aspectRatio: VideoAspect
  resolution: VideoResolution
  durationSeconds: number
  audio: boolean
}): GuardrailFinding[] {
  const spec = CHANNEL_VIDEO_SPECS[input.channel]
  if (!spec) return []

  const out: GuardrailFinding[] = []
  const { width, height } = dimensionsFor(input.aspectRatio, input.resolution)
  const shortEdge = Math.min(width, height)

  if (!spec.aspectRatios.includes(input.aspectRatio)) {
    out.push({
      ruleId: 'video:preflight_aspect',
      ruleName: `${spec.label} aspect ratio`,
      severity: 'high',
      message: `${spec.label} accepts ${spec.aspectRatios.join(', ')}, and this is set to ${input.aspectRatio}.`,
      remedy: `Change the ratio to ${spec.aspectRatios[0]} before generating.`,
    })
  }

  if (shortEdge < spec.minShortEdgePx) {
    out.push({
      ruleId: 'video:preflight_resolution',
      ruleName: `${spec.label} minimum resolution`,
      severity: 'high',
      message: `${spec.label} requires a short edge of at least ${spec.minShortEdgePx}px. At ${input.resolution} this clip would be ${width}×${height}, so it would be rejected at upload however it turns out.`,
      remedy: 'Raise the resolution before generating.',
    })
  }

  if (input.durationSeconds < spec.minDurationSeconds) {
    out.push({
      ruleId: 'video:preflight_duration_min',
      ruleName: `${spec.label} minimum length`,
      severity: 'high',
      message: `${spec.label} requires at least ${spec.minDurationSeconds}s and this is set to ${input.durationSeconds}s.`,
    })
  }

  if (input.durationSeconds > spec.maxDurationSeconds) {
    out.push({
      ruleId: 'video:preflight_duration_max',
      ruleName: `${spec.label} maximum length`,
      severity: 'high',
      message: `${spec.label} allows at most ${spec.maxDurationSeconds}s and this is set to ${input.durationSeconds}s.`,
    })
  }

  if (spec.audioStronglyExpected && !input.audio) {
    out.push({
      ruleId: 'video:preflight_audio',
      ruleName: `${spec.label} expects sound`,
      severity: 'low',
      message: `Silent creative consistently underperforms on ${spec.label}.`,
      remedy: 'Turn on audio, or plan to add a track before publishing.',
    })
  }

  return out
}

/**
 * A video's "copy" for scoring purposes is its script; the prompt is the
 * visual direction. Both are scored, because a prohibited claim is just as
 * prohibited when it is a caption burned into the footage.
 */
export function scoreVideoRequest(input: VideoScoreInput): ScoreDetail {
  const body: AssetBody = {
    headline: input.title,
    body: [input.script?.trim(), input.prompt.trim()].filter(Boolean).join('\n\n'),
  }

  const detail = scoreAsset({
    body,
    // Channel limits are keyed by channel and apply to text fields. Video has
    // its own delivery checks in media.ts, so a channel with no text limits is
    // the right input here.
    channel: input.channel,
    profile: input.profile,
    legalRules: input.legalRules,
  })

  const extra = [
    ...craftFindings(input),
    ...referenceFindings(input.references ?? [], input),
    ...channelPreflight({
      channel: input.channel,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
      audio: input.audio,
    }),
  ]
  if (extra.length === 0) return detail

  /* Craft findings are advisory and never block. Preflight findings can block,
     because a clip the channel is guaranteed to reject is not worth paying
     for — so the composite is reduced enough to fail the threshold when one is
     present, and `videoScorePasses` refuses on the high severity in any case. */
  const blocking = extra.some((f) => f.severity === 'high')
  return {
    ...detail,
    compliance: {
      ...detail.compliance,
      score: blocking ? Math.min(detail.compliance.score, 40) : detail.compliance.score,
      findings: [...detail.compliance.findings, ...extra],
    },
    composite: blocking ? Math.min(detail.composite, 40) : detail.composite,
    passed: blocking ? false : detail.passed,
  }
}

/**
 * Video-specific craft checks. Cheap, and they save money rather than enforce
 * policy — which is why every one of them is `low` severity and none of them
 * blocks.
 */
export function craftFindings(input: VideoScoreInput): GuardrailFinding[] {
  const out: GuardrailFinding[] = []
  const prompt = input.prompt.trim()

  if (prompt.length < 24) {
    out.push({
      ruleId: 'video:thin_prompt',
      ruleName: 'Thin prompt',
      severity: 'low',
      message: 'Short prompts produce generic footage, and it costs exactly the same as good footage.',
      remedy: 'Say what is in shot, how the camera moves, and what the light is doing.',
    })
  }

  if (prompt.length > 2000) {
    out.push({
      ruleId: 'video:overlong_prompt',
      ruleName: 'Overlong prompt',
      severity: 'low',
      message: 'Past roughly 2,000 characters, video models tend to ignore the later instructions.',
    })
  }

  if (/\b(logo|brand name|company name|wordmark)\b/i.test(prompt)) {
    out.push({
      ruleId: 'video:text_rendering',
      ruleName: 'Rendered text',
      severity: 'low',
      message: 'Asking a video model to render a logo or brand name reliably produces malformed lettering.',
      remedy: 'Leave space in the shot and composite the logo afterwards.',
    })
  }

  const script = input.script?.trim()
  if (script) {
    // Around 2.5 words a second is a comfortable voiceover pace.
    const words = script.split(/\s+/).filter(Boolean).length
    const comfortable = Math.round(input.durationSeconds * 2.5)
    if (words > comfortable) {
      out.push({
        ruleId: 'video:script_too_long',
        ruleName: 'Script will sound rushed',
        severity: 'low',
        message: `${words} words in ${input.durationSeconds}s. Around ${comfortable} fits at a natural pace.`,
        remedy: `Cut about ${words - comfortable} words, or generate a longer clip.`,
      })
    }
  }

  return out
}

export function referenceFindings(
  references: VideoReferenceAsset[],
  input: Pick<VideoScoreInput, 'script' | 'audio'>,
): GuardrailFinding[] {
  const out: GuardrailFinding[] = []

  references.forEach((r, index) => {
    if (!usableReferenceUrl(r.url)) {
      out.push({
        ruleId: `video:reference_url_${index}`,
        ruleName: 'Reference image URL',
        severity: 'high',
        message: 'Reference images must use an https URL that the worker and provider can fetch.',
        remedy: 'Use a public https image URL, or remove the reference before generating.',
      })
    }
  })

  const speaker = references.find((r) => r.kind === 'speaker')
  if (speaker && !speaker.likenessConfirmed) {
    out.push({
      ruleId: 'video:speaker_likeness_permission',
      ruleName: 'Speaker likeness permission',
      severity: 'high',
      message: 'A person reference can animate someone speaking, so permission to use that likeness must be confirmed first.',
      remedy: 'Confirm that you have permission to use this person in the clip.',
    })
  }

  if (speaker && input.script?.trim() && !input.audio) {
    out.push({
      ruleId: 'video:speaker_without_audio',
      ruleName: 'Speaker without audio',
      severity: 'low',
      message: 'A speaker reference with a script will work better with generated audio enabled.',
      remedy: 'Turn on audio, or use the script as captions instead.',
    })
  }

  if (references.some((r) => r.kind === 'logo')) {
    out.push({
      ruleId: 'video:logo_reference',
      ruleName: 'Logo reference',
      severity: 'low',
      message: 'The prompt will reserve a branded finish using the supplied logo rather than asking the model to invent lettering.',
    })
  }

  return out
}

/**
 * The refusal a failing score turns into. Lists every blocking finding at
 * once: fixing them one at a time, paying a round trip for each, is how people
 * learn to resent a guardrail.
 */
export function videoRefusalMessage(detail: ScoreDetail): string {
  const blocking = detail.compliance.findings.filter((f) => f.severity === 'high')
  if (blocking.length === 0) {
    return `The brief scored ${detail.composite}, below the brand profile's pass threshold. Nothing has been generated and nothing has been spent.`
  }
  const lines = blocking.map((f) => `• ${f.ruleName}: ${f.message}${f.remedy ? ` ${f.remedy}` : ''}`)
  return `Refused before generating — nothing has been spent.\n${lines.join('\n')}`
}

/** True when this brief may proceed to a provider. */
export function videoScorePasses(detail: ScoreDetail): boolean {
  return detail.passed && !detail.compliance.findings.some((f) => f.severity === 'high')
}
