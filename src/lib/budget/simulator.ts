/**
 * The simulated market for the Budget Allocator.
 *
 * Like the Competitors simulator, it exists so the whole loop — curves,
 * allocation, pacing, card reconciliation — runs with nothing connected, and
 * everything it produces is stored with source 'simulated' and labelled on
 * screen.
 *
 * It is built from known "true" curves, which makes it a test harness too: the
 * allocator's recommendation can be checked against the answer the simulator
 * knows. And it plants the problems the reconciliation is meant to find: a
 * duplicate Google charge, a charge from a Google account that is not yours,
 * USD billing on LinkedIn, a TikTok test nobody budgeted, an unrecognised
 * merchant, a stale authorisation.
 */
import { adstock, hill } from './curves'
import { addDays, dayRange, dow, weekStart } from './pacing'
import { normal, seeded } from './random'
import type { CardTx, CurveParams, Observation, PlatformDay } from './types'

export type TrueChannel = {
  key: string
  baseWeeklyPence: number
  params: CurveParams
  revenuePerConversionPence: number
}

/** The simulator's ground truth. Meta is under-funded relative to Google; email saturates early. */
export const TRUE_CHANNELS: TrueChannel[] = [
  { key: 'google_ads', baseWeeklyPence: 150_000, params: { beta: 62, alpha: 1.2, gamma: 170_000, theta: 0.2 }, revenuePerConversionPence: 18_500 },
  { key: 'meta_ads', baseWeeklyPence: 90_000, params: { beta: 72, alpha: 1.0, gamma: 260_000, theta: 0.4 }, revenuePerConversionPence: 14_000 },
  { key: 'linkedin_ads', baseWeeklyPence: 40_000, params: { beta: 18, alpha: 1.3, gamma: 90_000, theta: 0.3 }, revenuePerConversionPence: 42_000 },
  { key: 'email', baseWeeklyPence: 15_000, params: { beta: 24, alpha: 0.9, gamma: 18_000, theta: 0.1 }, revenuePerConversionPence: 12_000 },
  { key: 'seo_content', baseWeeklyPence: 60_000, params: { beta: 34, alpha: 1.1, gamma: 380_000, theta: 0.7 }, revenuePerConversionPence: 16_000 },
]

/**
 * Weekly history: spend varies (seasonality, budget steps, noise) so curves
 * are identifiable, and outcomes follow the true curve with noise.
 */
export function simulateHistory(args: { endWeek: string; weeks: number; seed: string; channels?: TrueChannel[] }): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>()
  for (const ch of args.channels ?? TRUE_CHANNELS) {
    const rand = seeded(`${args.seed}:${ch.key}`)
    const spend: number[] = []
    const weekStarts: string[] = []
    for (let i = args.weeks - 1; i >= 0; i--) weekStarts.push(addDays(args.endWeek, -7 * i))
    for (let i = 0; i < args.weeks; i++) {
      const season = 1 + 0.32 * Math.sin((i / 52) * 2 * Math.PI * 2 + ch.key.length)
      const step = i > args.weeks * 0.6 ? 1.18 : i < args.weeks * 0.25 ? 0.8 : 1
      const burst = rand() < 0.08 ? 1.6 : rand() < 0.08 ? 0.45 : 1
      const noise = Math.exp(normal(rand) * 0.14)
      spend.push(Math.round(ch.baseWeeklyPence * season * step * burst * noise))
    }
    const ad = adstock(spend, ch.params.theta)
    const obs: Observation[] = weekStarts.map((w, i) => {
      const expected = ch.params.beta * hill(ad[i], ch.params.alpha, ch.params.gamma)
      const conversions = Math.max(0, Math.round(expected * Math.exp(normal(rand) * 0.12)))
      const revenue = Math.round(conversions * ch.revenuePerConversionPence * (0.85 + rand() * 0.3))
      return { weekStart: w, spendPence: spend[i], conversions, revenuePence: revenue, source: 'simulated' }
    })
    out.set(ch.key, obs)
  }
  return out
}

/** Daily platform spend for the paid channels, weekday-shaped. */
export function simulatePlatformDays(args: {
  from: string
  to: string
  seed: string
  weekly: Record<string, number>
}): PlatformDay[] {
  const shape = [0.62, 1.12, 1.14, 1.12, 1.1, 1.0, 0.9] // Sun..Sat
  const rows: PlatformDay[] = []
  for (const [platform, weekly] of Object.entries(args.weekly)) {
    const rand = seeded(`${args.seed}:days:${platform}`)
    for (const d of dayRange(args.from, args.to)) {
      const base = (weekly / 7) * shape[dow(d)]
      rows.push({ platform, day: d, spendPence: Math.max(0, Math.round(base * Math.exp(normal(rand) * 0.1))), source: 'simulated' })
    }
  }
  return rows
}

