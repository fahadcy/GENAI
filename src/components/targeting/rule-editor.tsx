'use client'

import * as React from 'react'
import { Lock, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { FIELD_BY_KEY } from '@/lib/targeting/fields'
import type { SegmentRule, SegmentRuleGroup } from '@/lib/db/schema'
import { Badge, Button, Input, Select } from '@/components/ui/primitives'
import {
  SELECTABLE_FIELDS,
  appendAt,
  defaultValueFor,
  isGroup,
  newRule,
  operatorsFor,
  replaceAt,
  setCombinatorAt,
} from './shared'

/**
 * AT-1's payoff. Whatever produced the rules — a sentence the marketer typed or
 * a saved segment — they arrive here as field/operator/value rows the marketer
 * can read and correct. Nothing about the segment is hidden behind prose.
 */
export function RuleEditor({
  group,
  onChange,
  disabled,
}: {
  group: SegmentRuleGroup
  onChange: (next: SegmentRuleGroup) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <GroupBody root={group} path={[]} onChange={onChange} disabled={disabled} />
      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-ink-faint">
        <Lock className="mt-px h-3 w-3 shrink-0" />
        Consent and suppression are applied on top of these rules by the segment engine. They are not
        listed here because they are not optional.
      </p>
    </div>
  )
}

function GroupBody({
  root,
  path,
  onChange,
  disabled,
}: {
  /** The whole tree. Every edit rewrites it from the top, so nested editors
   *  address themselves by absolute path and hold no state of their own. */
  root: SegmentRuleGroup
  path: number[]
  onChange: (next: SegmentRuleGroup) => void
  disabled?: boolean
}) {
  const group = groupAt(root, path)
  const isRoot = path.length === 0
  const update = (fn: (tree: SegmentRuleGroup) => SegmentRuleGroup) => onChange(fn(root))

  return (
    <div className={cn(!isRoot && 'rounded-lg border border-dashed border-line-strong bg-bg-subtle p-2.5')}>
      {group.rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-faint">
          {isRoot
            ? 'No conditions yet — every contact in the workspace would match. Add one to narrow it down.'
            : 'Empty group. Add a condition or remove the group.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {group.rules.map((rule, i) => (
            <li key={i} className="flex items-start gap-2">
              <Joiner
                index={i}
                combinator={group.combinator}
                disabled={disabled}
                onToggle={() =>
                  update((r) => setCombinatorAt(r, path, group.combinator === 'and' ? 'or' : 'and'))
                }
              />
              <div className="min-w-0 flex-1">
                {isGroup(rule) ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone="neutral">Nested group</Badge>
                      {!disabled && (
                        <button
                          type="button"
                          onClick={() => update((r) => replaceAt(r, [...path, i], null))}
                          className="rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
                          aria-label="Remove group"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <GroupBody root={root} path={[...path, i]} onChange={onChange} disabled={disabled} />
                  </div>
                ) : (
                  <RuleRow
                    rule={rule}
                    disabled={disabled}
                    onChange={(next) => update((r) => replaceAt(r, [...path, i], next))}
                    onRemove={() => update((r) => replaceAt(r, [...path, i], null))}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <div className="mt-2 flex items-center gap-1.5 pl-[4.25rem]">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => update((r) => appendAt(r, path, newRule()))}
          >
            <Plus className="h-3 w-3" />
            Condition
          </Button>
          {path.length === 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() =>
                update((r) => appendAt(r, path, { combinator: 'or', rules: [newRule()] }))
              }
            >
              <Plus className="h-3 w-3" />
              Group
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function groupAt(root: SegmentRuleGroup, path: number[]): SegmentRuleGroup {
  let node: SegmentRuleGroup = root
  for (const i of path) {
    const child = node.rules[i]
    if (!child || !isGroup(child)) return node
    node = child
  }
  return node
}

function Joiner({
  index,
  combinator,
  onToggle,
  disabled,
}: {
  index: number
  combinator: 'and' | 'or'
  onToggle: () => void
  disabled?: boolean
}) {
  if (index === 0) {
    return (
      <span className="w-16 shrink-0 pt-2 text-right text-2xs font-semibold uppercase tracking-wider text-ink-faint">
        Where
      </span>
    )
  }
  if (index === 1 && !disabled) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Switch between AND and OR for this group"
        className="mt-1 w-16 shrink-0 rounded-md border border-line bg-surface px-1.5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
      >
        {combinator}
      </button>
    )
  }
  return (
    <span className="w-16 shrink-0 pt-2 text-right text-2xs font-semibold uppercase tracking-wider text-ink-faint">
      {combinator}
    </span>
  )
}

/* ------------------------------------------------------------- one row */

function RuleRow({
  rule,
  onChange,
  onRemove,
  disabled,
}: {
  rule: SegmentRule
  onChange: (next: SegmentRule) => void
  onRemove: () => void
  disabled?: boolean
}) {
  const def = FIELD_BY_KEY.get(rule.field)
  const ops = operatorsFor(rule.field)
  const unknownField = !def

  const changeField = (key: string) => {
    const nextDef = FIELD_BY_KEY.get(key)
    if (!nextDef) return
    const stillValid = operatorsFor(key).some((o) => o.op === rule.op)
    const op = (stillValid ? rule.op : operatorsFor(key)[0].op) as SegmentRule['op']
    onChange({ field: key, op, value: defaultValueFor(nextDef, op), label: undefined })
  }

  const changeOp = (op: string) => {
    const next = op as SegmentRule['op']
    // Switching between single and multi-value operators makes the old value
    // the wrong shape, so reset it rather than silently matching nothing.
    const shapeChanged =
      (rule.op === 'in' || rule.op === 'nin') !== (next === 'in' || next === 'nin') ||
      next === 'exists' ||
      next === 'within_days'
    onChange({
      ...rule,
      op: next,
      value: def && shapeChanged ? defaultValueFor(def, next) : rule.value,
      label: undefined,
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-1.5">
      <Select
        aria-label="Field"
        className="h-8 w-full max-w-[13rem] py-1 text-[13px] sm:w-auto sm:flex-none"
        value={rule.field}
        disabled={disabled}
        onChange={(e) => changeField(e.target.value)}
      >
        {unknownField && <option value={rule.field}>{rule.field} (unknown)</option>}
        {SELECTABLE_FIELDS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Operator"
        className="h-8 w-auto py-1 text-[13px]"
        value={rule.op}
        disabled={disabled}
        onChange={(e) => changeOp(e.target.value)}
      >
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </Select>

      <div className="min-w-[8rem] flex-1">
        <ValueEditor rule={rule} onChange={onChange} disabled={disabled} />
      </div>

      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-danger-fg"
          aria-label="Remove condition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function ValueEditor({
  rule,
  onChange,
  disabled,
}: {
  rule: SegmentRule
  onChange: (next: SegmentRule) => void
  disabled?: boolean
}) {
  const def = FIELD_BY_KEY.get(rule.field)
  const set = (value: unknown) => onChange({ ...rule, value, label: undefined })

  if (!def || rule.op === 'exists') {
    return <span className="block px-1 text-[13px] text-ink-faint">no value needed</span>
  }

  if (rule.op === 'within_days') {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          aria-label="Days"
          className="h-8 w-24 py-1 text-[13px]"
          value={String(rule.value ?? '')}
          disabled={disabled}
          onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
        />
        <span className="text-[13px] text-ink-faint">days</span>
      </div>
    )
  }

  if (rule.op === 'in' || rule.op === 'nin') {
    const selected = Array.isArray(rule.value) ? rule.value.map(String) : []
    const options = def.options ?? []
    if (options.length === 0) {
      return (
        <Input
          aria-label="Values, comma separated"
          className="h-8 py-1 text-[13px]"
          placeholder="Comma-separated values"
          value={selected.join(', ')}
          disabled={disabled}
          onChange={(e) => set(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
        />
      )
    }
    return (
      <div className="flex max-h-[5.5rem] flex-wrap gap-1 overflow-y-auto rounded-md bg-bg-subtle p-1">
        {options.map((o) => {
          const on = selected.includes(o)
          return (
            <button
              key={o}
              type="button"
              disabled={disabled}
              onClick={() => set(on ? selected.filter((v) => v !== o) : [...selected, o])}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs font-medium transition-colors disabled:cursor-not-allowed',
                on
                  ? 'bg-brand-solid text-brand-on'
                  : 'bg-surface text-ink-muted ring-1 ring-inset ring-line hover:text-ink',
              )}
            >
              {o}
            </button>
          )
        })}
      </div>
    )
  }

  if (def.type === 'boolean') {
    return (
      <Select
        aria-label="Value"
        className="h-8 w-auto py-1 text-[13px]"
        value={rule.value ? 'true' : 'false'}
        disabled={disabled}
        onChange={(e) => set(e.target.value === 'true')}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    )
  }

  if (def.type === 'enum' && def.options) {
    return (
      <Select
        aria-label="Value"
        className="h-8 w-full py-1 text-[13px]"
        value={String(rule.value ?? '')}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
      >
        {!def.options.includes(String(rule.value ?? '')) && (
          <option value={String(rule.value ?? '')}>{String(rule.value ?? '—')}</option>
        )}
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    )
  }

  if (def.type === 'number') {
    return (
      <Input
        type="number"
        aria-label="Value"
        className="h-8 py-1 text-[13px]"
        value={String(rule.value ?? '')}
        disabled={disabled}
        onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }

  if (def.type === 'date') {
    return (
      <Input
        type="date"
        aria-label="Value"
        className="h-8 py-1 text-[13px]"
        value={String(rule.value ?? '').slice(0, 10)}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
      />
    )
  }

  return (
    <Input
      aria-label="Value"
      className="h-8 py-1 text-[13px]"
      placeholder={def.hint ?? 'Value'}
      value={String(rule.value ?? '')}
      disabled={disabled}
      onChange={(e) => set(e.target.value)}
    />
  )
}
