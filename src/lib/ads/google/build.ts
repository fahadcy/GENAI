/**
 * Turns a reviewed campaign plan into the exact Google Ads mutate payload.
 *
 * Deliberately pure: no database, no network, no `server-only`. That lets the
 * tests assert on the payload directly, lets the UI show a user the literal
 * request that is about to be sent, and lets the simulator run the identical
 * code path the live push uses — so what a client approves in simulation is
 * byte-for-byte what Google eventually receives.
 *
 * Everything is built as one atomic operation list linked by temporary
 * resource ids (Google's convention: negative integers). Either the whole
 * campaign appears in the account, or none of it does.
 */
import type { AdCampaignStructure } from '@/lib/db/schema'
import type { BiddingStrategy, ChannelType } from '../objectives'
import type { MutateOperation } from './errors'

export type BuildInput = {
  customerId: string
  campaignName: string
  channelType: ChannelType
  biddingStrategy: BiddingStrategy
  dailyBudgetMicros: number
  targetCpaMicros?: number | null
  targetRoas?: number | null
  /** YYYY-MM-DD. Google refuses a start date in the past. */
  startDate: string
  endDate?: string | null
  /** Numeric geo target criterion ids. */
  geoTargets: string[]
  /** Numeric language criterion ids. */
  languages: string[]
  finalUrl: string
  /** Full resource name of a conversion action, when one was chosen. */
  conversionAction?: string | null
  structure: AdCampaignStructure
  /**
   * Always PAUSED on first push. A campaign that goes live the moment someone
   * clicks "publish" is how people wake up to a spent budget; enabling is a
   * separate, explicit action with the money spelled out.
   */
  status?: 'PAUSED' | 'ENABLED'
}

/** Google's temporary-id convention. Each entity gets its own negative id. */
const TEMP = {
  budget: -1,
  campaign: -2,
  /** Ad groups and their children start here and count down. */
  firstAdGroup: -10,
  firstAsset: -1000,
} as const

const res = (customerId: string, kind: string, id: number | string) =>
  `customers/${customerId}/${kind}/${id}`

/** Google rejects a start date before today in the account's time zone. */
export function todayInTimeZone(timeZone: string, now = new Date()): string {
  // en-CA gives YYYY-MM-DD, which is exactly the format Google wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(now)
}

/**
 * Bidding strategy as Google models it: a oneof field on the campaign, not an
 * enum. Getting this wrong is the single most common cause of a rejected
 * mutate, so the mapping lives in one place with the objective table.
 */
function biddingFields(input: BuildInput): Record<string, unknown> {
  switch (input.biddingStrategy) {
    case 'MAXIMIZE_CONVERSION_VALUE':
      return { maximizeConversionValue: input.targetRoas ? { targetRoas: input.targetRoas } : {} }
    case 'MAXIMIZE_CONVERSIONS':
      return {
        maximizeConversions: input.targetCpaMicros
          ? { targetCpaMicros: String(input.targetCpaMicros) }
          : {},
      }
    case 'TARGET_CPA':
      return { targetCpa: { targetCpaMicros: String(input.targetCpaMicros ?? 0) } }
    case 'TARGET_ROAS':
      return { targetRoas: { targetRoas: input.targetRoas ?? 1 } }
    case 'MAXIMIZE_CLICKS':
    default:
      // Google's "Maximize clicks" is TargetSpend. Left uncapped: a bid ceiling
      // here quietly starves the campaign, and the daily budget is the real cap.
      return { targetSpend: {} }
  }
}

/**
 * Search partners and the Display network are on by default when you create a
 * campaign through the API, and they spend a meaningful share of the budget on
 * traffic that converts far worse. We turn them off; someone who wants them can
 * switch them on knowing what they are.
 */
function networkSettings(channelType: ChannelType): Record<string, unknown> | undefined {
  if (channelType !== 'SEARCH') return undefined
  return {
    targetGoogleSearch: true,
    targetSearchNetwork: false,
    targetContentNetwork: false,
    targetPartnerSearchNetwork: false,
  }
}

