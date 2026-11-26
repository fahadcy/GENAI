import 'server-only'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GuardrailFinding, VideoMediaCheck, VideoMediaFacts } from '@/lib/db/schema'
import { CHANNEL_VIDEO_SPECS } from './policy'
import type { VideoAspect } from './catalogue'

const run = promisify(execFile)

/**
 * Post-generation mechanical checks.
 *
 * The honest division of labour in the video module is three ways:
 *
 *   • Deterministic, before generating — the prompt and script, through the
 *     same `scoreAsset` guardrails organic copy goes through. Free, so it can
 *     gate a spend.
 *   • Deterministic, after generating — everything measurable about the file
 *     that came back. That is this file.
 *   • Human — everything visual. Whether the footage is any good, whether the
 *     product looks right, whether it says what the brand means. There is no
 *     score for that, and inventing one would make reviewers approve things
 *     nobody looked at.
 *
 * So this file measures and never judges. It is the video equivalent of
 * `lib/ads/validate.ts` catching a 31-character headline before Google does.
 */

const finding = (
  ruleId: string,
  ruleName: string,
  severity: GuardrailFinding['severity'],
  message: string,
  remedy?: string,
): GuardrailFinding => ({ ruleId, ruleName, severity, message, ...(remedy ? { remedy } : {}) })

/**
 * Read the file's real properties. Never trusts what we asked the provider
 * for — a provider that quietly delivers five seconds when six were requested,
 * or drops the audio track, is a thing that happens, and the record should say
 * what arrived rather than what was ordered.
 */
