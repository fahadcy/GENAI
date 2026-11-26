/**
 * Business goal → Google Ads configuration.
 *
 * This mapping lives in code rather than being left to the model, for three
 * reasons: it decides how money is spent, it has to be the same every time, and
 * someone who is not a marketer needs to be able to read *why* their campaign
 * was set up the way it was. Every field here is shown in the UI with its
 * plain-English explanation attached.
 */
import type { AdObjective } from '@/lib/db/schema'

export type ChannelType = 'SEARCH' | 'PERFORMANCE_MAX' | 'DEMAND_GEN'

export type BiddingStrategy =
  | 'MAXIMIZE_CONVERSIONS'
  | 'MAXIMIZE_CONVERSION_VALUE'
  | 'MAXIMIZE_CLICKS'
  | 'TARGET_CPA'
  | 'TARGET_ROAS'
  | 'TARGET_IMPRESSION_SHARE'

export type ObjectiveDef = {
  key: AdObjective
  /** What the user picks, in their words. */
  label: string
  /** One line, no jargon. */
  summary: string
  /** What "success" means for this objective — used to prompt for a conversion. */
  conversionPrompt: string
  channelType: ChannelType
  biddingStrategy: BiddingStrategy
  /** Why this bidding strategy, for the explanation panel. */
  biddingReason: string
  /** Whether the strategy takes a target cost-per-result. */
  supportsTargetCpa: boolean
  supportsTargetRoas: boolean
  /**
   * A floor below which a campaign cannot gather enough data to learn. Google's
   * smart bidding needs roughly 30 conversions in 30 days to leave the learning
   * phase; below this the campaign will underperform regardless of the copy.
   */
  suggestedMinDailyBudget: number
  /** Examples shown as placeholder text. */
  examples: string[]
}

export const OBJECTIVES: ObjectiveDef[] = [
  {
    key: 'sales',
    label: 'Sell something online',
    summary: 'Someone finds you, clicks, and buys — a product, a subscription, a booking.',
    conversionPrompt: 'What is the purchase you want people to make?',
    channelType: 'SEARCH',
    biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE',
    biddingReason:
      'Bids toward the highest total revenue rather than the most orders, so a £900 sale is worth chasing harder than a £30 one.',
    supportsTargetCpa: false,
    supportsTargetRoas: true,
    suggestedMinDailyBudget: 30,
    examples: [
      'Sell our annual subscription to UK marketing teams',
      'Get orders for the winter range from customers in London',
    ],
  },
  {
    key: 'leads',
    label: 'Get enquiries',
    summary:
      'Someone fills in a form, calls, or books a demo. You follow up and close the sale yourself.',
    conversionPrompt: 'What should someone do to count as an enquiry?',
    channelType: 'SEARCH',
    biddingStrategy: 'MAXIMIZE_CONVERSIONS',
    biddingReason:
      'Bids toward the most enquiries your budget will buy. Add a target cost per enquiry once you know what one is worth to you.',
    supportsTargetCpa: true,
    supportsTargetRoas: false,
    suggestedMinDailyBudget: 20,
    examples: [
      'Get demo bookings from heads of marketing at UK companies',
      'Get quote requests for commercial roofing in the South East',
    ],
  },
  {
    key: 'traffic',
    label: 'Get people to the website',
    summary:
      'You want visitors — to read something, browse, or get familiar. No specific action required.',
    conversionPrompt: 'Which page do you want people to land on?',
    channelType: 'SEARCH',
    biddingStrategy: 'MAXIMIZE_CLICKS',
    biddingReason:
      'Buys the most visits your budget allows. Cheapest per click, but it does not know a good visitor from a bad one — move to enquiries once you can measure what happens after the click.',
    supportsTargetCpa: false,
    supportsTargetRoas: false,
    suggestedMinDailyBudget: 10,
    examples: ['Drive readers to our research report', 'Get traffic to the new pricing page'],
  },
  {
    key: 'awareness',
    label: 'Get the business known',
    summary:
      'Put the name in front of the right people repeatedly. Slowest to pay off and hardest to measure — pick one of the others first if you can.',
    conversionPrompt: 'Who should be seeing you, and where should they land?',
    channelType: 'DEMAND_GEN',
    biddingStrategy: 'MAXIMIZE_CLICKS',
    biddingReason:
      'Shows the ads to as many relevant people as the budget allows. Judge this on whether searches for your name go up, not on clicks.',
    supportsTargetCpa: false,
    supportsTargetRoas: false,
    suggestedMinDailyBudget: 15,
    examples: ['Introduce the brand to marketing leaders in the UK'],
  },
]

