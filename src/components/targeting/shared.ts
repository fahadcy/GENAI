import { FIELDS, FIELD_BY_KEY, OPERATORS, type FieldDef } from '@/lib/targeting/fields'
import type { SegmentRule, SegmentRuleGroup } from '@/lib/db/schema'

/**
 * Client-safe helpers for the targeting surface.
 *
 * `@/lib/targeting/engine` is `server-only`, so the rule editor cannot use its
 * describe/compile helpers. Anything the browser needs lives here instead, and
 * the two summarisers are kept deliberately in step with `describeRule`.
 */

export const isGroup = (r: SegmentRule | SegmentRuleGroup): r is SegmentRuleGroup => 'combinator' in r

/**
 * `suppressed` is in the field catalogue but never offered as a rule: the
 * engine enforces it on every evaluation, so exposing it would imply it is
 * optional (AT-5).
 */
export const SELECTABLE_FIELDS: FieldDef[] = FIELDS.filter((f) => f.key !== 'suppressed')

/** The channels `evaluateRules` reports on by default — what the live preview shows. */
export const PREVIEW_CHANNELS = ['email', 'linkedin', 'google_ads', 'sms'] as const

/** Channels a segment can be pushed to. */
export const SYNC_CHANNELS = ['email', 'linkedin', 'google_ads', 'meta_ads', 'sms'] as const

/**
 * Which connector actually carries the push. Mirrors the routing inside
 * `syncSegmentAction` so the UI never promises a destination the action will
 * not use.
 */
export function providerForChannel(channel: string): string {
  return channel === 'google_ads' ? 'google_ads' : channel === 'meta_ads' ? 'meta_ads' : 'hubspot_crm'
}

/** The consent flag each channel is gated on, mirroring the engine. */
export const CHANNEL_CONSENT_LABEL: Record<string, string> = {
  email: 'email consent',
  sms: 'SMS consent',
  push: 'push consent',
  google_ads: 'advertising consent',
  meta_ads: 'advertising consent',
  linkedin: 'advertising consent',
  facebook: 'advertising consent',
  instagram: 'advertising consent',
  x: 'advertising consent',
}

/* ------------------------------------------------------- rule tree edits */

export function countRules(group: SegmentRuleGroup): number {
  return group.rules.reduce((n, r) => n + (isGroup(r) ? countRules(r) : 1), 0)
}

/** Replace (or, with `null`, remove) the node at `path`. Returns a new tree. */
export function replaceAt(
  group: SegmentRuleGroup,
  path: number[],
  next: SegmentRule | SegmentRuleGroup | null,
): SegmentRuleGroup {
  const [head, ...rest] = path
  const rules = [...group.rules]
  if (rest.length === 0) {
    if (next === null) rules.splice(head, 1)
    else rules[head] = next
  } else {
    const child = rules[head]
    if (!child || !isGroup(child)) return group
    rules[head] = replaceAt(child, rest, next)
  }
  return { ...group, rules }
}

/** Append to the group at `path` (empty path = the root group). */
export function appendAt(
  group: SegmentRuleGroup,
  path: number[],
  item: SegmentRule | SegmentRuleGroup,
): SegmentRuleGroup {
  if (path.length === 0) return { ...group, rules: [...group.rules, item] }
  const [head, ...rest] = path
  const child = group.rules[head]
  if (!child || !isGroup(child)) return group
  const rules = [...group.rules]
  rules[head] = appendAt(child, rest, item)
  return { ...group, rules }
}

export function setCombinatorAt(
  group: SegmentRuleGroup,
  path: number[],
  combinator: 'and' | 'or',
): SegmentRuleGroup {
  if (path.length === 0) return { ...group, combinator }
  const [head, ...rest] = path
  const child = group.rules[head]
  if (!child || !isGroup(child)) return group
  const rules = [...group.rules]
  rules[head] = setCombinatorAt(child, rest, combinator)
  return { ...group, rules }
}

/* ----------------------------------------------------------- rule values */

export function operatorsFor(fieldKey: string) {
  const def = FIELD_BY_KEY.get(fieldKey)
  return def ? OPERATORS[def.type] : OPERATORS.string
}

/** A value that will actually evaluate, so size never drops to zero on a field swap. */
export function defaultValueFor(def: FieldDef, op: string): unknown {
  if (op === 'exists') return true
  if (op === 'within_days') return 30
  if (op === 'in' || op === 'nin') return def.options?.length ? [def.options[0]] : []
  if (def.type === 'boolean') return true
  if (def.type === 'enum') return def.options?.[0] ?? ''
  if (def.type === 'number') return 0
  if (def.type === 'date') return new Date().toISOString().slice(0, 10)
  return ''
}

export function newRule(fieldKey = SELECTABLE_FIELDS[0].key): SegmentRule {
  const def = FIELD_BY_KEY.get(fieldKey)!
  const op = OPERATORS[def.type][0].op as SegmentRule['op']
  return { field: def.key, op, value: defaultValueFor(def, op) }
}

/* -------------------------------------------------------------- summary */

const VERBS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  nin: 'is none of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
}

/** Browser-side twin of `describeRule` in the engine. */
export function summariseRule(rule: SegmentRule): string {
  const field = FIELD_BY_KEY.get(rule.field)?.label ?? rule.field
  const value = Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value ?? '')
  if (rule.op === 'within_days') return `${field} within the last ${value} days`
  if (rule.op === 'exists') return `${field} is known`
  return `${field} ${VERBS[rule.op] ?? rule.op} ${value}`
}

export function summariseGroup(group: SegmentRuleGroup): string {
  if (group.rules.length === 0) return 'No rules — this matches every contact in the workspace.'
  return group.rules
    .map((r) => (isGroup(r) ? `(${summariseGroup(r)})` : summariseRule(r)))
    .join(group.combinator === 'or' ? ' or ' : ' and ')
}

/* --------------------------------------------------------------- labels */

export const LIFECYCLE_TONE: Record<string, 'neutral' | 'brand' | 'ok' | 'warn' | 'info'> = {
  subscriber: 'neutral',
  lead: 'neutral',
  mql: 'info',
  sql: 'info',
  opportunity: 'warn',
  customer: 'ok',
  churned: 'neutral',
}

export function titleCase(v: string): string {
  if (v.length <= 3) return v.toUpperCase()
  return v.charAt(0).toUpperCase() + v.slice(1)
}
