/**
 * Shared types. The rule that runs through the whole module:
 *
 *   The model decides what to look at and how to say it.
 *   Code fetches, counts, scores and enforces.
 *   Every claim the agent makes cites evidence a tool produced.
 */

/** One checkable fact a tool produced. The agent cites these by id. */
export interface Evidence {
  id: string;                // "E12" — assigned by the EvidenceStore, never by the model
  source: EvidenceSource;
  label: string;             // human sentence: "Accounts overdue by 124 days"
  url?: string;              // where a person can check it
  values?: Record<string, number | string | boolean | null>;
  observedAt: string;        // ISO
}

export type EvidenceSource =
  | 'companies_house' | 'gazette' | 'crm' | 'website' | 'competitors'
  | 'search_console' | 'ads' | 'budget' | 'brain' | 'computed';

/** Every action has a tier. The tier, not the prompt, decides what happens. */
export type ToolTier =
  | 'auto'      // read-only or idempotent; the agent just does it
  | 'propose'   // produces a draft for a person: an approval, a PR, a task
  | 'gated';    // acts on the world (sends email); passes every code-side rule first

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export class EvidenceStore {
  private items = new Map<string, Evidence>();
  private n = 0;
  constructor(private clock: Clock = systemClock) {}

  add(e: Omit<Evidence, 'id' | 'observedAt'> & { observedAt?: string }): Evidence {
    const id = `E${++this.n}`;
    const full: Evidence = { ...e, id, observedAt: e.observedAt ?? this.clock.now().toISOString() };
    this.items.set(id, full);
    return full;
  }
  get(id: string): Evidence | undefined { return this.items.get(id); }
  has(id: string): boolean { return this.items.has(id); }
  all(): Evidence[] { return [...this.items.values()]; }
  /** Every number that appears in any evidence, as strings in several formats. */
  numbers(): Set<string> {
    const out = new Set<string>();
    const add = (v: number) => { for (const f of numberForms(v)) out.add(f); };
    for (const e of this.items.values()) {
      for (const m of e.label.match(NUM_RE) ?? []) add(parseNum(m));
      for (const v of Object.values(e.values ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) add(v);
        else if (typeof v === 'string') for (const m of v.match(NUM_RE) ?? []) add(parseNum(m));
      }
    }
    return out;
  }
}

export const NUM_RE = /-?£?\d[\d,]*(?:\.\d+)?%?/g;
export function parseNum(s: string): number { return Number(s.replace(/[£,%]/g, '')); }
/** The ways a number may legitimately be written: 1500, 1,500, 1500.0, 0.25 ↔ 25%. */
export function numberForms(v: number): string[] {
  const r = (x: number, d: number) => String(Math.round(x * 10 ** d) / 10 ** d);
  const forms = new Set<string>([String(v), r(v, 0), r(v, 1), r(v, 2)]);
  if (Math.abs(v) <= 1 && v !== 0) { forms.add(r(v * 100, 0)); forms.add(r(v * 100, 1)); }
  return [...forms];
}
