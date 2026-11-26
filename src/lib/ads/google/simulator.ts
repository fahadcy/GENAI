/**
 * A stand-in for the Google Ads API that behaves like the real one.
 *
 * This is not a stub that returns `{ ok: true }`. Getting a Google developer
 * token approved for live accounts takes a manager account and a manual review
 * that runs for days, and until then a test-level token cannot touch a real
 * account at all. Everything in this platform — building a campaign, reviewing
 * it, approving it, pushing it, seeing what was pushed — has to work in that
 * window, and it has to be honest.
 *
 * So the simulator validates the *built mutate payload*, not the plan. It walks
 * the operation list the same way Google's server does: resolving temporary
 * resource ids, checking that every reference points at something in the same
 * request, enforcing the field-level limits, and failing the whole request
 * atomically on the first error, with an error shape the live client's parser
 * understands. A bug in the payload builder shows up here rather than as a
 * rejected mutate on a client's account.
 *
 * Every simulated push is recorded as `simulated: true` in the audit log and
 * labelled in the UI. It is never presented as a live push.
 */
import { GoogleAdsError, type CallResult, type MutateOperation, type MutateResponse } from './errors'
import { RSA, KEYWORD, CAMPAIGN, glyphLength } from '../validate'

type SimError = { code: string; message: string; field?: string }

/**
 * Deterministic ids. Google's are opaque integers; ours are derived from the
 * request so the same campaign simulated twice produces the same ids, which
 * makes the audit log diffable and the tests stable.
 */
function hashId(seed: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 1_000_000_000 + (Math.abs(h) % 900_000_000)
}

const OPERATION_RESULT_KEY: Record<string, string> = {
  campaignBudgetOperation: 'campaignBudgetResult',
  campaignOperation: 'campaignResult',
  campaignCriterionOperation: 'campaignCriterionResult',
  adGroupOperation: 'adGroupResult',
  adGroupAdOperation: 'adGroupAdResult',
  adGroupCriterionOperation: 'adGroupCriterionResult',
  assetOperation: 'assetResult',
  campaignAssetOperation: 'campaignAssetResult',
}

const RESOURCE_KIND: Record<string, string> = {
  campaignBudgetOperation: 'campaignBudgets',
  campaignOperation: 'campaigns',
  campaignCriterionOperation: 'campaignCriteria',
  adGroupOperation: 'adGroups',
  adGroupAdOperation: 'adGroupAds',
  adGroupCriterionOperation: 'adGroupCriteria',
  assetOperation: 'assets',
  campaignAssetOperation: 'campaignAssets',
}

export type SimulateOptions = {
  customerId: string
  validateOnly?: boolean
  /** Seeds the generated ids. Defaults to the campaign name found in the payload. */
  seed?: string
}