export function buildCampaignOperations(input: BuildInput): MutateOperation[] {
  const cid = input.customerId.replace(/\D/g, '')
  const ops: MutateOperation[] = []

  const budgetName = `${input.campaignName} — budget`
  const budgetRes = res(cid, 'campaignBudgets', TEMP.budget)
  const campaignRes = res(cid, 'campaigns', TEMP.campaign)

  /* 1. Budget ------------------------------------------------------------- */
  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: budgetRes,
        name: budgetName,
        amountMicros: String(input.dailyBudgetMicros),
        deliveryMethod: 'STANDARD',
        // Not shared: a shared budget means changing this campaign silently
        // changes others, which is impossible to reason about later.
        explicitlyShared: false,
      },
    },
  })

  /* 2. Campaign ----------------------------------------------------------- */
  const campaign: Record<string, unknown> = {
    resourceName: campaignRes,
    name: input.campaignName,
    status: input.status ?? 'PAUSED',
    advertisingChannelType: input.channelType,
    campaignBudget: budgetRes,
    startDate: input.startDate,
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...biddingFields(input),
  }
  const nets = networkSettings(input.channelType)
  if (nets) campaign.networkSettings = nets
  if (input.conversionAction) {
    campaign.selectiveOptimization = { conversionActions: [input.conversionAction] }
  }
  ops.push({ campaignOperation: { create: campaign } })

  /* 3. Where and in what language ---------------------------------------- */
  for (const geo of input.geoTargets) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: campaignRes, location: { geoTargetConstant: `geoTargetConstants/${geo}` } },
      },
    })
  }
  for (const lang of input.languages) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: campaignRes, language: { languageConstant: `languageConstants/${lang}` } },
      },
    })
  }

  /* 4. Negative keywords — campaign-wide, so they cover every ad group ----- */
  for (const neg of input.structure.negativeKeywords) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignRes,
          negative: true,
          keyword: { text: neg.text, matchType: normaliseMatchType(neg.matchType) },
        },
      },
    })
  }

  /* 5. Ad groups, their ads, their keywords ------------------------------- */
  let nextId = TEMP.firstAdGroup
  for (const group of input.structure.adGroups) {
    const adGroupRes = res(cid, 'adGroups', nextId--)

    ops.push({
      adGroupOperation: {
        create: {
          resourceName: adGroupRes,
          name: group.name,
          campaign: campaignRes,
          status: 'ENABLED',
          type: input.channelType === 'SEARCH' ? 'SEARCH_STANDARD' : 'DEMAND_GEN_AD',
        },
      },
    })

    for (const ad of group.ads) {
      ops.push({
        adGroupAdOperation: {
          create: {
            adGroup: adGroupRes,
            status: 'ENABLED',
            ad: {
              finalUrls: [input.finalUrl],
              responsiveSearchAd: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
                ...(ad.path1 ? { path1: ad.path1 } : {}),
                ...(ad.path2 ? { path2: ad.path2 } : {}),
              },
            },
          },
        },
      })
    }

    for (const kw of group.keywords) {
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: adGroupRes,
            status: 'ENABLED',
            keyword: { text: kw.text, matchType: normaliseMatchType(kw.matchType) },
          },
        },
      })
    }
  }

  /* 6. Extensions — free extra space on the results page ------------------ */
  let assetId = TEMP.firstAsset
  for (const link of input.structure.sitelinks) {
    const assetRes = res(cid, 'assets', assetId--)
    ops.push({
      assetOperation: {
        create: {
          resourceName: assetRes,
          finalUrls: [link.finalUrl || input.finalUrl],
          sitelinkAsset: {
            linkText: link.text,
            ...(link.description1 ? { description1: link.description1 } : {}),
            ...(link.description2 ? { description2: link.description2 } : {}),
          },
        },
      },
    })
    ops.push({
      campaignAssetOperation: {
        create: { campaign: campaignRes, asset: assetRes, fieldType: 'SITELINK' },
      },
    })
  }

  for (const callout of input.structure.callouts) {
    const assetRes = res(cid, 'assets', assetId--)
    ops.push({ assetOperation: { create: { resourceName: assetRes, calloutAsset: { calloutText: callout } } } })
    ops.push({
      campaignAssetOperation: {
        create: { campaign: campaignRes, asset: assetRes, fieldType: 'CALLOUT' },
      },
    })
  }

  return ops
}

export function normaliseMatchType(value: string): 'EXACT' | 'PHRASE' | 'BROAD' {
  const upper = value.trim().toUpperCase()
  return upper === 'EXACT' || upper === 'BROAD' ? upper : 'PHRASE'
}

/**
 * Pulls the created resource names back out of a mutate response so we can
 * store them. Google returns them positionally, in the order operations were
 * sent, each wrapped in a key named after the operation.
 */
export function readMutateResponse(
  response: { mutateOperationResponses?: Record<string, { resourceName?: string }>[] } | undefined,
): { campaign?: string; budget?: string; adGroups: string[]; ads: string[]; criteria: string[] } {
  const out = { campaign: undefined as string | undefined, budget: undefined as string | undefined, adGroups: [] as string[], ads: [] as string[], criteria: [] as string[] }

  for (const entry of response?.mutateOperationResponses ?? []) {
    for (const [key, value] of Object.entries(entry)) {
      const name = value?.resourceName
      if (!name) continue
      if (key.startsWith('campaignBudget')) out.budget = name
      else if (key.startsWith('campaignResult') || key === 'campaignResult') out.campaign = name
      else if (key.startsWith('adGroupAd')) out.ads.push(name)
      else if (key.startsWith('adGroupCriterion') || key.startsWith('campaignCriterion')) out.criteria.push(name)
      else if (key.startsWith('adGroup')) out.adGroups.push(name)
      else if (key.startsWith('campaign')) out.campaign ??= name
    }
  }
  return out
}