const META_CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Card charges produced by threshold billing over the platform spend, plus
 * subscriptions and the planted problems.
 */
export function simulateCardFeed(args: {
  cardId: string
  from: string
  to: string
  today: string
  platformDays: PlatformDay[]
  googleCustomerId: string
  seed: string
}): Omit<CardTx, 'id' | 'platform' | 'lineId'>[] {
  const rand = seeded(`${args.seed}:card`)
  const txs: Omit<CardTx, 'id' | 'platform' | 'lineId'>[] = []
  const push = (
    day: string,
    amountPence: number,
    descriptor: string,
    extra: Partial<Omit<CardTx, 'id' | 'platform' | 'lineId'>> = {},
  ) => {
    const n = txs.length
    txs.push({
      cardId: args.cardId,
      externalId: `sim-${args.seed}-${n}`,
      postedAt: `${day}T${String(9 + (n % 9)).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}:00.000Z`,
      amountPence,
      currency: 'GBP',
      originalAmountMinor: null,
      originalCurrency: null,
      descriptor,
      status: 'settled',
      ...extra,
    })
  }

  const thresholds: Record<string, number> = { google_ads: 50_000, meta_ads: 40_000, linkedin_ads: 25_000 }
  const byPlatform = new Map<string, PlatformDay[]>()
  for (const d of args.platformDays) byPlatform.set(d.platform, [...(byPlatform.get(d.platform) ?? []), d])

  for (const [platform, days] of byPlatform) {
    const th = thresholds[platform]
    if (!th) continue
    // Start part-way to the first threshold: spend from before the period.
    let unbilled = Math.round(th * 0.4)
    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day))
    for (const d of sorted) {
      unbilled += d.spendPence
      // Charges post a day or two after the spend that triggered them.
      const postDay = addDays(d.day, 1 + Math.floor(rand() * 2))
      if (postDay > args.today) continue
      while (unbilled >= th) {
        unbilled -= th
        if (platform === 'google_ads') push(postDay, th, `GOOGLE*GOOG ${args.googleCustomerId}`)
        else if (platform === 'meta_ads') {
          const code = Array.from({ length: 10 }, () => META_CODE[Math.floor(rand() * META_CODE.length)]).join('')
          push(postDay, th, `FACEBK *${code}`)
        } else if (platform === 'linkedin_ads') {
          // Billed in USD: the card converts, with the issuer's margin in the rate.
          const usd = Math.round(th / 0.79)
          const rate = 0.79 * (1.0275 + (rand() - 0.5) * 0.004)
          push(postDay, Math.round(usd * rate), 'LINKEDIN *ADS 8847201', { originalAmountMinor: usd, originalCurrency: 'USD' })
        }
      }
    }
  }

  // Planted problems, placed relative to the period so they land inside it.
  const mid = addDays(args.from, Math.min(12, Math.max(1, Math.floor((Date.parse(args.today) - Date.parse(args.from)) / 86_400_000 / 2))))
  const dupDay = addDays(mid, 1)
  if (dupDay <= args.today) {
    push(dupDay, 50_000, `GOOGLE*GOOG ${args.googleCustomerId}`) // a genuine duplicate on top of the billing above
    push(dupDay, 50_000, `GOOGLE*GOOG ${args.googleCustomerId}`)
    push(mid, 35_000, 'GOOGLE*GOOG 9127734410') // somebody else's Google Ads account
    push(mid, 30_000, 'TIKTOK ADS 7341') // a test nobody budgeted
    push(addDays(mid, -3), 24_000, 'PAYPAL *CREATIVEHUB') // nobody knows
  }
  // Subscriptions and tools.
  const first = args.from
  push(addDays(first, 2), 68_000, 'HUBSPOT INC')
  push(addDays(first, 3), 9_900, 'CANVA* PRO')
  push(addDays(first, 4), 12_000, 'OPENAI *CHATGPT API', { originalAmountMinor: 15_000, originalCurrency: 'USD' })
  push(addDays(first, 5), 4_500, 'SENDGRID')
  // A stale authorisation and a pending duplicate of a settled Google charge (benign).
  push(addDays(args.today, -11), 100, 'GOOGLE *ADS VERIFY', { status: 'pending' })
  const lastGoogle = [...txs].reverse().find((t) => t.descriptor.startsWith('GOOGLE*GOOG 48'))
  if (lastGoogle) push(lastGoogle.postedAt.slice(0, 10), lastGoogle.amountPence, lastGoogle.descriptor, { status: 'pending' })

  return txs.filter((t) => t.postedAt.slice(0, 10) <= args.today && t.postedAt.slice(0, 10) >= args.from)
}

/** Monday on or before today, for history that ends with the last full week. */
export function lastFullWeek(today: string): string {
  return addDays(weekStart(today), -7)
}