export const OBJECTIVE_BY_KEY = new Map(OBJECTIVES.map((o) => [o.key, o]))

export function objectiveDef(key: AdObjective): ObjectiveDef {
  return OBJECTIVE_BY_KEY.get(key) ?? OBJECTIVES[1]
}

/* ------------------------------------------------------------------ money */

/** Google takes money in micros — millionths of the currency unit. */
export const toMicros = (amount: number): number => Math.round(amount * 1_000_000)
export const fromMicros = (micros: number): number => micros / 1_000_000

/**
 * Google's own published behaviour, stated exactly.
 *
 * A campaign can spend up to twice the average daily budget on any given day to
 * catch traffic spikes, but over a month it will not exceed 30.4× the daily
 * budget — and Google absorbs any overdelivery beyond that rather than billing
 * for it. The UI shows both numbers, because "daily budget" reads to most
 * people like a hard daily cap, and it is not one.
 */
export const MONTHLY_BUDGET_MULTIPLIER = 30.4
export const MAX_DAILY_OVERDELIVERY = 2

export function budgetExplanation(daily: number, currency: string): {
  monthlyMax: number
  dailyMax: number
  sentence: string
} {
  const monthlyMax = daily * MONTHLY_BUDGET_MULTIPLIER
  const dailyMax = daily * MAX_DAILY_OVERDELIVERY
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
  return {
    monthlyMax,
    dailyMax,
    sentence:
      `A busy day can cost up to ${fmt(dailyMax)}, but across a month you will not be charged ` +
      `more than ${fmt(monthlyMax)} — Google absorbs anything above that.`,
  }
}

/* ------------------------------------------------------------ geo targets */

/**
 * Google identifies places by numeric criterion id. A production build would
 * call GeoTargetConstantService to search these; this covers the common cases
 * so the builder works before the API is connected.
 *
 * Ids are from Google's published geo target constants.
 */
export const GEO_PRESETS: { criterionId: string; name: string; group: string }[] = [
  { criterionId: '2826', name: 'United Kingdom', group: 'Country' },
  { criterionId: '2840', name: 'United States', group: 'Country' },
  { criterionId: '2372', name: 'Ireland', group: 'Country' },
  { criterionId: '2276', name: 'Germany', group: 'Country' },
  { criterionId: '2250', name: 'France', group: 'Country' },
  { criterionId: '2528', name: 'Netherlands', group: 'Country' },
  { criterionId: '2724', name: 'Spain', group: 'Country' },
  { criterionId: '2124', name: 'Canada', group: 'Country' },
  { criterionId: '2036', name: 'Australia', group: 'Country' },
  { criterionId: '2784', name: 'United Arab Emirates', group: 'Country' },
  { criterionId: '1006886', name: 'London, England', group: 'City' },
  { criterionId: '1006984', name: 'Manchester, England', group: 'City' },
  { criterionId: '1007115', name: 'Birmingham, England', group: 'City' },
  { criterionId: '1007352', name: 'Edinburgh, Scotland', group: 'City' },
  { criterionId: '20339', name: 'England', group: 'Region' },
  { criterionId: '20340', name: 'Scotland', group: 'Region' },
  { criterionId: '20341', name: 'Wales', group: 'Region' },
]

export const LANGUAGE_PRESETS: { code: string; criterionId: string; name: string }[] = [
  { code: 'en', criterionId: '1000', name: 'English' },
  { code: 'de', criterionId: '1001', name: 'German' },
  { code: 'fr', criterionId: '1002', name: 'French' },
  { code: 'es', criterionId: '1003', name: 'Spanish' },
  { code: 'nl', criterionId: '1010', name: 'Dutch' },
]

/* ------------------------------------------------------------ match types */

export const MATCH_TYPE_HELP: Record<string, string> = {
  EXACT:
    'Shows only for that search and very close variants. Tightest control, smallest reach — use for the terms you know convert.',
  PHRASE:
    'Shows when the search includes your phrase with words around it. A sensible middle ground and the safest default.',
  BROAD:
    'Shows for anything Google judges related, including searches you did not think of. Widest reach and the fastest way to waste money without good negative keywords.',
}
