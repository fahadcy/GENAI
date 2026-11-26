/**
 * Where a play goes. Each destination is an existing composer, opened
 * prefilled: Content Studio for blog posts, landing pages, social posts and
 * email; the Google Ads builder for campaigns; Video Studio for clips. Nothing
 * is generated or published from here — the composer does that, under its own
 * scoring and approval rules. Pure.
 */

import type { Play, PlayDestination } from './types'

const STUDIO_CHANNELS: Partial<Record<PlayDestination, string>> = {
  blog: 'blog',
  landing_page: 'web',
  social: 'linkedin,facebook,instagram',
  email: 'email',
  meta_ads: 'meta_ads',
}

export function playHref(play: Play, destination: PlayDestination, ctx: { businessType: string }): string {
  if (destination === 'google_ads') {
    const q = new URLSearchParams({
      brief: `${play.brief.objective}${play.brief.keywords.length ? ` Target searches: ${play.brief.keywords.join(', ')}.` : ''}`,
      name: play.brief.title.slice(0, 100),
    })
    return `/ads/new?${q}`
  }
  if (destination === 'video') {
    const q = new URLSearchParams({
      title: play.brief.title.slice(0, 100),
      prompt: [
        `A short, honest video for a UK ${ctx.businessType}.`,
        play.brief.objective,
        'Real-looking people and settings, natural light, no on-screen competitor names or logos.',
      ].join(' '),
      script: play.brief.keyMessages.slice(0, 3).join(' '),
      channel: 'instagram',
    })
    return `/studio/video?${q}`
  }
  const q = new URLSearchParams({
    title: play.brief.title,
    objective: play.brief.objective,
    messages: [...play.brief.keyMessages, ...play.brief.keywords.map((k) => `Target search: ${k}`)].slice(0, 6).join('|'),
    channels: STUDIO_CHANNELS[destination] ?? 'blog',
  })
  return `/studio/new?${q}`
}