export async function probeVideo(bytes: Uint8Array, ffprobePath = 'ffprobe'): Promise<VideoMediaFacts> {
  const dir = await mkdtemp(join(tmpdir(), 'genai-probe-'))
  const file = join(dir, 'clip.mp4')
  try {
    await writeFile(file, bytes)
    const { stdout } = await run(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    )

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string }
      streams?: Array<{
        codec_type?: string
        codec_name?: string
        width?: number
        height?: number
        avg_frame_rate?: string
        r_frame_rate?: string
      }>
    }

    const streams = parsed.streams ?? []
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.find((s) => s.codec_type === 'audio')

    if (!video) {
      throw new MediaCheckError('The generated file has no video stream. It is not a playable clip.')
    }

    const width = video.width ?? 0
    const height = video.height ?? 0

    return {
      durationSeconds: Number(parsed.format?.duration ?? 0),
      width,
      height,
      aspectRatio: describeRatio(width, height),
      frameRate: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate ?? '0/0'),
      hasAudio: Boolean(audio),
      byteSize: bytes.byteLength,
      container: parsed.format?.format_name ?? 'unknown',
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    }
  } catch (e) {
    if (e instanceof MediaCheckError) throw e
    const msg = (e as Error).message ?? String(e)
    if (/ENOENT/.test(msg)) {
      throw new MediaCheckError(
        'ffprobe is not installed, so generated clips cannot be checked before a reviewer sees them. Install ffmpeg on this machine and in the app and worker images.',
      )
    }
    throw new MediaCheckError(`Could not read the generated file: ${msg}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export class MediaCheckError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'MediaCheckError'
  }
}

/** Tolerance on duration. Encoders round; a quarter-second is not a defect. */
const DURATION_TOLERANCE = 0.35

export function checkVideoMedia(args: {
  facts: VideoMediaFacts
  channel: string | null
  requestedAspect: VideoAspect
  requestedDurationSeconds: number
  requestedAudio: boolean
}): VideoMediaCheck {
  const { facts, channel, requestedAspect, requestedDurationSeconds, requestedAudio } = args
  const findings: GuardrailFinding[] = []

  /* Did we get what we ordered? */
  if (Math.abs(facts.durationSeconds - requestedDurationSeconds) > DURATION_TOLERANCE) {
    findings.push(
      finding(
        'video.duration_mismatch',
        'Length differs from the order',
        'medium',
        `Requested ${requestedDurationSeconds}s, received ${facts.durationSeconds.toFixed(2)}s.`,
      ),
    )
  }

  if (facts.aspectRatio !== requestedAspect) {
    findings.push(
      finding(
        'video.aspect_mismatch',
        'Wrong aspect ratio',
        'high',
        `Requested ${requestedAspect}, received ${facts.aspectRatio} (${facts.width}×${facts.height}). Delivering this to a ${requestedAspect} placement means letterboxing.`,
        'Regenerate at the right ratio rather than cropping in post.',
      ),
    )
  }

  if (requestedAudio && !facts.hasAudio) {
    findings.push(
      finding(
        'video.audio_missing',
        'Audio missing',
        'high',
        'Audio was requested and paid for, and the file has no audio track.',
      ),
    )
  }

  if (facts.byteSize < 4096) {
    findings.push(
      finding(
        'video.truncated',
        'File is truncated',
        'high',
        `The file is only ${facts.byteSize} bytes. Nothing playable is that small — treat this as a failed generation, not a deliverable.`,
      ),
    )
  }

  if (facts.frameRate > 0 && facts.frameRate < 20) {
    findings.push(
      finding(
        'video.low_frame_rate',
        'Low frame rate',
        'medium',
        `${facts.frameRate.toFixed(1)} fps will read as stuttering on a phone.`,
      ),
    )
  }

  /* Will the channel accept it? */
  const spec = channel ? CHANNEL_VIDEO_SPECS[channel] : undefined
  if (spec) {
    if (!spec.aspectRatios.includes(facts.aspectRatio as VideoAspect)) {
      findings.push(
        finding(
          'video.channel_aspect',
          `${spec.label} aspect ratio`,
          'high',
          `${spec.label} accepts ${spec.aspectRatios.join(', ')} and this clip is ${facts.aspectRatio}.`,
        ),
      )
    }
    if (facts.durationSeconds < spec.minDurationSeconds) {
      findings.push(
        finding(
          'video.channel_duration_min',
          `${spec.label} minimum length`,
          'high',
          `${spec.label} requires at least ${spec.minDurationSeconds}s; this clip is ${facts.durationSeconds.toFixed(1)}s.`,
        ),
      )
    }
    if (facts.durationSeconds > spec.maxDurationSeconds) {
      findings.push(
        finding(
          'video.channel_duration_max',
          `${spec.label} maximum length`,
          'high',
          `${spec.label} allows at most ${spec.maxDurationSeconds}s; this clip is ${facts.durationSeconds.toFixed(1)}s.`,
        ),
      )
    }
    const shortEdge = Math.min(facts.width, facts.height)
    if (shortEdge < spec.minShortEdgePx) {
      findings.push(
        finding(
          'video.channel_resolution',
          `${spec.label} minimum resolution`,
          'high',
          `${spec.label} requires a short edge of at least ${spec.minShortEdgePx}px; this clip is ${shortEdge}px.`,
        ),
      )
    }
    if (facts.byteSize > spec.maxFileSizeBytes) {
      findings.push(
        finding(
          'video.channel_file_size',
          `${spec.label} file size`,
          'high',
          `${spec.label} caps uploads at ${formatBytes(spec.maxFileSizeBytes)}; this file is ${formatBytes(facts.byteSize)}.`,
        ),
      )
    }
    if (spec.audioStronglyExpected && !facts.hasAudio) {
      findings.push(
        finding(
          'video.channel_audio',
          `${spec.label} expects sound`,
          'medium',
          `Silent creative consistently underperforms on ${spec.label}.`,
          'Regenerate with audio, or add a track before publishing.',
        ),
      )
    }
  }

  return { passed: !findings.some((f) => f.severity === 'high'), findings, facts }
}

/* ----------------------------------------------------------------- utils */

function parseFrameRate(fr: string): number {
  const [num, den] = fr.split('/').map(Number)
  if (!num || !den) return 0
  return num / den
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * Name the ratio a human would name. 1080×1920 is 9:16. An encoder producing
 * 1918×1080 should still read as 16:9 rather than 959:540.
 */
export function describeRatio(width: number, height: number): string {
  if (!width || !height) return 'unknown'
  const target = width / height
  const named: Array<[string, number]> = [
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['5:4', 5 / 4],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
  ]
  for (const [label, value] of named) {
    if (Math.abs(target - value) / value < 0.02) return label
  }
  const g = gcd(width, height)
  return `${width / g}:${height / g}`
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`
  return `${(n / 1024).toFixed(0)}KB`
}
