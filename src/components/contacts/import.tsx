'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, FileUp, Info, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import {
  parseCsv,
  guessColumns,
  surnameColumn,
  readRows,
  type ColumnMap,
  type CsvTable,
  type ImportPreview,
} from '@/lib/contacts/csv'
import { BASIS_OPTIONS, b2bWarnings, type ConsentBasis } from '@/lib/contacts/consent'
import { importContactsAction } from '@/app/actions/contacts'

/**
 * Importing a spreadsheet, in three steps that each answer one question:
 * what is in the file, why you are allowed to contact these people, and what
 * will happen when you press the button.
 *
 * The file is parsed in the browser first. That is not a performance trick —
 * it means the person sees the row count, the column guesses and the rejected
 * rows *before* anything is written, and can back out. An import that reports
 * its problems afterwards has already made them somebody's problem.
 */

type Step = 'file' | 'basis' | 'confirm'

/** What the browser works out about the file before anything is written. */
type Preview = ImportPreview & { table: CsvTable; map: ColumnMap }

export function ContactImport({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = React.useState<Step>('file')
  const [csv, setCsv] = React.useState('')
  const [fileName, setFileName] = React.useState('')
  const [basis, setBasis] = React.useState<ConsentBasis | null>(null)
  const [busy, setBusy] = React.useState(false)
  const toast = useToast()
  const router = useRouter()

  const preview: Preview | null = React.useMemo(() => {
    if (!csv) return null
    const table = parseCsv(csv)
    const map = guessColumns(table.headers)
    return {
      table,
      map,
      ...readRows(table, map, { surnameAt: surnameColumn(table.headers) }),
    }
  }, [csv])

  const warnings = React.useMemo(
    () => (preview && basis === 'b2b_legitimate_interest' ? b2bWarnings(preview.contacts.map((c) => c.email)) : null),
    [preview, basis],
  )

  async function readFile(file: File) {
    if (file.size > 8_000_000) {
      toast.push({
        tone: 'danger',
        title: 'That file is too big',
        body: 'Split it into a few smaller files of under about 20,000 rows each.',
      })
      return
    }
    const text = await file.text()
    setCsv(text)
    setFileName(file.name)
    setStep('basis')
  }

  async function run() {
    if (!preview || !basis || busy) return
    setBusy(true)
    try {
      const res = await importContactsAction({ csv, basis })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Import finished' : 'Nothing was imported',
        body: res.message,
      })
      if (res.ok) {
        setCsv('')
        setFileName('')
        setBasis(null)
        setStep('file')
        router.refresh()
        onDone?.()
      }
    } catch {
      toast.push({ tone: 'danger', title: 'Nothing was imported', body: 'The import did not complete.' })
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------------------------------------ step 1 */

  if (step === 'file') {
    return (
      <Card className="p-5">
        <FilePicker onPick={readFile} />
        <div className="mt-4 rounded-lg bg-bg-inset p-3 text-[12px] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">What the file needs</p>
          <p className="mt-1">
            A header row and an email column. Everything else is optional. Columns called Name, Company,
            Job Title, Mobile, Country or Stage are picked up automatically, whatever mix of capitals,
            spaces and underscores they use.
          </p>
          <p className="mt-2">
            Addresses already on your list are updated rather than duplicated, and a blank cell never
            erases something you already hold.
          </p>
        </div>
      </Card>
    )
  }

  /* ------------------------------------------------------------ step 2 */

  if (step === 'basis' && preview) {
    return (
      <Card className="p-5">
        <FileSummary name={fileName} preview={preview} onChange={() => setStep('file')} />

        <div className="mt-5">
          <p className="text-[13px] font-medium text-ink">Where did this list come from?</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            This decides what the platform will let you send to these people. It is recorded against every
            contact, so if anyone ever asks why you contacted them, the answer is on the record rather than
            in somebody's memory.
          </p>

          <div className="mt-3 grid gap-2">
            {BASIS_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setBasis(o.value)}
                className={cn(
                  'rounded-xl border p-3 text-left transition',
                  basis === o.value
                    ? 'border-brand-400 bg-brand-50 ring-1 ring-brand-200'
                    : 'border-line bg-surface hover:border-line-strong',
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{o.label}</span>
                  <span className="flex gap-1">
                    {o.grants.email && <Badge tone="ok">email</Badge>}
                    {o.grants.sms && <Badge tone="ok">text</Badge>}
                    {!o.grants.email && !o.grants.sms && <Badge tone="neutral">nothing sent</Badge>}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{o.description}</p>
                {o.caution && basis === o.value && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn-fg">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" />
                    {o.caution}
                  </p>
                )}
              </button>
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            This is how the rules generally work in the UK, not legal advice. If a list came from somewhere
            you did not control, pick the last option — the contacts are still stored and can be segmented.
          </p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setStep('file')}>
            Back
          </Button>
          <Button variant="primary" disabled={!basis} onClick={() => setStep('confirm')}>
            Continue
          </Button>
        </div>
      </Card>
    )
  }

  /* ------------------------------------------------------------ step 3 */

  if (step === 'confirm' && preview && basis) {
    const option = BASIS_OPTIONS.find((o) => o.value === basis)!
    const flagged = (warnings?.personal.length ?? 0) + (warnings?.generic.length ?? 0)

    return (
      <Card className="p-5">
        <p className="text-[13px] font-medium text-ink">About to import</p>

        <ul className="mt-3 space-y-2 text-[13px] text-ink">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok-fg" />
            <span>
              <strong>{preview.contacts.length.toLocaleString('en-GB')}</strong> contacts from{' '}
              <span className="text-ink-muted">{fileName}</span>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok-fg" />
            <span>
              Recorded as <strong>{option.label.toLowerCase()}</strong> — {effectSentence(option)}
            </span>
          </li>
          {preview.problems.length > 0 && (
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn-fg" />
              <span>
                <strong>{preview.problems.length}</strong> rows will be skipped and listed afterwards.
              </span>
            </li>
          )}
          {preview.duplicatesInFile > 0 && (
            <li className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
              <span>
                {preview.duplicatesInFile} address{preview.duplicatesInFile === 1 ? '' : 'es'} appear more
                than once in the file; the last row wins.
              </span>
            </li>
          )}
        </ul>

        {flagged > 0 && warnings && (
          <div className="mt-4 rounded-lg bg-warn-bg p-3 text-[12px] leading-relaxed text-warn-fg">
            <p className="font-medium">
              {flagged} of these do not look like business contacts at limited companies.
            </p>
            <p className="mt-1">
              {warnings.personal.length > 0 && (
                <>
                  {warnings.personal.length} personal address
                  {warnings.personal.length === 1 ? '' : 'es'} (Gmail, Outlook and similar)
                  {warnings.generic.length > 0 && ', and '}
                </>
              )}
              {warnings.generic.length > 0 && (
                <>
                  {warnings.generic.length} shared inbox
                  {warnings.generic.length === 1 ? '' : 'es'} such as info@ or sales@
                </>
              )}
              . The B2B position does not cover personal addresses, sole traders or partnerships. You can
              still import, then filter and correct them — but they are the ones a complaint is usually
              about.
            </p>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
          Anyone on your list who has already unsubscribed stays unsubscribed. An import cannot put them
          back.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setStep('basis')} disabled={busy}>
            Back
          </Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={busy}>
            <Upload className="h-3.5 w-3.5" />
            Import {preview.contacts.length.toLocaleString('en-GB')} contacts
          </Button>
        </div>
      </Card>
    )
  }

  return null
}

function effectSentence(o: (typeof BASIS_OPTIONS)[number]): string {
  const on = [o.grants.email && 'emailed', o.grants.sms && 'texted'].filter(Boolean) as string[]
  return on.length === 0
    ? 'nothing will be sent to them until you say why you may contact them'
    : `they can be ${on.join(' and ')}`
}

/* ------------------------------------------------------------ the pieces */

function FilePicker({ onPick }: { onPick: (f: File) => void }) {
  const [over, setOver] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onPick(f)
      }}
      className={cn(
        'grid place-items-center rounded-xl border-2 border-dashed p-8 text-center transition',
        over ? 'border-brand-400 bg-brand-50' : 'border-line bg-bg-inset',
      )}
    >
      <FileUp className="h-7 w-7 text-ink-muted" />
      <p className="mt-2 text-[13px] font-medium text-ink">Drop a CSV here</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        In Excel or Google Sheets: File → Save as / Download → CSV
      </p>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />
      <Button className="mt-3" variant="secondary" onClick={() => input.current?.click()}>
        Choose a file
      </Button>
    </div>
  )
}