export function simulateMutate(
  operations: MutateOperation[],
  options: SimulateOptions,
): CallResult<MutateResponse> {
  const cid = options.customerId.replace(/\D/g, '')
  const errors: SimError[] = []

  /** Temporary resource name → resolved permanent resource name. */
  const resolved = new Map<string, string>()
  /** Everything created so far, so references can be checked. */
  const created = new Set<string>()

  if (operations.length === 0) {
    throw simError([{ code: 'RequestError.INVALID_OPERATION', message: 'No operations supplied.' }], cid)
  }
  // Google's own ceiling on a single mutate request.
  if (operations.length > 10_000) {
    throw simError(
      [
        {
          code: 'RequestError.TOO_MANY_MUTATE_OPERATIONS',
          message: `${operations.length} operations in one request; the limit is 10000.`,
        },
      ],
      cid,
    )
  }

  const seed =
    options.seed ??
    String(
      (operations.find((o) => 'campaignOperation' in o)?.campaignOperation as { create?: { name?: string } })
        ?.create?.name ?? 'campaign',
    )

  const responses: Record<string, { resourceName?: string }>[] = []

  operations.forEach((operation, index) => {
    const [opKey, opValue] = Object.entries(operation)[0] ?? []
    if (!opKey || !OPERATION_RESULT_KEY[opKey]) {
      errors.push({
        code: 'RequestError.UNKNOWN_OPERATION',
        message: `Operation ${index + 1} is of an unknown type "${opKey}".`,
        field: `mutateOperations[${index}]`,
      })
      return
    }

    const create = (opValue as { create?: Record<string, unknown> })?.create
    if (!create) {
      errors.push({
        code: 'RequestError.OPERATION_NOT_SET',
        message: `Operation ${index + 1} has no create payload.`,
        field: `mutateOperations[${index}]`,
      })
      return
    }

    const field = `mutateOperations[${index}].${opKey}.create`
    checkOperation(opKey, create, field, errors)
    checkReferences(create, field, resolved, created, errors)

    const temp = typeof create.resourceName === 'string' ? create.resourceName : null
    const permanent = `customers/${cid}/${RESOURCE_KIND[opKey]}/${hashId(seed, index)}`
    if (temp) resolved.set(temp, permanent)
    created.add(permanent)

    responses.push({ [OPERATION_RESULT_KEY[opKey]]: { resourceName: permanent } })
  })

  if (errors.length > 0) throw simError(errors, cid)

  // validateOnly means Google checks and creates nothing — and, importantly,
  // returns no resource names. Mirroring that keeps callers honest.
  return {
    data: options.validateOnly ? {} : { mutateOperationResponses: responses },
    requestId: `sim-${hashId(seed, operations.length).toString(36)}`,
    status: 200,
  }
}

/* ------------------------------------------------------------ field checks */

