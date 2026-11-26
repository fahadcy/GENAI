'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Building2, CreditCard, FileSpreadsheet, FlaskConical, History, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react'
import {
  addSimulatedCardAction,
  assignTransactionAction,
  connectAirwallexAction,
  enforceCardLimitAction,
  importHistoryAction,
  importStatementAction,
  removeCardAction,
  setCardChannelAction,
  syncCardAction,
  trueLayerStartAction,
} from '@/app/actions/budget'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select } from '@/components/ui/primitives'
import { ConfirmButton, Modal, useToast } from '@/components/ui/client'
import { money, toPence } from '@/lib/budget/money'
import { cn } from '@/lib/cn'

export type CardRow = {
  id: string
  provider: string
  providerLabel: string
  label: string
  last4: string | null
  currency: string
  monthlyLimitPence: number | null
  channelKey: string | null
  status: string
  simulated: boolean
  lastSyncAt: string | null
  lastError: string | null
  consentExpiresAt: string | null
}

export type TxRow = {
  id: string
  postedAt: string
  amountPence: number
  currency: string
  originalAmountMinor: number | null
  originalCurrency: string | null
  descriptor: string
  status: string
  channelKey: string | null
  classifiedVia: string
  ignored: boolean
  simulated: boolean
  cardLabel: string
}

