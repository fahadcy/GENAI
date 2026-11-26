/**
 * The field catalogue the natural-language builder is allowed to target.
 * Keeping this explicit is what makes AT-1 inspectable: the model can only
 * produce rules over known fields with known operators, so every interpreted
 * rule renders as an editable row rather than opaque SQL.
 */
export type FieldType = 'string' | 'number' | 'enum' | 'date' | 'boolean'

export type FieldDef = {
  key: string
  label: string
  type: FieldType
  /** Column on `contacts`, or a key inside the `attributes` JSON blob. */
  column: string | null
  jsonKey?: string
  options?: string[]
  hint?: string
}

export const FIELDS: FieldDef[] = [
  { key: 'lifecycleStage', label: 'Lifecycle stage', type: 'enum', column: 'lifecycle_stage', options: ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'churned'] },
  { key: 'country', label: 'Country', type: 'enum', column: 'country', options: ['GB', 'US', 'IE', 'DE', 'FR', 'NL', 'ES', 'CA', 'AU', 'AE', 'SG', 'IN'] },
  { key: 'industry', label: 'Industry', type: 'enum', column: 'industry', options: ['SaaS', 'E-commerce', 'Financial services', 'Healthcare', 'Manufacturing', 'Professional services', 'Education', 'Media'] },
  { key: 'employees', label: 'Company size (employees)', type: 'number', column: 'employees' },
  { key: 'jobTitle', label: 'Job title', type: 'string', column: 'job_title' },
  { key: 'company', label: 'Company', type: 'string', column: 'company' },
  { key: 'plan', label: 'Plan', type: 'enum', column: 'plan', options: ['none', 'trial', 'starter', 'growth', 'enterprise'] },
  { key: 'mrr', label: 'Monthly recurring revenue', type: 'number', column: 'mrr' },
  { key: 'engagementScore', label: 'Engagement score (0-100)', type: 'number', column: 'engagement_score' },
  { key: 'lastActivityAt', label: 'Last activity', type: 'date', column: 'last_activity_at', hint: 'Use within_days for recency.' },
  { key: 'signupAt', label: 'Signed up', type: 'date', column: 'signup_at' },
  { key: 'suppressed', label: 'Suppressed', type: 'boolean', column: 'suppressed', hint: 'Always enforced; never needs to be a rule.' },
]

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]))

export const OPERATORS: Record<FieldType, { op: string; label: string }[]> = {
  string: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'contains', label: 'contains' },
    { op: 'exists', label: 'is known' },
  ],
  enum: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'in', label: 'is any of' },
    { op: 'nin', label: 'is none of' },
  ],
  number: [
    { op: 'eq', label: '=' },
    { op: 'gt', label: '>' },
    { op: 'gte', label: '≥' },
    { op: 'lt', label: '<' },
    { op: 'lte', label: '≤' },
  ],
  date: [
    { op: 'within_days', label: 'in the last N days' },
    { op: 'gt', label: 'after' },
    { op: 'lt', label: 'before' },
    { op: 'exists', label: 'is known' },
  ],
  boolean: [{ op: 'eq', label: 'is' }],
}

export function describeField(key: string): string {
  return FIELD_BY_KEY.get(key)?.label ?? key
}

export function catalogueForPrompt(): string {
  return FIELDS.filter((f) => f.key !== 'suppressed')
    .map((f) => {
      const ops = OPERATORS[f.type].map((o) => o.op).join('|')
      const opts = f.options ? ` values: ${f.options.join(', ')}` : ''
      return `- ${f.key} (${f.type}) ops: ${ops}${opts}`
    })
    .join('\n')
}
