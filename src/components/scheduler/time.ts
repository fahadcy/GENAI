/**
 * Calendar arithmetic in the workspace's timezone.
 *
 * The scheduler renders on the server and hydrates on the client, and those two
 * machines rarely share a timezone. Everything here therefore works from an
 * explicit IANA zone via `Intl`, so a day key computed during SSR is byte-identical
 * to the one computed during hydration — no mismatch, no flicker, and a marketer
 * in Lisbon sees the same grid as the ops lead in London.
 *
 * A "day key" is a plain `YYYY-MM-DD` string. It carries no instant, so all
 * grid maths is pure string/UTC arithmetic and stays deterministic.
 */

const PARTS = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = PARTS.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PARTS.set(tz, f)
  }
  return f
}

export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function partsIn(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  // `hour12: false` yields 24 for midnight in some engines; normalise it.
  const hour = get('hour') % 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

export function dayKeyIn(date: Date, tz: string): string {
  const p = partsIn(date, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function hourIn(date: Date, tz: string): number {
  return partsIn(date, tz).hour
}

export function fmtTimeIn(date: Date, tz: string): string {
  const p = partsIn(date, tz)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Offset of `tz` from UTC at this instant, in milliseconds. */
function offsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** Turn a wall-clock time in `tz` into the absolute instant it names. */
export function fromZoned(dayKey: string, hour: number, minute: number, tz: string): Date {
  const guess = new Date(`${dayKey}T${pad(hour)}:${pad(minute)}:00Z`)
  // One correction pass, then a second in case the first crossed a DST boundary.
  const once = new Date(guess.getTime() - offsetMs(guess, tz))
  return new Date(guess.getTime() - offsetMs(once, tz))
}

/* ------------------------------------------------------------ key algebra */

export function keyToUtcDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`)
}

export function addDays(key: string, n: number): string {
  const d = keyToUtcDate(key)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

export const monthOf = (key: string) => key.slice(0, 7)

/** ISO weekday index 0-6 where 0 = Sunday, matching `Date.getDay()`. */
export function weekdayOf(key: string): number {
  return keyToUtcDate(key).getUTCDay()
}

/** Monday-first (or Sunday-first) start of the week containing `key`. */
export function startOfWeek(key: string, weekStartsOn: number): string {
  const diff = (weekdayOf(key) - weekStartsOn + 7) % 7
  return addDays(key, -diff)
}

/** Six weeks of day keys covering `monthKey`, so the grid never changes height. */
export function monthGrid(monthKey: string, weekStartsOn: number): string[][] {
  const first = startOfWeek(`${monthKey}-01`, weekStartsOn)
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)),
  )
}

export function weekGrid(anchorKey: string, weekStartsOn: number): string[] {
  const first = startOfWeek(anchorKey, weekStartsOn)
  return Array.from({ length: 7 }, (_, d) => addDays(first, d))
}

/* -------------------------------------------------------------- labelling */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export function weekdayLabel(index: number): string {
  return WEEKDAY_SHORT[index % 7]
}

export function dayNumber(key: string): number {
  return Number(key.slice(8, 10))
}

export function rangeLabel(keys: string[]): string {
  const a = keys[0]
  const b = keys[keys.length - 1]
  const [, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const left = am === bm ? `${ad}` : `${ad} ${MONTH_NAMES[am - 1].slice(0, 3)}`
  return `${left} – ${bd} ${MONTH_NAMES[bm - 1].slice(0, 3)} ${by}`
}

export function fmtHourLabel(h: number): string {
  return `${pad(h)}:00`
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, in the workspace zone. */
export function toLocalInput(iso: string, tz: string): string {
  const p = partsIn(new Date(iso), tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** Inverse of `toLocalInput`: a datetime-local value back to an absolute ISO. */
export function fromLocalInput(value: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  return fromZoned(m[1], Number(m[2]), Number(m[3]), tz).toISOString()
}
