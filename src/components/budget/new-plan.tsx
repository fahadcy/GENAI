'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { createPlanAction } from '@/app/actions/budget'
import { Button, Field, Input, Select } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import { toPence } from '@/lib/budget/money'

function monthBounds(offset = 0) {
  const d = new Date()
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), name: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
}

/**
 * Create a plan: the envelope, the period, what success means, and where the
 * first split comes from — a starter split, last quarter's actual spend, or
 * nothing. The simulated market can be loaded in the same step so the
 * allocator has something to work on before anything is connected.
 */
export function NewPlanForm({ hasHistory, onDone, compact }: { hasHistory: boolean; onDone?: () => void; compact?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const m = monthBounds(0)
  const [name, setName] = React.useState(`${m.name} marketing`)
  const [start, setStart] = React.useState(m.start)
  const [end, setEnd] = React.useState(m.end)
  const [total, setTotal] = React.useState('25000')
  const [objective, setObjective] = React.useState<'conversions' | 'revenue' | 'profit'>('conversions')
  const [value, setValue] = React.useState('')
  const [from, setFrom] = React.useState<'starter' | 'history' | 'blank'>(hasHistory ? 'history' : 'starter')
  const [simulate, setSimulate] = React.useState(!hasHistory)
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const r = await createPlanAction({
      name,
      periodStart: start,
      periodEnd: end,
      totalPence: toPence(total),
      objective,
      start: from,
      valuePerConversionPence: value ? toPence(value) : null,
      simulate,
    })
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Plan created' : 'Could not create the plan', body: r.message })
    if (r.ok) {
      onDone?.()
      router.refresh()
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className={compact ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4'}>
        <Field label="Name" className={compact ? 'sm:col-span-2' : 'lg:col-span-2'}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="From">
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </Field>
        <Field label="To">
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </Field>
        <Field label="Total budget (£)" hint="Everything: media, production, tools, people, events, contingency.">
          <Input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} required />
        </Field>
        <Field label="Optimise for" hint={objective === 'profit' ? 'Revenue minus spend. Needs a conversion value if only conversions are tracked.' : undefined}>
          <Select value={objective} onChange={(e) => setObjective(e.target.value as typeof objective)}>
            <option value="conversions">Most conversions</option>
            <option value="revenue">Most revenue</option>
            <option value="profit">Most profit</option>
          </Select>
        </Field>
        {objective === 'profit' && (
          <Field label="Value of a conversion (£)">
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 180" />
          </Field>
        )}
        <Field label="Start the split from">
          <Select value={from} onChange={(e) => setFrom(e.target.value as typeof from)}>
            <option value="starter">A starter split across every kind of cost</option>
            <option value="history" disabled={!hasHistory}>
              Last 12 weeks of actual spend{hasHistory ? '' : ' (no history yet)'}
            </option>
            <option value="blank">Nothing — I’ll add lines</option>
          </Select>
        </Field>
      </div>
      <label className="flex items-start gap-2 text-[13px] text-ink-muted">
        <input type="checkbox" className="mt-0.5" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
        <span>
          Load a simulated market — a year of channel history, platform spend and a card feed with problems planted in it — so the
          allocator and reconciliation have something to work on now. Everything simulated is labelled, and real data replaces it
          channel by channel.
        </span>
      </label>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>
          <Plus className="h-4 w-4" /> Create plan
        </Button>
      </div>
    </form>
  )
}

export function NewPlanButton({ hasHistory }: { hasHistory: boolean }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> New plan
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New budget plan" description="A plan covers one period. Only one plan is live at a time." size="lg">
        <NewPlanForm hasHistory={hasHistory} onDone={() => setOpen(false)} compact />
      </Modal>
    </>
  )
}