function checkOperation(
  opKey: string,
  create: Record<string, unknown>,
  field: string,
  errors: SimError[],
): void {
  switch (opKey) {
    case 'campaignBudgetOperation': {
      const micros = Number(create.amountMicros)
      if (!Number.isFinite(micros) || micros <= 0) {
        errors.push({
          code: 'CampaignBudgetError.INVALID_BUDGET_AMOUNT',
          message: 'The budget amount must be greater than zero.',
          field: `${field}.amountMicros`,
        })
      } else if (micros % 10_000 !== 0) {
        // Google rounds to the nearest 0.01 of the account currency.
        errors.push({
          code: 'CampaignBudgetError.NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT',
          message: 'Budget amounts must be a whole number of currency units in micros.',
          field: `${field}.amountMicros`,
        })
      }
      if (!create.name) {
        errors.push({
          code: 'CampaignBudgetError.BUDGET_NAME_REQUIRED',
          message: 'A budget needs a name.',
          field: `${field}.name`,
        })
      }
      break
    }

    case 'campaignOperation': {
      const name = String(create.name ?? '')
      if (!name) {
        errors.push({
          code: 'CampaignError.MISSING_REQUIRED_FIELD',
          message: 'A campaign needs a name.',
          field: `${field}.name`,
        })
      } else if (glyphLength(name) > CAMPAIGN.nameChars) {
        errors.push({
          code: 'StringLengthError.TOO_LONG',
          message: `Campaign name is ${glyphLength(name)} characters; the limit is ${CAMPAIGN.nameChars}.`,
          field: `${field}.name`,
        })
      }
      if (!create.campaignBudget) {
        errors.push({
          code: 'CampaignError.BUDGET_REQUIRED',
          message: 'A campaign must reference a budget.',
          field: `${field}.campaignBudget`,
        })
      }
      const start = String(create.startDate ?? '')
      if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        errors.push({
          code: 'DateError.INVALID_FIELD_VALUES_IN_DATE',
          message: `"${start}" is not a valid date. Google expects YYYY-MM-DD.`,
          field: `${field}.startDate`,
        })
      }
      const end = String(create.endDate ?? '')
      if (end && start && end < start) {
        errors.push({
          code: 'CampaignError.START_DATE_AFTER_END_DATE',
          message: 'The end date is before the start date.',
          field: `${field}.endDate`,
        })
      }
      const strategies = [
        'maximizeConversions',
        'maximizeConversionValue',
        'targetCpa',
        'targetRoas',
        'targetSpend',
        'manualCpc',
      ].filter((k) => k in create)
      if (strategies.length === 0) {
        errors.push({
          code: 'CampaignError.BIDDING_STRATEGY_REQUIRED',
          message: 'A campaign needs a bidding strategy.',
          field,
        })
      } else if (strategies.length > 1) {
        errors.push({
          code: 'CampaignError.CANNOT_SET_BOTH_BIDDING_STRATEGIES',
          message: `Two bidding strategies were set (${strategies.join(', ')}). Only one is allowed.`,
          field,
        })
      }
      break
    }

    case 'adGroupOperation': {
      if (!create.name) {
        errors.push({
          code: 'AdGroupError.MISSING_REQUIRED_FIELD',
          message: 'An ad group needs a name.',
          field: `${field}.name`,
        })
      }
      if (!create.campaign) {
        errors.push({
          code: 'AdGroupError.MISSING_REQUIRED_FIELD',
          message: 'An ad group must reference a campaign.',
          field: `${field}.campaign`,
        })
      }
      break
    }

    case 'adGroupAdOperation': {
      const ad = create.ad as
        | { finalUrls?: string[]; responsiveSearchAd?: { headlines?: { text: string }[]; descriptions?: { text: string }[]; path1?: string; path2?: string } }
        | undefined
      const rsa = ad?.responsiveSearchAd
      if (!ad) {
        errors.push({ code: 'AdError.MISSING_AD', message: 'No ad supplied.', field: `${field}.ad` })
        break
      }
      if (!ad.finalUrls?.length) {
        errors.push({
          code: 'AdError.MISSING_DESTINATION_URL_TAG',
          message: 'An ad needs a final URL.',
          field: `${field}.ad.finalUrls`,
        })
      } else {
        for (const url of ad.finalUrls) {
          if (!/^https?:\/\/\S+\.\S+/.test(url)) {
            errors.push({
              code: 'UrlFieldError.INVALID_URL',
              message: `"${url}" is not a valid destination URL.`,
              field: `${field}.ad.finalUrls`,
            })
          }
        }
      }
      if (!rsa) {
        errors.push({
          code: 'AdError.AD_TYPE_CANNOT_BE_CREATED',
          message: 'Only responsive search ads are supported here.',
          field: `${field}.ad`,
        })
        break
      }
      const headlines = rsa.headlines ?? []
      const descriptions = rsa.descriptions ?? []
      if (headlines.length < RSA.headlineMin || headlines.length > RSA.headlineMax) {
        errors.push({
          code: 'AdError.INVALID_NUMBER_OF_ELEMENTS',
          message: `A responsive search ad needs between ${RSA.headlineMin} and ${RSA.headlineMax} headlines; this one has ${headlines.length}.`,
          field: `${field}.ad.responsiveSearchAd.headlines`,
        })
      }
      if (descriptions.length < RSA.descriptionMin || descriptions.length > RSA.descriptionMax) {
        errors.push({
          code: 'AdError.INVALID_NUMBER_OF_ELEMENTS',
          message: `A responsive search ad needs between ${RSA.descriptionMin} and ${RSA.descriptionMax} descriptions; this one has ${descriptions.length}.`,
          field: `${field}.ad.responsiveSearchAd.descriptions`,
        })
      }
      headlines.forEach((h, i) => {
        if (glyphLength(h.text ?? '') > RSA.headlineChars) {
          errors.push({
            code: 'StringLengthError.TOO_LONG',
            message: `Headline ${i + 1} is ${glyphLength(h.text)} characters; the limit is ${RSA.headlineChars}.`,
            field: `${field}.ad.responsiveSearchAd.headlines[${i}].text`,
          })
        }
        if ((h.text ?? '').includes('!')) {
          errors.push({
            code: 'PolicyViolationError.POLICY_ERROR',
            message: `Headline ${i + 1} contains an exclamation mark, which Google does not allow in headlines.`,
            field: `${field}.ad.responsiveSearchAd.headlines[${i}].text`,
          })
        }
      })
      descriptions.forEach((d, i) => {
        if (glyphLength(d.text ?? '') > RSA.descriptionChars) {
          errors.push({
            code: 'StringLengthError.TOO_LONG',
            message: `Description ${i + 1} is ${glyphLength(d.text)} characters; the limit is ${RSA.descriptionChars}.`,
            field: `${field}.ad.responsiveSearchAd.descriptions[${i}].text`,
          })
        }
      })
      const seen = new Set<string>()
      headlines.forEach((h, i) => {
        const key = (h.text ?? '').trim().toLowerCase()
        if (seen.has(key)) {
          errors.push({
            code: 'AdError.DUPLICATE_ASSET',
            message: `Headline ${i + 1} duplicates an earlier headline.`,
            field: `${field}.ad.responsiveSearchAd.headlines[${i}].text`,
          })
        }
        seen.add(key)
      })
      for (const [key, value] of [
        ['path1', rsa.path1],
        ['path2', rsa.path2],
      ] as const) {
        if (value && glyphLength(value) > RSA.pathChars) {
          errors.push({
            code: 'StringLengthError.TOO_LONG',
            message: `Display path is ${glyphLength(value)} characters; the limit is ${RSA.pathChars}.`,
            field: `${field}.ad.responsiveSearchAd.${key}`,
          })
        }
      }
      if (rsa.path2 && !rsa.path1) {
        errors.push({
          code: 'AdError.CANNOT_SET_PATH2_WITHOUT_PATH1',
          message: 'The second display path cannot be set without the first.',
          field: `${field}.ad.responsiveSearchAd.path2`,
        })
      }
      break
    }

    case 'adGroupCriterionOperation':
    case 'campaignCriterionOperation': {
      const keyword = create.keyword as { text?: string; matchType?: string } | undefined
      if (keyword) {
        const text = keyword.text ?? ''
        if (!text.trim()) {
          errors.push({
            code: 'CriterionError.INVALID_KEYWORD_TEXT',
            message: 'A keyword cannot be empty.',
            field: `${field}.keyword.text`,
          })
        }
        if (glyphLength(text) > KEYWORD.maxChars) {
          errors.push({
            code: 'CriterionError.KEYWORD_TEXT_TOO_LONG',
            message: `"${text}" is ${glyphLength(text)} characters; the keyword limit is ${KEYWORD.maxChars}.`,
            field: `${field}.keyword.text`,
          })
        }
        if (text.split(/\s+/).filter(Boolean).length > KEYWORD.maxWords) {
          errors.push({
            code: 'CriterionError.KEYWORD_HAS_TOO_MANY_WORDS',
            message: `"${text}" has more than ${KEYWORD.maxWords} words.`,
            field: `${field}.keyword.text`,
          })
        }
        if (/[!@%,*]/.test(text)) {
          errors.push({
            code: 'CriterionError.KEYWORD_HAS_INVALID_CHARS',
            message: `"${text}" contains a character keywords cannot include.`,
            field: `${field}.keyword.text`,
          })
        }
        if (!['EXACT', 'PHRASE', 'BROAD'].includes(String(keyword.matchType))) {
          errors.push({
            code: 'CriterionError.INVALID_KEYWORD_MATCH_TYPE',
            message: `"${keyword.matchType}" is not a valid match type.`,
            field: `${field}.keyword.matchType`,
          })
        }
      }
      const hasCriterion = ['keyword', 'location', 'language', 'ageRange', 'gender', 'audience'].some(
        (k) => k in create,
      )
      if (!hasCriterion) {
        errors.push({
          code: 'CriterionError.CANNOT_ADD_CRITERIA_TYPE',
          message: 'The criterion has no type set.',
          field,
        })
      }
      break
    }

    case 'assetOperation': {
      const sitelink = create.sitelinkAsset as { linkText?: string } | undefined
      const callout = create.calloutAsset as { calloutText?: string } | undefined
      if (sitelink) {
        if (!sitelink.linkText?.trim()) {
          errors.push({
            code: 'AssetError.FIELD_REQUIRED',
            message: 'A sitelink needs link text.',
            field: `${field}.sitelinkAsset.linkText`,
          })
        } else if (glyphLength(sitelink.linkText) > CAMPAIGN.sitelinkTextChars) {
          errors.push({
            code: 'StringLengthError.TOO_LONG',
            message: `Sitelink text is ${glyphLength(sitelink.linkText)} characters; the limit is ${CAMPAIGN.sitelinkTextChars}.`,
            field: `${field}.sitelinkAsset.linkText`,
          })
        }
        if (!(create.finalUrls as string[] | undefined)?.length) {
          errors.push({
            code: 'AssetError.FIELD_REQUIRED',
            message: 'A sitelink needs a destination URL.',
            field: `${field}.finalUrls`,
          })
        }
      } else if (callout) {
        if (glyphLength(callout.calloutText ?? '') > CAMPAIGN.calloutChars) {
          errors.push({
            code: 'StringLengthError.TOO_LONG',
            message: `Callout is ${glyphLength(callout.calloutText ?? '')} characters; the limit is ${CAMPAIGN.calloutChars}.`,
            field: `${field}.calloutAsset.calloutText`,
          })
        }
      } else {
        errors.push({
          code: 'AssetError.ASSET_TYPE_CANNOT_BE_CREATED',
          message: 'Unsupported asset type.',
          field,
        })
      }
      break
    }
  }
}

