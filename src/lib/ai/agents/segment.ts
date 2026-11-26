import 'server-only'
import { z } from 'zod'
import { run } from '../gateway'
import { catalogueForPrompt, FIELD_BY_KEY } from '@/lib/targeting/fields'
import type { SegmentRuleGroup } from '@/lib/db/schema'

/**
 * Natural-language audience builder (PRD AT-1, and idea #3 "plain-language
 * operations"). The model's only job is to map a sentence onto the explicit
 * field catalogue. Everything downstream — sizing, reachability, sync — runs on
 * the resulting rules, which the marketer can see and edit.
 */

const ruleSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'within_days', 'exists']),
  value: z.any(),
  label: z.string().optional(),
})

// Recursive schemas need the annotation written out; zod cannot infer through z.lazy.
const groupSchema: z.ZodType<SegmentRuleGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    combinator: z.enum(['and', 'or']),
    rules: z.array(z.union([ruleSchema, groupSchema])),
  }),
) as z.ZodType<SegmentRuleGroup, z.ZodTypeDef, unknown>

const outputSchema = z.object({
  name: z.string(),
  rules: groupSchema,
  /** Plain-English restatement so the marketer can confirm intent. */
  interpretation: z.string(),
  /** Anything in the sentence that could not be expressed. */
  unmapped: z.array(z.string()).default([]),
})

export type InterpretedSegment = z.infer<typeof outputSchema>

export async function interpretAudience(args: {
  workspaceId: string
  userId?: string | null
  query: string
}): Promise<{ result: InterpretedSegment; simulated: boolean }> {
  const system = [
    'You translate a marketer\'s description of an audience into structured segment rules.',
    'You may only use these fields and operators:',
    catalogueForPrompt(),
    '',
    'Rules:',
    '- Never invent a field. Anything you cannot express goes in "unmapped".',
    '- Use within_days with a number for recency ("active in the last 30 days" -> {field:"lastActivityAt",op:"within_days",value:30}).',
    '- Never add consent or suppression rules; the platform enforces those automatically.',
    '- Give every rule a short human label.',
    '- Nest groups only when the sentence genuinely mixes AND and OR.',
    'Return JSON: { name, rules: {combinator, rules[]}, interpretation, unmapped[] }',
  ].join('\n')

  const result = await run({
    agent: 'segment.interpret',
    workspaceId: args.workspaceId,
    userId: args.userId,
    system,
    prompt: `Audience description:\n"""${args.query}"""`,
    schema: outputSchema,
    tier: 'smart',
    temperature: 0.2,
    cacheTtlSeconds: 3600,
    simulate: () => simulateInterpretation(args.query),
  })

  return { result: sanitise(result.data), simulated: result.meta.simulated }
}

/** Drop anything the model produced that is not in the catalogue. */
function sanitise(input: InterpretedSegment): InterpretedSegment {
  const walk = (g: SegmentRuleGroup): SegmentRuleGroup => ({
    combinator: g.combinator,
    rules: g.rules
      .map((r) => ('combinator' in r ? walk(r) : r))
      .filter((r) => ('combinator' in r ? r.rules.length > 0 : FIELD_BY_KEY.has(r.field))),
  })
  return { ...input, rules: walk(input.rules) }
}

