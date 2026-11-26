/**
 * Card and bank statement CSV import — the connector that always works.
 *
 * Every UK bank and card issuer exports a CSV, and many corporate cards
 * (Amex corporate, Barclaycard Commercial) cannot be reached through Open
 * Banking at all. The formats differ in every way that matters: column
 * names, date order, whether a purchase is positive or negative, one amount
 * column or separate "money in" and "money out". This parser detects all of
 * that and says what it decided, so a person can correct it.
 *
 * Pure.
 */

export type CsvSign = 'auto' | 'charges_positive' | 'charges_negative'

export type ParsedRow = {
  day: string
  amountPence: number // positive = money out
  currency: string
  descriptor: string
  status: 'pending' | 'settled'
  originalAmountMinor: number | null
  originalCurrency: string | null
}

export type CsvParse = {
  rows: ParsedRow[]
  skipped: { line: number; reason: string }[]
  detected: {
    delimiter: string
    dateColumn: string
    descriptionColumn: string
    amountColumns: string[]
    dateOrder: 'dmy' | 'ymd' | 'mdy'
    sign: Exclude<CsvSign, 'auto'>
  }
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvError'
  }
}

const MAX_ROWS = 20_000

/** RFC 4180-ish: quotes, escaped quotes, delimiters inside quotes. */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length > MAX_ROWS + 50) break
    } else cell += ch
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n')
  const counts = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length] as const)
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][0]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

function findCol(header: string[], names: string[]): number {
  const h = header.map(norm)
  for (const n of names) {
    const i = h.indexOf(norm(n))
    if (i >= 0) return i
  }
  for (const n of names) {
    const i = h.findIndex((x) => x.includes(norm(n)))
    if (i >= 0) return i
  }
  return -1
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

export function parseDate(raw: string, order: 'dmy' | 'ymd' | 'mdy'): string | null {
  const s = raw.trim()
  let y: number, m: number, d: number
  let mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (mt) {
    ;[y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])]
  } else if ((mt = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ](\d{2,4})/))) {
    d = Number(mt[1])
    m = MONTHS[mt[2].toLowerCase()] ?? 0
    y = Number(mt[3])
  } else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    const a = Number(mt[1])
    const b = Number(mt[2])
    y = Number(mt[3])
    ;[d, m] = order === 'mdy' ? [b, a] : [a, b]
  } else return null
  if (y < 100) y += 2000
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

export function parseAmount(raw: string): number | null {
  let s = raw.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (/\b(dr|debit)\b/i.test(s)) s = s.replace(/\b(dr|debit)\b/i, '')
  if (/\b(cr|credit)\b/i.test(s)) {
    negative = true
    s = s.replace(/\b(cr|credit)\b/i, '')
  }
  s = s.replace(/[£$€\s]|GBP|USD|EUR/gi, '')
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative
    s = s.slice(1)
  }
  if (s.endsWith('-')) {
    negative = !negative
    s = s.slice(0, -1)
  }
  // 1.234,56 (continental) vs 1,234.56
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  // "12,50" and "0,99": one or two digits after a lone comma is a decimal comma, not thousands.
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const pence = Math.round(Number(s) * 100)
  return negative ? -pence : pence
}

