/**
 * The budget catalogue: every kind of marketing money, not just ad platforms.
 *
 * "Budget for everything" means the allocator has to hold a line for the
 * agency retainer and the trade-show stand as well as for Google Ads. Lines
 * with tracked outcomes get response curves and are optimised; lines without
 * keep their planned amount within their limits, and still take part in
 * pacing and in the card reconciliation.
 *
 * Merchant descriptors come from the research (docs: "Budget Allocator —
 * research"). Only Google officially documents its descriptor and prints the
 * 10-digit customer id in it; the others are from secondary sources and are
 * deliberately loose. Users teach the classifier the rest (merchant rules).
 */
import type { LineCategory } from './types'

export type OverdeliveryRule = {
  /** A single day may spend up to this multiple of the daily budget. */
  dailyMultiple: number
  /** Over a calendar month, spend never exceeds this multiple of the daily budget. */
  monthlyMultipleOfDaily?: number
  /** Over a calendar week (Mon–Sun), spend never exceeds this multiple of the daily budget. */
  weeklyMultipleOfDaily?: number
  source: string
}

export type ChannelDef = {
  key: string
  label: string
  category: LineCategory
  /** GenAI's own metric channel, where outcomes are already tracked. */
  metricChannel?: string
  /** Card descriptor patterns, case-insensitive. */
  merchants?: RegExp[]
  overdelivery?: OverdeliveryRule
  /** Typical billing behaviour, for reconciliation and the cash forecast. */
  billing?: { thresholdPence: number | null; currency: string; vatRate: number; settlementLagDays: number }
  description: string
}

export const GOOGLE_OVERDELIVERY: OverdeliveryRule = {
  dailyMultiple: 2,
  monthlyMultipleOfDaily: 30.4,
  source: 'Google Ads Help: a campaign can spend up to 2× its average daily budget on a day, and no more than 30.4× it in a month.',
}

export const META_OVERDELIVERY: OverdeliveryRule = {
  dailyMultiple: 1.75,
  weeklyMultipleOfDaily: 7,
  source: 'Meta (reported by Jon Loomer, Mar 2025; Meta Help could not be checked): a daily budget can spend up to 75% more on a day, and no more than 7× it over a calendar week.',
}

