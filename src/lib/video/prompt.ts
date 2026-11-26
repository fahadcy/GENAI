import type { Channel } from '@/lib/db/schema'
import type { VideoAspect } from './catalogue'

export type VideoReferenceKind = 'speaker' | 'logo' | 'product' | 'scene'

export type VideoReferenceAsset = {
  kind: VideoReferenceKind
  url: string
  label?: string
  instruction?: string
  likenessConfirmed?: boolean
}

export type VideoCreativeMode = 'auto' | 'ugc' | 'product' | 'cinematic'

export const REFERENCE_LIMIT = 10

const KIND_LABEL: Record<VideoReferenceKind, string> = {
  speaker: 'speaker likeness',
  logo: 'logo or wordmark',
  product: 'product reference',
  scene: 'scene or style reference',
}

export function normalizeCreativeMode(value: unknown): VideoCreativeMode {
  return value === 'ugc' || value === 'product' || value === 'cinematic' ? value : 'auto'
}

export function normalizeVideoReferences(value: unknown): VideoReferenceAsset[] {
  if (!Array.isArray(value)) return []

  const out: VideoReferenceAsset[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const kind = normalizeKind(r.kind)
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!kind || !url) continue
    out.push({
      kind,
      url,
      label: trimText(r.label, 64),
      instruction: trimText(r.instruction, 180),
      likenessConfirmed: r.likenessConfirmed === true,
    })
    if (out.length >= REFERENCE_LIMIT) break
  }
  return out
}

export function usableReferenceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return (
      parsed.protocol === 'https:' &&
      Boolean(host) &&
      host !== 'localhost' &&
      !host.endsWith('.local') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host)
    )
  } catch {
    return false
  }
}

export function buildVideoPrompt(input: {
  title: string
  prompt: string
  script: string | null
  channel: Channel
  durationSeconds: number
  aspectRatio: VideoAspect
  audio: boolean
  creativeMode?: VideoCreativeMode
  references?: VideoReferenceAsset[]
}): string {
  const references = input.references ?? []
  const mode = input.creativeMode ?? 'auto'
  const script = input.script?.trim()
  const speaker = references.find((r) => r.kind === 'speaker')
  const logo = references.find((r) => r.kind === 'logo')
  const product = references.find((r) => r.kind === 'product')
  const scene = references.find((r) => r.kind === 'scene')

  const lines = [
    'Aurea Director Prompt',
    `Title: ${input.title.trim() || 'Untitled clip'}`,
    `Format: ${input.durationSeconds}s ${input.aspectRatio} for ${input.channel}.`,
    `Creative mode: ${modeLine(mode, Boolean(speaker), Boolean(product))}.`,
    '',
    'Core idea:',
    input.prompt.trim(),
    '',
    'Shot recipe:',
    ...shotRecipe(input.durationSeconds, mode, {
      hasSpeaker: Boolean(speaker),
      hasLogo: Boolean(logo),
      hasProduct: Boolean(product),
      hasScene: Boolean(scene),
    }),
  ]

  if (references.length > 0) {
    lines.push('', 'Reference handling:')
    references.forEach((r, i) => {
      lines.push(
        `${i + 1}. Use ${KIND_LABEL[r.kind]}${r.label ? ` "${r.label}"` : ''} as a visual reference. ${referenceInstruction(r)}`,
      )
    })
  }

  if (script) {
    lines.push('', 'Spoken or caption script:')
    if (speaker && input.audio) {
      lines.push(`The speaker delivers this naturally to camera, matching the reference likeness: "${script}"`)
    } else if (input.audio) {
      lines.push(`Use natural voiceover: "${script}"`)
    } else {
      lines.push(`Use this as minimal on-screen caption timing, not as dense text: "${script}"`)
    }
  }

  lines.push(
    '',
    'Finish:',
    logo
      ? 'End with a clean branded memory frame using the supplied logo reference; leave generous safe margins and do not invent extra lettering.'
      : 'End on a clean memory frame with the product or promise visually resolved.',
    'Keep motion intentional, faces consistent, hands natural, and text minimal. Make it feel like a deliberate advert, not stock footage.',
  )

  return lines.join('\n')
}