export function parseStatement(text: string, opts: { sign?: CsvSign; currency?: string; dateOrder?: 'dmy' | 'ymd' | 'mdy' } = {}): CsvParse {
  const clean = text.replace(/^﻿/, '')
  if (clean.length > 5_000_000) throw new CsvError('The file is larger than 5 MB. Export a shorter date range.')
  const delimiter = detectDelimiter(clean)
  const table = splitCsv(clean, delimiter)
  if (table.length < 2) throw new CsvError('The file has no rows under its header.')

  // The header is the first row that names a date and an amount; some banks put account details above it.
  let headerIdx = table.findIndex(
    (r) => findCol(r, ['date', 'transaction date', 'posted', 'posting date']) >= 0 && (findCol(r, ['amount', 'value', 'debit', 'money out', 'paid out']) >= 0),
  )
  if (headerIdx < 0) throw new CsvError('Could not find a header row with a date and an amount column.')
  const header = table[headerIdx].map((h) => h.trim())
  const body = table.slice(headerIdx + 1)
  if (body.length > MAX_ROWS) throw new CsvError(`The file has more than ${MAX_ROWS.toLocaleString('en-GB')} rows. Export a shorter date range.`)

  const iDate = findCol(header, ['transaction date', 'date', 'posted date', 'posting date', 'completed date'])
  const iDesc = findCol(header, ['description', 'merchant', 'details', 'narrative', 'payee', 'reference', 'name', 'memo'])
  const iAmount = findCol(header, ['amount', 'value', 'billing amount', 'amount gbp'])
  const iDebit = findCol(header, ['debit', 'money out', 'paid out', 'withdrawal', 'out'])
  const iCredit = findCol(header, ['credit', 'money in', 'paid in', 'deposit', 'in'])
  const iCurrency = findCol(header, ['currency', 'ccy'])
  const iStatus = findCol(header, ['status', 'state'])
  const iOrig = findCol(header, ['original amount', 'foreign amount', 'transaction amount'])
  const iOrigCcy = findCol(header, ['original currency', 'foreign currency', 'transaction currency'])
  if (iDesc < 0) throw new CsvError('Could not find a description or merchant column.')
  const separate = iDebit >= 0 && iDebit !== iAmount && (iAmount < 0 || iCredit >= 0)

  // Date order: if any first field is above 12 it is day-first; if any second is, month-first. UK default is dmy.
  let order: 'dmy' | 'ymd' | 'mdy' = opts.dateOrder ?? 'dmy'
  if (!opts.dateOrder) {
    for (const r of body) {
      const m = (r[iDate] ?? '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/)
      if (!m) continue
      if (Number(m[2]) > 12) {
        order = 'mdy'
        break
      }
      if (Number(m[1]) > 12) {
        order = 'dmy'
        break
      }
    }
  }

  // Sign: with one amount column, a statement where most rows are negative records purchases as negatives.
  let sign: Exclude<CsvSign, 'auto'> = 'charges_positive'
  if (separate) sign = 'charges_positive'
  else if (opts.sign && opts.sign !== 'auto') sign = opts.sign
  else {
    const values = body.map((r) => parseAmount(r[iAmount] ?? '')).filter((v): v is number => v !== null && v !== 0)
    const neg = values.filter((v) => v < 0).length
    sign = neg > values.length / 2 ? 'charges_negative' : 'charges_positive'
  }

  const rows: ParsedRow[] = []
  const skipped: CsvParse['skipped'] = []
  body.forEach((r, idx) => {
    const line = headerIdx + idx + 2
    const day = parseDate(r[iDate] ?? '', order)
    if (!day) {
      skipped.push({ line, reason: `Unreadable date "${(r[iDate] ?? '').slice(0, 20)}"` })
      return
    }
    let amount: number | null
    if (separate) {
      const out = parseAmount(r[iDebit] ?? '')
      const inn = iCredit >= 0 ? parseAmount(r[iCredit] ?? '') : null
      amount = out ? Math.abs(out) : inn ? -Math.abs(inn) : null
    } else {
      const v = parseAmount(r[iAmount] ?? '')
      amount = v === null ? null : sign === 'charges_negative' ? -v : v
    }
    if (amount === null || amount === 0) {
      skipped.push({ line, reason: 'No amount' })
      return
    }
    const status = iStatus >= 0 && /pend|auth/i.test(r[iStatus] ?? '') ? 'pending' : 'settled'
    const origCcy = iOrigCcy >= 0 ? (r[iOrigCcy] ?? '').trim().toUpperCase() : ''
    const orig = iOrig >= 0 && iOrig !== iAmount ? parseAmount(r[iOrig] ?? '') : null
    rows.push({
      day,
      amountPence: amount,
      currency: (iCurrency >= 0 ? (r[iCurrency] ?? '').trim().toUpperCase() : '') || opts.currency || 'GBP',
      descriptor: (r[iDesc] ?? '').trim() || '(no description)',
      status,
      originalAmountMinor: orig !== null && origCcy && /^[A-Z]{3}$/.test(origCcy) ? Math.abs(orig) : null,
      originalCurrency: orig !== null && /^[A-Z]{3}$/.test(origCcy) ? origCcy : null,
    })
  })

  return {
    rows,
    skipped,
    detected: {
      delimiter,
      dateColumn: header[iDate] ?? '',
      descriptionColumn: header[iDesc] ?? '',
      amountColumns: separate ? [header[iDebit], iCredit >= 0 ? header[iCredit] : ''].filter(Boolean) : [header[iAmount]],
      dateOrder: order,
      sign,
    },
  }
}
