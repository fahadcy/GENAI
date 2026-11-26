/**
 * The video simulator.
 *
 * GenAI's connectors ship with simulators that validate payloads like the real
 * API, enforce the real limits, and fail a small share of calls with retryable
 * errors so the retry and dead-letter paths are genuinely exercised rather
 * than merely present. This is that idea for video, with one addition that
 * matters: it produces a real, playable MP4 at the requested dimensions and
 * duration, with a burned-in SIMULATED label.
 *
 * That means ffprobe measurement, the review player, storage, checksums and
 * the per-channel delivery checks all run against real bytes rather than a
 * stub — so the whole governed loop is demonstrable with no vendor account and
 * no spend, exactly as the Google Ads simulator makes the paid loop
 * demonstrable without a developer token.
 *
 * Job state is encoded in the job id rather than held in memory, so a worker
 * restart mid-generation behaves the way a real provider would instead of
 * losing the job.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { dimensionsFor, type VideoProviderId } from '../catalogue'
import {
  VideoProviderError,
  type ProviderDownload,
  type ProviderJob,
  type ProviderSubmitRequest,
  type VideoProvider,
} from './types'

const run = promisify(execFile)

/** A prompt containing this refuses on content grounds, on purpose. */
export const REFUSAL_TRIGGER = 'simulate-content-refusal'
/** A prompt containing this fails with a retryable error every time. */
export const RETRYABLE_TRIGGER = 'simulate-provider-outage'

type EncodedJob = {
  w: number
  h: number
  d: number
  a: boolean
  t: number
  roll: number
  refuse: boolean
  outage: boolean
}

export class SimulatorProvider implements VideoProvider {
  readonly id: VideoProviderId = 'simulator'
  readonly configured = true

  private readonly generationMs: number
  private readonly failureRate: number
  private readonly now: () => number
  private readonly ffmpegPath: string

  constructor(
    opts: { generationMs?: number; failureRate?: number; now?: () => number; ffmpegPath?: string } = {},
  ) {
    // Long enough that the studio shows a real "generating" state, short
    // enough that nobody waits around in a demo.
    this.generationMs = opts.generationMs ?? 6_000
    this.failureRate = opts.failureRate ?? 0.04
    this.now = opts.now ?? (() => Date.now())
    this.ffmpegPath = opts.ffmpegPath ?? 'ffmpeg'
  }

  async submit(req: ProviderSubmitRequest): Promise<ProviderJob> {
    // Validate the way a real provider does, so the simulator is never more
    // forgiving than production.
    if (!req.prompt.trim()) {
      throw new VideoProviderError('invalid_request', 'Prompt must not be empty.', {
        providerMessage: 'simulator: empty prompt',
      })
    }
    if (req.durationSeconds <= 0 || req.durationSeconds > 60) {
      throw new VideoProviderError('invalid_request', `Unsupported duration ${req.durationSeconds}s.`, {
        providerMessage: 'simulator: duration out of range',
      })
    }

    const { width, height } = dimensionsFor(req.aspectRatio, req.resolution)
    const encoded: EncodedJob = {
      w: width,
      h: height,
      d: req.durationSeconds,
      a: req.audio,
      t: this.now(),
      roll: rollFor(req.idempotencyKey),
      refuse: req.prompt.includes(REFUSAL_TRIGGER),
      outage: req.prompt.includes(RETRYABLE_TRIGGER),
    }

    return {
      providerJobId: `sim_${Buffer.from(JSON.stringify(encoded)).toString('base64url')}`,
      status: 'queued',
      progress: 0,
      error: null,
      assetRef: null,
      expiresAt: null,
    }
  }

  async poll(providerJobId: string): Promise<ProviderJob> {
    const job = decode(providerJobId)
    const elapsed = this.now() - job.t
    const base = { providerJobId, expiresAt: null, assetRef: null }

    if (job.refuse) {
      return {
        ...base,
        status: 'failed',
        progress: null,
        error: {
          code: 'CONTENT_POLICY',
          message:
            'Simulated content refusal: the safety filter blocked this prompt. Real providers do not charge for blocked output, and the same prompt will be blocked again.',
          retryable: false,
          contentRefusal: true,
        },
      }
    }

    if (job.outage || job.roll < this.failureRate * 1000) {
      return {
        ...base,
        status: 'failed',
        progress: null,
        error: {
          code: 'UNAVAILABLE',
          message: 'Simulated transient provider outage. This one is worth retrying.',
          retryable: true,
          contentRefusal: false,
        },
      }
    }

    if (elapsed < this.generationMs) {
      return {
        ...base,
        status: elapsed < this.generationMs * 0.15 ? 'queued' : 'running',
        progress: Math.min(99, Math.floor((elapsed / this.generationMs) * 100)),
        error: null,
      }
    }

    return { providerJobId, status: 'succeeded', progress: 100, error: null, assetRef: providerJobId, expiresAt: null }
  }