function FileSummary({
  name,
  preview,
  onChange,
}: {
  name: string
  preview: Preview
  onChange: () => void
}) {
  const found = Object.keys(preview.map)
  return (
    <div className="rounded-lg bg-bg-inset p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-[13px] font-medium text-ink">{name}</p>
        <Button size="xs" variant="ghost" onClick={onChange}>
          Change file
        </Button>
      </div>
      <p className="mt-1 text-[12px] text-ink-muted">
        {preview.contacts.length.toLocaleString('en-GB')} usable contacts
        {preview.problems.length > 0 && ` · ${preview.problems.length} rows cannot be imported`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {found.map((f) => (
          <Badge key={f} tone="neutral">
            {FIELD_LABEL[f] ?? f}
          </Badge>
        ))}
      </div>
      {preview.problems.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] text-ink-muted">
            See the {preview.problems.length} rows that will be skipped
          </summary>
          <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-[11px] text-ink-muted">
            {preview.problems.slice(0, 100).map((p, i) => (
              <li key={i}>
                Line {p.line}
                {p.email && ` (${p.email})`}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const FIELD_LABEL: Record<string, string> = {
  email: 'Email',
  name: 'Name',
  phone: 'Mobile',
  company: 'Company',
  jobTitle: 'Job title',
  country: 'Country',
  industry: 'Industry',
  lifecycleStage: 'Stage',
}