/**
 * Every reference to another entity must point either at a temporary id
 * created earlier in this same request, or at a real resource name. Google
 * enforces this and the resulting error is famously opaque; catching it here
 * means a mis-ordered operation list fails in the simulator with the operation
 * index attached.
 */
function checkReferences(
  create: Record<string, unknown>,
  field: string,
  resolved: Map<string, string>,
  created: Set<string>,
  errors: SimError[],
): void {
  for (const key of ['campaignBudget', 'campaign', 'adGroup', 'asset']) {
    const value = create[key]
    if (typeof value !== 'string') continue
    const isTemp = /\/-\d+$/.test(value)
    if (isTemp && !resolved.has(value)) {
      errors.push({
        code: 'MutateError.RESOURCE_NOT_FOUND',
        message: `This references "${value}", which is not created earlier in the request. Operations must appear after the things they depend on.`,
        field: `${field}.${key}`,
      })
    } else if (!isTemp && !created.has(value) && !/^customers\/\d+\//.test(value)) {
      errors.push({
        code: 'MutateError.RESOURCE_NOT_FOUND',
        message: `"${value}" is not a valid resource name.`,
        field: `${field}.${key}`,
      })
    }
  }
}

function simError(errors: SimError[], customerId: string): GoogleAdsError {
  const summary =
    errors.length === 1
      ? errors[0].message
      : `${errors.length} problems would stop this campaign being created. The first is: ${errors[0].message}`
  return new GoogleAdsError(summary, {
    status: 400,
    requestId: `sim-${customerId}`,
    errors,
    retryable: false,
    raw: { simulated: true, errors },
  })
}

/** Mirrors the shape of `setCampaignStatus` for the simulated path. */
export function simulateStatusChange(
  campaignResourceName: string,
  status: 'ENABLED' | 'PAUSED',
): CallResult<MutateResponse> {
  if (!/^customers\/\d+\/campaigns\/\d+$/.test(campaignResourceName)) {
    throw new GoogleAdsError('That campaign does not exist in Google.', {
      status: 404,
      errors: [{ code: 'MutateError.RESOURCE_NOT_FOUND', message: campaignResourceName }],
      retryable: false,
    })
  }
  return {
    data: { mutateOperationResponses: [{ campaignResult: { resourceName: campaignResourceName } }] },
    requestId: `sim-status-${status.toLowerCase()}`,
    status: 200,
  }
}