  async download(job: ProviderJob): Promise<ProviderDownload> {
    if (!job.assetRef) {
      throw new VideoProviderError('bad_response', 'Simulated job has no asset to download.')
    }
    const j = decode(job.assetRef)
    return { bytes: await this.render(j.w, j.h, j.d, j.a), contentType: 'video/mp4' }
  }

  /* -------------------------------------------------------------- render */

  private async render(width: number, height: number, seconds: number, audio: boolean): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'genai-video-sim-'))
    const out = join(dir, 'out.mp4')
    try {
      /**
       * Two recipes, tried in order.
       *
       * The first burns in a SIMULATED label, which needs `drawtext`, which
       * needs a font it can resolve. On Windows that regularly fails: most
       * builds ship fontconfig with no configuration and no registered fonts,
       * so drawtext dies with "Cannot find a valid font for the family Sans"
       * even though ffmpeg is installed perfectly well. The second recipe
       * drops the text for ffmpeg's own test card — no font needed, and just
       * as obviously not real footage, which is the property that matters.
       */
      for (const build of [
        () => this.labelledArgs(width, height, seconds, audio, out),
        () => this.testCardArgs(width, height, seconds, audio, out),
      ]) {
        try {
          await run(this.ffmpegPath, build(), { timeout: 60_000 })
          return new Uint8Array(await readFile(out))
        } catch {
          continue
        }
      }
      throw new VideoProviderError(
        'ffmpeg_missing',
        'The simulator could not render a clip because ffmpeg is not available. Install ffmpeg (see README → Video) or point VIDEO_PROVIDER at a real provider.',
      )
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** @internal — exported shape so a test can check both recipes. */
  labelledArgs(width: number, height: number, seconds: number, audio: boolean, out: string): string[] {
    const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x101a2b:s=${width}x${height}:d=${seconds}:r=24`]
    if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)

    const font = findSystemFont()
    // A Windows path's colon and backslashes must be escaped, or the filter
    // string parses as further options.
    const fontOpt = font ? `fontfile='${font.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : ''

    args.push(
      '-vf',
      [
        `drawtext=${fontOpt}text='SIMULATED':fontcolor=white:fontsize=${Math.max(16, Math.round(height / 12))}:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(height / 20)}`,
        `drawtext=${fontOpt}text='%{pts\\:hms}':fontcolor=0x94a3b8:fontsize=${Math.max(12, Math.round(height / 24))}:x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(height / 12)}`,
      ].join(','),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      // Move the moov atom to the front. Without it a browser has to fetch the
      // whole file before it can show a single frame, which is why an
      // apparently fine clip renders as an empty player.
      '-movflags',
      '+faststart',
      '-t',
      String(seconds),
    )
    if (audio) args.push('-c:a', 'aac', '-shortest')
    args.push(out)
    return args
  }

  /** @internal — fallback recipe: no text, no font, unmistakably synthetic. */
  testCardArgs(width: number, height: number, seconds: number, audio: boolean, out: string): string[] {
    const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=${seconds}:rate=24`]
    if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(seconds))
    if (audio) args.push('-c:a', 'aac', '-shortest')
    args.push(out)
    return args
  }
}

function decode(jobId: string): EncodedJob {
  if (!jobId.startsWith('sim_')) {
    throw new VideoProviderError('invalid_request', `Not a simulator job id: ${jobId}`)
  }
  try {
    return JSON.parse(Buffer.from(jobId.slice(4), 'base64url').toString('utf8')) as EncodedJob
  } catch (e) {
    throw new VideoProviderError('invalid_request', 'Corrupt simulator job id.', { cause: e })
  }
}

/** Deterministic 0–999 from the idempotency key: same request, same outcome. */
function rollFor(key: string): number {
  const h = createHash('sha256').update(key).digest()
  return ((h[0] << 8) | h[1]) % 1000
}

/** A font drawtext can definitely open, or null to let fontconfig try. */
function findSystemFont(): string | null {
  const candidates = [
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ]
  for (const path of candidates) {
    try {
      if (statSync(path).isFile()) return path
    } catch {
      continue
    }
  }
  return null
}