export const CHANNELS: ChannelDef[] = [
  /* --------------------------------------------------------- paid media */
  {
    key: 'google_ads',
    label: 'Google Ads',
    category: 'paid_media',
    metricChannel: 'google_ads',
    merchants: [/GOOGLE\s*\*\s*(GOOG|SVCS|ADS)/i, /GOOGLE\s+ADS/i, /GOOGLE\s+LTD.*ADVERTIS/i, /^GOOGLE_/i],
    overdelivery: GOOGLE_OVERDELIVERY,
    billing: { thresholdPence: 50_000, currency: 'GBP', vatRate: 0, settlementLagDays: 2 },
    description: 'Search, Performance Max, YouTube and Demand Gen.',
  },
  {
    key: 'meta_ads',
    label: 'Meta Ads',
    category: 'paid_media',
    metricChannel: 'meta_ads',
    merchants: [/FACEBK\s*\*/i, /\bFACEBOOK\b/i, /\bMETA\s*(PLATFORMS|ADS)\b/i, /\bFB\s*\*?\s*ADS\b/i],
    overdelivery: META_OVERDELIVERY,
    billing: { thresholdPence: 40_000, currency: 'GBP', vatRate: 0, settlementLagDays: 2 },
    description: 'Facebook and Instagram.',
  },
  {
    key: 'linkedin_ads',
    label: 'LinkedIn Ads',
    category: 'paid_media',
    metricChannel: 'linkedin',
    merchants: [/LINKEDIN\s*\*?\s*ADS/i, /\bLNKD\s*\*/i, /LINKEDIN\s+IRELAND/i],
    overdelivery: {
      dailyMultiple: 1.5,
      source: 'LinkedIn (reported by B2Linked; LinkedIn Help could not be checked): a daily budget can overspend by up to 50% on a day.',
    },
    billing: { thresholdPence: 25_000, currency: 'GBP', vatRate: 0, settlementLagDays: 2 },
    description: 'Sponsored content and lead gen forms.',
  },
  {
    key: 'tiktok_ads',
    label: 'TikTok Ads',
    category: 'paid_media',
    merchants: [/TIKTOK/i],
    billing: { thresholdPence: 30_000, currency: 'GBP', vatRate: 0, settlementLagDays: 2 },
    description: 'In-feed and Spark ads.',
  },
  {
    key: 'microsoft_ads',
    label: 'Microsoft Ads',
    category: 'paid_media',
    merchants: [/MICROSOFT\s*\*\s*ADS/i, /BING\s*ADS/i, /MSFT\s*\*\s*(ADV|BING)/i],
    billing: { thresholdPence: 25_000, currency: 'GBP', vatRate: 0, settlementLagDays: 2 },
    description: 'Bing search and the Microsoft audience network.',
  },

  /* -------------------------------------------------------------- owned */
  {
    key: 'email',
    label: 'Email',
    category: 'owned',
    metricChannel: 'email',
    merchants: [/SENDGRID/i, /MAILCHIMP|INTUIT\s*\*\s*MAILCHIMP/i, /KLAVIYO/i],
    description: 'Sending costs and list tools.',
  },
  {
    key: 'seo_content',
    label: 'SEO and content',
    category: 'owned',
    metricChannel: 'blog',
    merchants: [/SEMRUSH/i, /AHREFS/i, /DATAFORSEO/i, /SERPAPI/i],
    description: 'Articles, landing pages and search tools.',
  },
  {
    key: 'social_organic',
    label: 'Organic social',
    category: 'owned',
    merchants: [/HOOTSUITE/i, /BUFFER/i, /SPROUT\s*SOCIAL/i],
    description: 'Community management and scheduling tools.',
  },
  {
    key: 'sms',
    label: 'SMS',
    category: 'owned',
    metricChannel: 'sms',
    merchants: [/CLICKSEND/i, /TWILIO/i],
    description: 'Text messages, charged per send.',
  },

  /* ----------------------------------------------------------- production */
  {
    key: 'video_production',
    label: 'Video production',
    category: 'production',
    merchants: [/RUNWAY/i, /VIMEO/i, /ENVATO/i],
    description: 'Shoots, editing, and generated video (GenAI Video Studio lands here).',
  },
  {
    key: 'creative_design',
    label: 'Creative and design',
    category: 'production',
    merchants: [/CANVA/i, /ADOBE/i, /FIGMA/i, /SHUTTERSTOCK|GETTY/i],
    description: 'Design tools, stock and photography.',
  },

  /* ---------------------------------------------------------------- ai */
  {
    key: 'ai_generation',
    label: 'AI generation',
    category: 'ai',
    merchants: [/OPENAI/i, /ANTHROPIC/i, /GOOGLE\s*\*\s*CLOUD/i],
    description: 'Model usage. GenAI’s own generation cost is counted here automatically.',
  },

  /* -------------------------------------------------------------- tools */
  {
    key: 'tools_saas',
    label: 'Tools and subscriptions',
    category: 'tools',
    merchants: [/HUBSPOT/i, /HOTJAR/i, /CALENDLY/i, /ZAPIER/i, /NOTION/i, /SLACK/i],
    description: 'CRM, analytics and workflow software.',
  },

  /* ------------------------------------------------------------- people */
  {
    key: 'agency',
    label: 'Agency fees',
    category: 'people',
    description: 'Retainers and project fees, usually invoiced rather than on the card.',
  },
  {
    key: 'freelancers',
    label: 'Freelancers',
    category: 'people',
    merchants: [/UPWORK/i, /FIVERR/i, /PEOPLEPERHOUR/i],
    description: 'Copywriters, designers, editors.',
  },

  /* ------------------------------------------------------------- events */
  {
    key: 'events',
    label: 'Events and sponsorship',
    category: 'events',
    merchants: [/EVENTBRITE/i, /\bEXPO\b/i, /CONFERENCE/i],
    description: 'Stands, tickets, travel and sponsorship.',
  },

  /* ------------------------------------------------------------ offline */
  {
    key: 'print_ooh',
    label: 'Print and out-of-home',
    category: 'offline',
    merchants: [/VISTAPRINT/i, /MOO\s*PRINT|\bMOO\.COM/i, /SOLOPRESS/i],
    description: 'Leaflets, direct mail, posters, radio.',
  },

  /* ------------------------------------------------------------ reserve */
  {
    key: 'contingency',
    label: 'Contingency',
    category: 'reserve',
    description: 'Held back on purpose, for opportunities and overruns.',
  },
]

const BY_KEY = new Map(CHANNELS.map((c) => [c.key, c]))

export function channelDef(key: string): ChannelDef | undefined {
  return BY_KEY.get(key)
}

export function channelLabelFor(key: string | null | undefined): string {
  if (!key) return 'Unassigned'
  return BY_KEY.get(key)?.label ?? key.replace(/_/g, ' ')
}

export const CATEGORY_LABEL: Record<LineCategory, string> = {
  paid_media: 'Paid media',
  owned: 'Owned channels',
  production: 'Production',
  tools: 'Tools',
  ai: 'AI',
  people: 'People',
  events: 'Events',
  offline: 'Offline',
  reserve: 'Reserve',
}

/** Starter split for a new plan, by share of total. A starting point, not advice. */
export const STARTER_SPLIT: { key: string; share: number }[] = [
  { key: 'google_ads', share: 0.3 },
  { key: 'meta_ads', share: 0.18 },
  { key: 'linkedin_ads', share: 0.08 },
  { key: 'email', share: 0.04 },
  { key: 'seo_content', share: 0.1 },
  { key: 'video_production', share: 0.06 },
  { key: 'creative_design', share: 0.04 },
  { key: 'ai_generation', share: 0.03 },
  { key: 'tools_saas', share: 0.07 },
  { key: 'events', share: 0.05 },
  { key: 'contingency', share: 0.05 },
]