export function CardsPanel({
  cards,
  txs,
  channels,
  canCards,
  canPlan,
  trueLayerReady,
  connectMessage,
}: {
  cards: CardRow[]
  txs: TxRow[]
  channels: { key: string; label: string }[]
  canCards: boolean
  canPlan: boolean
  trueLayerReady: boolean
  connectMessage: { tone: 'ok' | 'error'; text: string } | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [modal, setModal] = React.useState<null | 'csv' | 'airwallex' | 'history'>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState<'unassigned' | 'all'>('all')
  const labelOf = (k: string | null) => channels.find((c) => c.key === k)?.label ?? 'Unassigned'

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message: string; data?: unknown }>, after?: (d: unknown) => void) => {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!(r.ok && after)) toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Done' : 'Could not do that', body: r.message })
    if (r.ok) {
      after?.(r.data)
      router.refresh()
    }
  }

  const shownTx = txs.filter((t) => (filter === 'unassigned' ? !t.channelKey && !t.ignored : true))

  return (
    <div className="space-y-4">
      {connectMessage && (
        <p className={cn('rounded-md px-3 py-2 text-[13px] ring-1', connectMessage.tone === 'ok' ? 'bg-ok-bg text-ok-fg ring-ok-fg/20' : 'bg-danger-bg text-danger-fg ring-danger-fg/20')}>
          {connectMessage.text}
        </p>
      )}
      <Card>
        <CardHeader
          icon={<CreditCard className="h-4 w-4" />}
          title="Cards"
          description="GenAI never sees or stores a card number — last four digits and the provider’s reference only. Read-only cards are monitored; issued cards (Airwallex) can also be capped per line."
        />
        {cards.length === 0 ? (
          <EmptyState icon={<CreditCard className="h-5 w-5" />} title="No card connected" description="Connect one of the ways below. A statement CSV works with every bank and card." />
        ) : (
          <ul className="divide-y divide-line">
            {cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-ink">
                      {c.label}
                      {c.last4 && <span className="font-mono text-ink-muted"> ••{c.last4}</span>}
                    </span>
                    {c.simulated ? <Badge tone="warn">Simulated</Badge> : <Badge>{c.providerLabel}</Badge>}
                    {c.status === 'error' && <Badge tone="danger">Needs attention</Badge>}
                    {c.channelKey && <Badge tone="brand">Only {labelOf(c.channelKey)}</Badge>}
                  </div>
                  <div className="tnum mt-1 text-xs text-ink-muted">
                    {c.monthlyLimitPence ? `Monthly limit ${money(c.monthlyLimitPence)} · ` : ''}
                    {c.lastSyncAt ? `synced ${new Date(c.lastSyncAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'not synced'}
                    {c.consentExpiresAt && ` · reconfirm access by ${new Date(c.consentExpiresAt).toLocaleDateString('en-GB')}`}
                  </div>
                  {c.lastError && <p className="mt-1 text-xs text-danger-fg">{c.lastError}</p>}
                </div>
                {canCards && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label="Dedicate this card to one line"
                      className="h-8 w-auto py-0 text-xs"
                      value={c.channelKey ?? ''}
                      onChange={(e) => run(`ch:${c.id}`, () => setCardChannelAction(c.id, e.target.value || null))}
                    >
                      <option value="">Shared card</option>
                      {channels.map((ch) => (
                        <option key={ch.key} value={ch.key}>
                          Only {ch.label}
                        </option>
                      ))}
                    </Select>
                    {(c.provider === 'airwallex' || c.provider === 'simulated') && <LimitButton card={c} />}
                    {c.provider !== 'csv' && (
                      <Button size="xs" variant="ghost" onClick={() => run(`sync:${c.id}`, () => syncCardAction(c.id))} loading={busy === `sync:${c.id}`}>
                        <RefreshCw className="h-3 w-3" /> Sync
                      </Button>
                    )}
                    {c.provider === 'csv' && (
                      <Button size="xs" variant="ghost" onClick={() => setModal('csv')}>
                        <Upload className="h-3 w-3" /> Import more
                      </Button>
                    )}
                    <ConfirmButton
                      size="xs"
                      variant="ghost"
                      title={`Disconnect ${c.label}?`}
                      description="Its transactions are deleted from GenAI. For Open Banking, also revoke access at your bank."
                      confirmLabel="Disconnect"
                      onConfirm={async () => {
                        await run(`rm:${c.id}`, () => removeCardAction(c.id))
                      }}
                      aria-label="Disconnect card"
                    >
                      <Trash2 className="h-3 w-3" />
                    </ConfirmButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canCards && (
          <div className="grid gap-3 border-t border-line p-5 sm:grid-cols-2 xl:grid-cols-4">
            <Option
              icon={<FileSpreadsheet className="h-4 w-4" />}
              title="Import a statement"
              body="CSV from any UK bank or card. Columns, date order and signs are detected."
              action={<Button size="sm" onClick={() => setModal('csv')}>Upload CSV</Button>}
            />
            <Option
              icon={<Building2 className="h-4 w-4" />}
              title="Open Banking"
              body={trueLayerReady ? 'Read-only access through TrueLayer. UK rules require reconfirming every 90 days.' : 'Read-only access through TrueLayer. Not configured: set TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET.'}
              action={
                <Button
                  size="sm"
                  disabled={!trueLayerReady}
                  loading={busy === 'tl'}
                  onClick={() =>
                    run('tl', () => trueLayerStartAction(), (d) => {
                      const url = (d as { url?: string } | undefined)?.url
                      if (url) window.location.href = url
                    })
                  }
                >
                  Connect bank
                </Button>
              }
            />
            <Option
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Airwallex cards"
              body="Virtual cards you can cap per line from here. A USD balance also avoids FX fees on dollar-billed platforms."
              action={<Button size="sm" onClick={() => setModal('airwallex')}>Connect</Button>}
            />
            <Option
              icon={<FlaskConical className="h-4 w-4" />}
              title="Simulated card"
              body="A fictional card feed built from platform spend, with problems planted for the reconciliation to find."
              action={
                <Button size="sm" variant="ghost" onClick={() => run('sim', () => addSimulatedCardAction())} loading={busy === 'sim'}>
                  Add
                </Button>
              }
            />
          </div>
        )}
        {canPlan && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
            <p className="text-xs text-ink-muted">Channel history for lines GenAI cannot see (events, print, an agency’s channels) gives them response curves too.</p>
            <Button size="xs" variant="ghost" onClick={() => setModal('history')}>
              <History className="h-3 w-3" /> Import channel history
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Transactions"
          description="Every charge, classified from its descriptor. Google prints the paying account’s id; others are matched by platform. Teach GenAI a merchant once and future charges follow."
          actions={
            <div className="flex gap-1">
              {(['all', 'unassigned'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium', filter === f ? 'bg-bg-inset text-ink' : 'text-ink-muted hover:text-ink')}>
                  {f === 'all' ? `All (${txs.length})` : `Unassigned (${txs.filter((t) => !t.channelKey && !t.ignored).length})`}
                </button>
              ))}
            </div>
          }
        />
        {shownTx.length === 0 ? (
          <EmptyState title="No transactions in this period" description="Charges appear here once a card is connected or a statement imported." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="border-b border-line bg-bg-subtle text-left text-2xs uppercase tracking-wide text-ink-faint">
                  <th className="px-5 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Merchant</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                  <th className="px-3 py-2 font-semibold">Line</th>
                  <th className="px-5 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shownTx.slice(0, 300).map((t) => (
                  <TxItem key={t.id} t={t} channels={channels} canPlan={canCards} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <StatementModal open={modal === 'csv'} onClose={() => setModal(null)} cards={cards.filter((c) => c.provider === 'csv')} />
      <AirwallexModal open={modal === 'airwallex'} onClose={() => setModal(null)} />
      <HistoryModal open={modal === 'history'} onClose={() => setModal(null)} />
    </div>
  )
}

function Option({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border border-line p-3.5">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <span className="text-ink-faint">{icon}</span>
          {title}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{body}</p>
      </div>
      <div>{action}</div>
    </div>
  )
}

function TxItem({ t, channels, canPlan }: { t: TxRow; channels: { key: string; label: string }[]; canPlan: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = React.useState(false)
  const [channel, setChannel] = React.useState(t.channelKey ?? '')
  const [remember, setRemember] = React.useState(true)
  const [text, setText] = React.useState(t.descriptor.replace(/[*#]?\s*[A-Z0-9]{6,}$/i, '').trim().slice(0, 40) || t.descriptor.slice(0, 40))
  const [busy, setBusy] = React.useState(false)
  const save = async () => {
    setBusy(true)
    const ignore = channel === '__ignore'
    const r = await assignTransactionAction({ txId: t.id, channelKey: ignore ? null : channel || null, ignore, remember: remember ? text : null })
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Saved' : 'Not saved', body: r.message })
    if (r.ok) {
      setEditing(false)
      router.refresh()
    }
  }
  const label = t.ignored ? 'Not marketing' : (channels.find((c) => c.key === t.channelKey)?.label ?? null)
  return (
    <tr className={cn(t.ignored && 'text-ink-faint')}>
      <td className="tnum whitespace-nowrap px-5 py-2 text-ink-muted">{t.postedAt.slice(0, 10)}</td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs text-ink">{t.descriptor}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {t.status === 'pending' && <Badge tone="info">pending</Badge>}
          {t.simulated && <Badge tone="warn">simulated</Badge>}
          <span className="text-2xs text-ink-faint">{t.cardLabel}</span>
        </div>
      </td>
      <td className="tnum whitespace-nowrap px-3 py-2 text-right">
        <span className={cn(t.amountPence < 0 && 'text-ok-fg')}>{money(t.amountPence, t.currency, { exact: true })}</span>
        {t.originalCurrency && t.originalAmountMinor && (
          <div className="text-2xs text-ink-faint">
            {money(t.originalAmountMinor, t.originalCurrency, { exact: true })}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {label ? (
          <span className="text-xs">
            {label}
            {t.classifiedVia !== 'pattern' && t.classifiedVia !== 'none' && <span className="text-ink-faint"> · {t.classifiedVia}</span>}
          </span>
        ) : (
          <Badge tone="danger">Unassigned</Badge>
        )}
      </td>
      <td className="px-5 py-2 text-right">
        {canPlan && (
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
            Assign
          </Button>
        )}
        <Modal
          open={editing}
          onClose={() => setEditing(false)}
          title="Assign charge"
          description={`${money(t.amountPence)} · ${t.descriptor}`}
          size="sm"
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!channel}>
                Save
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-left">
            <Field label="Budget line">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">Choose…</option>
                {channels.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
                <option value="__ignore">Not marketing — leave it out</option>
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-[13px] text-ink-muted">
              <input type="checkbox" className="mt-0.5" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember: future charges whose description contains this text go to the same place
            </label>
            {remember && <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={80} aria-label="Text to remember" />}
          </div>
        </Modal>
      </td>
    </tr>
  )
}

function LimitButton({ card }: { card: CardRow }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState(card.monthlyLimitPence ? String(card.monthlyLimitPence / 100) : '')
  const [busy, setBusy] = React.useState(false)
  const save = async () => {
    setBusy(true)
    const r = await enforceCardLimitAction(card.id, toPence(value))
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Limit set' : 'Not set', body: r.message })
    if (r.ok) {
      setOpen(false)
      router.refresh()
    }
  }
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Set limit
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Monthly card limit"
        description="Charges past the limit are declined. That stops payment, not delivery: the platform pauses ads and the balance is still owed. Use it as a backstop to platform caps."
        size="sm"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save} loading={busy}>
              Set limit
            </Button>
          </>
        }
      >
        <Field label={`Limit (${card.currency})`}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </Modal>
    </>
  )
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 5_000_000) return reject(new Error('The file is larger than 5 MB.'))
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(new Error('Could not read the file.'))
    r.readAsText(file)
  })
}

function StatementModal({ open, onClose, cards }: { open: boolean; onClose: () => void; cards: CardRow[] }) {
  const router = useRouter()
  const toast = useToast()
  const [cardId, setCardId] = React.useState<string>('')
  const [label, setLabel] = React.useState('Company card')
  const [last4, setLast4] = React.useState('')
  const [sign, setSign] = React.useState<'auto' | 'charges_positive' | 'charges_negative'>('auto')
  const [file, setFile] = React.useState<File | null>(null)
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const text = await readFile(file)
      const r = await importStatementAction({ cardId: cardId || null, label, last4: last4 || null, text, sign })
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Imported' : 'Not imported', body: r.message })
      if (r.ok) {
        onClose()
        router.refresh()
      }
    } catch (e) {
      toast.push({ tone: 'danger', title: 'Not imported', body: e instanceof Error ? e.message : 'Could not read the file.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import a card statement"
      description="Export transactions as CSV from your bank or card portal. Re-importing an overlapping period adds only what is new."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!file}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {cards.length > 0 && (
          <Field label="Card">
            <Select value={cardId} onChange={(e) => setCardId(e.target.value)}>
              <option value="">A new card</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.last4 ? ` ••${c.last4}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {!cardId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Last four digits" hint="Never the full card number.">
              <Input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" />
            </Field>
          </div>
        )}
        <Field label="File">
          <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Purchases in this file are" hint="Usually detected correctly. Change it if refunds come out as charges.">
          <Select value={sign} onChange={(e) => setSign(e.target.value as typeof sign)}>
            <option value="auto">Detect automatically</option>
            <option value="charges_negative">Negative numbers (most bank exports)</option>
            <option value="charges_positive">Positive numbers (most card statements)</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function AirwallexModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [clientId, setClientId] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [demo, setDemo] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    setBusy(true)
    const r = await connectAirwallexAction({ clientId, apiKey, demo })
    setBusy(false)
    toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Connected' : 'Not connected', body: r.message })
    if (r.ok) {
      setApiKey('')
      onClose()
      router.refresh()
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect Airwallex"
      description="Create a restricted API key in Airwallex (Settings → Developer → API keys) with Issuing read and card-update permissions. The key is encrypted at rest and never shown again."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!clientId || !apiKey}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Client ID">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="API key">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-ink-muted">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          Sandbox account
        </label>
      </div>
    </Modal>
  )
}

function HistoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [file, setFile] = React.useState<File | null>(null)
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    if (!file) return
    setBusy(true)
    try {
      const r = await importHistoryAction(await readFile(file))
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.ok ? 'Imported' : 'Not imported', body: r.message })
      if (r.ok) {
        onClose()
        router.refresh()
      }
    } catch (e) {
      toast.push({ tone: 'danger', title: 'Not imported', body: e instanceof Error ? e.message : 'Could not read the file.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import channel history"
      description="One row per week (or day) per channel: week, channel, spend, conversions, revenue. Channel names match the budget line names. Imported history takes priority over GenAI’s own numbers for the same weeks."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit} loading={busy} disabled={!file}>
            Import
          </Button>
        </>
      }
    >
      <pre className="mb-3 overflow-x-auto rounded-md bg-bg-inset p-3 font-mono text-2xs text-ink-muted">
        week,channel,spend,conversions,revenue{'\n'}2026-09-07,Events and sponsorship,1200,14,3400{'\n'}2026-09-07,Google Ads,1850,41,7600
      </pre>
      <Field label="File">
        <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  )
}
