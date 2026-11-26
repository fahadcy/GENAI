/**
 * SERP pixel-width estimator.
 *
 * Google truncates titles by rendered width, not character count: 60 "i"s
 * fit, 60 "W"s do not. Titles render in Arial ~20px on desktop, snippets
 * ~14px. Widths below are Arial advance widths in 1/1000 em.
 */

const ARIAL: Record<string, number> = {
  ' ': 278,
  '!': 278,
  '"': 355,
  '#': 556,
  $: 556,
  '%': 889,
  '&': 667,
  "'": 191,
  '(': 333,
  ')': 333,
  '*': 389,
  '+': 584,
  ',': 278,
  '-': 333,
  '.': 278,
  '/': 278,
  ':': 278,
  ';': 278,
  '?': 556,
  '|': 260,
  '£': 556,
  '€': 556,
  '—': 1000,
  '–': 556,
  '★': 1000,
  '·': 278,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
}

const DIGIT = 556
const FALLBACK = 556

export function textWidthPx(text: string, fontPx: number): number {
  let units = 0
  for (const ch of text) units += /\d/.test(ch) ? DIGIT : (ARIAL[ch] ?? FALLBACK)
  return (units / 1000) * fontPx
}

export const SERP_LIMITS = {
  titlePx: 580, // Google cuts near 600px; 20px margin for the ellipsis
  titleFontPx: 20,
  metaPx: 920,
  metaFontPx: 14,
  metaChars: 155,
  adHeadlineChars: 30,
  adDescriptionChars: 90,
} as const

export function titleFits(title: string): boolean {
  return textWidthPx(title, SERP_LIMITS.titleFontPx) <= SERP_LIMITS.titlePx
}

export function metaFits(meta: string): boolean {
  return (
    meta.length <= SERP_LIMITS.metaChars && textWidthPx(meta, SERP_LIMITS.metaFontPx) <= SERP_LIMITS.metaPx
  )
}

/** Trim to fit at a word boundary, never mid-word, never with a dangling separator. */
export function trimToFit(text: string, fits: (s: string) => boolean): string {
  if (fits(text)) return text
  const words = text.split(' ')
  while (words.length > 1) {
    words.pop()
    const candidate = words.join(' ').replace(/[\s,;:|–—-]+$/, '')
    const withStop = /[.!?]$/.test(candidate) ? candidate : `${candidate}.`
    if (fits(withStop)) return withStop
  }
  return words[0] ?? ''
}