export function buildNegativePrompt(references: VideoReferenceAsset[]): string {
  const hasLogo = references.some((r) => r.kind === 'logo')
  const hasSpeaker = references.some((r) => r.kind === 'speaker')
  return [
    'malformed text',
    'random letters',
    'unreadable captions',
    hasLogo ? 'distorted logo, misspelled brand, invented wordmark' : null,
    hasSpeaker ? 'identity drift, distorted face, uncanny mouth movement, extra fingers' : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function normalizeKind(value: unknown): VideoReferenceKind | null {
  return value === 'speaker' || value === 'logo' || value === 'product' || value === 'scene' ? value : null
}

function trimText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  return text.slice(0, max)
}

function modeLine(mode: VideoCreativeMode, hasSpeaker: boolean, hasProduct: boolean): string {
  if (mode === 'ugc') return 'founder or creator speaks directly, proof-first, human and immediate'
  if (mode === 'product') return 'product-first, tactile demonstration, clear before-and-after'
  if (mode === 'cinematic') return 'premium cinematic reveal, controlled camera, emotional finish'
  if (hasSpeaker) return 'speaker-led social advert with a direct hook'
  if (hasProduct) return 'product-led transformation with a clear proof moment'
  return 'cinematic social advert with a hook, proof beat, and branded finish'
}

function shotRecipe(
  durationSeconds: number,
  mode: VideoCreativeMode,
  flags: { hasSpeaker: boolean; hasLogo: boolean; hasProduct: boolean; hasScene: boolean },
): string[] {
  if (durationSeconds >= 30) {
    return [
      `0-3s: pattern interrupt hook${flags.hasSpeaker ? ' from the referenced speaker' : ''}; show the problem in one visual beat.`,
      `3-10s: demonstrate the product, service or promise in motion${flags.hasProduct ? ' using the product reference as the source of truth' : ''}.`,
      `10-20s: proof beat; show a visible change, comparison, workflow, or result without making unsupported claims.`,
      `20-27s: emotional payoff; make the viewer feel the outcome, with camera motion that matches the channel.`,
      `27-30s: branded memory frame${flags.hasLogo ? ' with the supplied logo' : ''} and one simple call to action.`,
    ]
  }

  if (durationSeconds >= 15) {
    return [
      `0-2s: thumb-stopping hook${flags.hasSpeaker ? ' with the referenced speaker looking into camera' : ''}.`,
      `2-7s: show the product, scene, or offer becoming useful; keep the action readable on mobile.`,
      `7-12s: proof or transformation beat; one clear reason to believe.`,
      `12-15s: branded finish${flags.hasLogo ? ' using the supplied logo' : ''} and a clean call to action.`,
    ]
  }

  if (mode === 'ugc' || flags.hasSpeaker) {
    return [
      'Open immediately on the speaker, framed tight enough for mobile.',
      'Deliver one clear line, then cut to the proof visual.',
      'Finish with the product, offer, or brand mark held still for review.',
    ]
  }

  return [
    'Open on the strongest visual detail, already in motion.',
    'Move once: reveal, transform, or compare.',
    'Hold the final frame long enough for the viewer to remember it.',
  ]
}

function referenceInstruction(reference: VideoReferenceAsset): string {
  if (reference.instruction) return reference.instruction
  if (reference.kind === 'speaker') return 'Keep the same adult likeness, hair, face shape, and general styling.'
  if (reference.kind === 'logo') return 'Treat the logo as an overlay/source asset; do not redraw or misspell it.'
  if (reference.kind === 'product') return 'Preserve the product shape, colour, material, and proportions.'
  return 'Borrow lighting, palette, environment, or composition without copying irrelevant objects.'
}