/* ------------------------------------------------------------ simulator */

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => { field: string; op: string; value: unknown; label: string } }[] = [
  {
    re: /\b(?:last|past|previous)\s+(\d+)\s+days?\b/i,
    build: (m) => ({ field: 'lastActivityAt', op: 'within_days', value: Number(m[1]), label: `Active in the last ${m[1]} days` }),
  },
  {
    re: /\b(?:last|past)\s+(?:month|30 days)\b/i,
    build: () => ({ field: 'lastActivityAt', op: 'within_days', value: 30, label: 'Active in the last 30 days' }),
  },
  {
    re: /\b(?:more than|over|above|>)\s*(\d[\d,]*)\s*(?:employees|staff|people|headcount)\b/i,
    build: (m) => ({ field: 'employees', op: 'gt', value: Number(m[1].replace(/,/g, '')), label: `More than ${m[1]} employees` }),
  },
  {
    re: /\b(?:fewer than|less than|under|below|<)\s*(\d[\d,]*)\s*(?:employees|staff|people)\b/i,
    build: (m) => ({ field: 'employees', op: 'lt', value: Number(m[1].replace(/,/g, '')), label: `Fewer than ${m[1]} employees` }),
  },
  {
    re: /\b(customers?|churned|leads?|mqls?|sqls?|opportunit(?:y|ies)|subscribers?)\b/i,
    build: (m) => {
      const w = m[1].toLowerCase()
      const stage = w.startsWith('customer')
        ? 'customer'
        : w.startsWith('churn')
          ? 'churned'
          : w.startsWith('mql')
            ? 'mql'
            : w.startsWith('sql')
              ? 'sql'
              : w.startsWith('opportunit')
                ? 'opportunity'
                : w.startsWith('subscriber')
                  ? 'subscriber'
                  : 'lead'
      return { field: 'lifecycleStage', op: 'eq', value: stage, label: `Lifecycle stage is ${stage}` }
    },
  },
  {
    re: /\b(?:in|from|based in)\s+(the\s+)?(uk|united kingdom|britain|us|usa|united states|ireland|germany|france|netherlands|spain|canada|australia|india|singapore)\b/i,
    build: (m) => {
      const map: Record<string, string> = {
        uk: 'GB', 'united kingdom': 'GB', britain: 'GB', us: 'US', usa: 'US', 'united states': 'US',
        ireland: 'IE', germany: 'DE', france: 'FR', netherlands: 'NL', spain: 'ES', canada: 'CA',
        australia: 'AU', india: 'IN', singapore: 'SG',
      }
      const code = map[m[2].toLowerCase()] ?? 'GB'
      return { field: 'country', op: 'eq', value: code, label: `Country is ${code}` }
    },
  },
  {
    re: /\b(saas|e-?commerce|financial services|fintech|healthcare|manufacturing|professional services|education|media)\b/i,
    build: (m) => {
      const raw = m[1].toLowerCase()
      const value = raw === 'fintech' ? 'Financial services' : raw === 'ecommerce' || raw === 'e-commerce' ? 'E-commerce' : raw === 'saas' ? 'SaaS' : raw.replace(/\b\w/g, (c) => c.toUpperCase())
      return { field: 'industry', op: 'eq', value, label: `Industry is ${value}` }
    },
  },
  {
    re: /\b(?:on|using)\s+(?:the\s+)?(trial|starter|growth|enterprise)\s*(?:plan)?\b/i,
    build: (m) => ({ field: 'plan', op: 'eq', value: m[1].toLowerCase(), label: `Plan is ${m[1].toLowerCase()}` }),
  },
  {
    re: /\b(?:highly engaged|high engagement|most engaged)\b/i,
    build: () => ({ field: 'engagementScore', op: 'gte', value: 65, label: 'Engagement score ≥ 65' }),
  },
  {
    re: /\b(?:low engagement|disengaged|inactive|dormant|gone quiet)\b/i,
    build: () => ({ field: 'engagementScore', op: 'lt', value: 30, label: 'Engagement score < 30' }),
  },
  {
    re: /\b(?:head of|director|vp|vice president|chief|c-?level|cmo|manager)\b/i,
    build: (m) => ({ field: 'jobTitle', op: 'contains', value: m[0], label: `Job title contains "${m[0]}"` }),
  },
]

export function simulateInterpretation(query: string): InterpretedSegment {
  const rules: { field: string; op: string; value: unknown; label?: string }[] = []
  const seen = new Set<string>()
  for (const p of PATTERNS) {
    const m = query.match(p.re)
    if (!m) continue
    const rule = p.build(m)
    if (seen.has(rule.field)) continue
    seen.add(rule.field)
    rules.push(rule)
  }

  if (rules.length === 0) {
    rules.push({ field: 'lifecycleStage', op: 'in', value: ['lead', 'mql'], label: 'Lifecycle stage is lead or MQL' })
  }

  const combinator: 'and' | 'or' = /\bor\b/i.test(query) && !/\band\b/i.test(query) ? 'or' : 'and'

  const name =
    query
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .slice(0, 6)
      .join(' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'New segment'

  return {
    name,
    rules: { combinator, rules: rules as SegmentRuleGroup['rules'] },
    interpretation: `Contacts where ${rules.map((r) => r.label).join(combinator === 'and' ? ' AND ' : ' OR ')}. Consent and suppression are applied on top automatically.`,
    unmapped: [],
  }
}
