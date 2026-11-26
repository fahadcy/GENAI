import assert from 'node:assert/strict'
import { describe as nodeDescribe, it as nodeIt } from 'node:test'

/**
 * A small `expect` over node:assert, so the SERP Twin engine tests read the
 * way they were written without adding a test framework to the project.
 * Only the matchers those tests use are implemented.
 */

export const describe = nodeDescribe

/* eslint-disable @typescript-eslint/no-explicit-any -- table-driven rows are heterogeneous tuples */
type ItFn = ((name: string, fn: () => unknown) => void) & {
  each: (rows: readonly any[]) => (name: string, fn: (...args: any[]) => unknown) => void
}

export const it: ItFn = Object.assign(
  (name: string, fn: () => unknown) =>
    nodeIt(name, async () => {
      await fn()
    }),
  {
    each: (rows: readonly any[]) => (name: string, fn: (...args: any[]) => unknown) => {
      for (const row of rows) {
        const args: any[] = Array.isArray(row) ? row : [row]
        let i = 0
        const title = name.replace(/%[sid]/g, () => String(args[i++]))
        nodeIt(title, async () => {
          await fn(...args)
        })
      }
    },
  },
)

const ARRAY_CONTAINING = Symbol('arrayContaining')
type Containing = { [ARRAY_CONTAINING]: unknown[] }

function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && ARRAY_CONTAINING in (expected as object)) {
    const want = (expected as Containing)[ARRAY_CONTAINING]
    return Array.isArray(actual) && want.every((w) => actual.some((a) => matches(a, w)))
  }
  try {
    assert.deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function subset(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false
  // Nested plain objects match as subsets too, as in vitest's toMatchObject.
  return Object.entries(expected).every(([k, v]) => {
    const a = (actual as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && !(ARRAY_CONTAINING in (v as object)) && a && typeof a === 'object' && !Array.isArray(a)) {
      return subset(a, v as Record<string, unknown>)
    }
    return matches(a, v)
  })
}

function matchers(actual: unknown, negate: boolean) {
  const check = (ok: boolean, message: string) =>
    assert.ok(negate ? !ok : ok, `${negate ? 'not ' : ''}${message}`)
  const num = actual as number
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `expected ${String(actual)} to be ${String(e)}`),
    toEqual: (e: unknown) =>
      check(matches(actual, e), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(e)}`),
    toBeCloseTo: (e: number, digits = 2) =>
      check(Math.abs(num - e) < 10 ** -digits / 2, `expected ${num} to be close to ${e}`),
    toBeLessThan: (e: number) => check(num < e, `expected ${num} < ${e}`),
    toBeGreaterThan: (e: number) => check(num > e, `expected ${num} > ${e}`),
    toBeLessThanOrEqual: (e: number) => check(num <= e, `expected ${num} <= ${e}`),
    toBeGreaterThanOrEqual: (e: number) => check(num >= e, `expected ${num} >= ${e}`),
    toContain: (e: unknown) =>
      check(
        typeof actual === 'string' ? actual.includes(String(e)) : Array.isArray(actual) && actual.includes(e),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(e)}`,
      ),
    toMatch: (re: RegExp | string) =>
      check(new RegExp(re).test(String(actual)), `expected "${String(actual)}" to match ${String(re)}`),
    toMatchObject: (e: Record<string, unknown>) =>
      check(subset(actual, e), `expected object to match ${JSON.stringify(e)}`),
    toBeUndefined: () => check(actual === undefined, `expected undefined, got ${JSON.stringify(actual)}`),
    toBeNull: () => check(actual === null, `expected null, got ${JSON.stringify(actual)}`),
    toHaveLength: (n: number) =>
      check((actual as { length?: number })?.length === n, `expected length ${n}, got ${(actual as { length?: number })?.length}`),
    toThrow: (re?: RegExp | string) => {
      let thrown: unknown = null
      try {
        ;(actual as () => unknown)()
      } catch (e) {
        thrown = e ?? new Error('thrown')
      }
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      check(thrown !== null && (!re || new RegExp(re).test(msg)), `expected function to throw${re ? ` ${String(re)}` : ''}, got ${thrown === null ? 'no error' : msg}`)
    },
  }
}

/** expect(promise).rejects.toThrow(/message/) */
function rejects(actual: unknown) {
  return {
    toThrow: async (re?: RegExp | string) => {
      let thrown: unknown = null
      try {
        await (actual as Promise<unknown>)
      } catch (e) {
        thrown = e ?? new Error('rejected')
      }
      const msg = thrown instanceof Error ? thrown.message : String(thrown)
      assert.ok(thrown !== null && (!re || new RegExp(re).test(msg)), `expected promise to reject${re ? ` with ${String(re)}` : ''}, got ${thrown === null ? 'resolution' : msg}`)
    },
  }
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true), rejects: rejects(actual) })
}

expect.arrayContaining = (items: unknown[]): Containing => ({ [ARRAY_CONTAINING]: items }) as Containing
