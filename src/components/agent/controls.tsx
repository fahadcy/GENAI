'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Mail, Send, Sparkles, Telescope } from 'lucide-react'
import {
  askAction,
  chooseBusinessAction,
  connectCrmAction,
  connectGithubAction,
  disconnectAction,
  runGoalAction,
  saveAnswersAction,
  saveScheduleAction,
  saveTargetsAction,
} from '@/app/actions/agent'
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

function useAction() {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = async <T,>(key: string, fn: () => Promise<{ ok: boolean; message: string; data?: T }>, then?: (d: T | undefined) => void) => {
    if (busy) return
    setBusy(key)
    try {
      const r = await fn()
      toast.push({ tone: r.ok ? 'ok' : 'danger', title: r.message })
      if (r.ok || r.data) { then?.(r.data); router.refresh() }
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

/* ------------------------------------------------------------------ ask */

export function AskBox({ disabled }: { disabled?: boolean }) {
  const { busy, run } = useAction()
  const router = useRouter()
  const [q, setQ] = React.useState('')
  const examples = ['What needs my attention today?', 'Which leads are going cold?', 'Which channel wins us the most cases?']
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        run('ask', () => askAction(q), (d) => { setQ(''); if (d?.id) router.push(`/agent/runs/${d.id}`) })
      }}
    >
      <label htmlFor="agent-ask" className="sr-only">Ask the growth agent</label>
      <div className="flex gap-2">
        <Input id="agent-ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your pipeline, leads or what to do next…" disabled={disabled || !!busy} maxLength={2000} />
        <Button type="submit" variant="primary" disabled={disabled || !!busy || q.trim().length < 3}>
          {busy ? <Spinner /> : <Send className="h-4 w-4" />}
          Ask
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((x) => (
          <button key={x} type="button" onClick={() => setQ(x)} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink">
            {x}
          </button>
        ))}
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- routines */

export function RunButtons({ canRun, canOutreach, outreachReady, outreachWhy, siteConnected, chConnected }: {
  canRun: boolean; canOutreach: boolean; outreachReady: boolean; outreachWhy: string; siteConnected: boolean; chConnected: boolean
}) {
  const { busy, run } = useAction()
  const router = useRouter()
  const go = (goal: 'daily_brief' | 'find_leads' | 'outreach' | 'content') =>
    run(goal, () => runGoalAction(goal), (d) => d?.id && router.push(`/agent/runs/${d.id}`))
  const items = [
    { goal: 'daily_brief' as const, icon: Sparkles, label: 'Daily brief', note: 'What in the pipeline needs attention; follow-up tasks for leads going cold.', ok: canRun, why: '' },
    { goal: 'find_leads' as const, icon: Telescope, label: 'Find leads', note: 'Companies House and Gazette, scored for fit; the best added to the CRM\'s New column.', ok: canRun && chConnected, why: chConnected ? '' : 'Needs COMPANIES_HOUSE_API_KEY' },
    { goal: 'outreach' as const, icon: Mail, label: 'Send due emails', note: 'Introductions and follow-ups within the CRM\'s rules.', ok: canOutreach && outreachReady, why: !canOutreach ? 'Owners and marketing ops only' : outreachWhy },
    { goal: 'content' as const, icon: FileText, label: 'Draft website content', note: 'One blog post or landing page as a draft pull request.', ok: canRun && siteConnected, why: siteConnected ? 'Needs a language model key to write' : 'Connect the website repository' },
  ]
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((it) => (
        <button
          key={it.goal}
          type="button"
          disabled={!it.ok || !!busy}
          onClick={() => go(it.goal)}
          className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-line-strong hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-55"
        >
          <span className="mt-0.5 text-brand-700">{busy === it.goal ? <Spinner /> : <it.icon className="h-4 w-4" />}</span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{it.label}</span>
            <span className="block text-xs text-ink-muted">{it.note}</span>
            {!it.ok && it.why && <span className="mt-1 block text-2xs font-medium text-warn-fg">{it.why}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------- connections */

export function ConnectCrmForm({ initialUrl, connected }: { initialUrl?: string | null; connected: boolean }) {
  const { busy, run } = useAction()
  const [url, setUrl] = React.useState(initialUrl ?? 'https://crm.cy-group.co.uk')
  const [token, setToken] = React.useState('')
  const [choices, setChoices] = React.useState<{ id: number; name: string }[] | null>(null)
  return (
    <div className="space-y-3">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run('crm', () => connectCrmAction({ crmUrl: url, crmToken: token }), (d) => { setToken(''); if (d && d.businesses.length > 1) setChoices(d.businesses) }) }}>
        <Field label="CRM address" hint="Where the CRM is hosted, e.g. https://crm.cy-group.co.uk">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} required />
        </Field>
        <Field label={connected ? 'New agent token (to replace the current one)' : 'Agent token'} hint="CRM → Admin → Growth agent → Access tokens. Starts with cya_. Stored encrypted.">
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="cya_…" autoComplete="off" spellCheck={false} required />
        </Field>
        <Button type="submit" variant="primary" disabled={!!busy}>{busy === 'crm' && <Spinner />}{connected ? 'Replace token' : 'Connect the CRM'}</Button>
      </form>
      {choices && <ChooseBusiness businesses={choices} />}
    </div>
  )
}

export function ChooseBusiness({ businesses, current }: { businesses: { id: number; name: string }[]; current?: number | null }) {
  const { busy, run } = useAction()
  const [id, setId] = React.useState<number>(current ?? businesses[0]?.id ?? 0)
  return (
    <div className="flex items-end gap-2">
      <Field label="Which business does the agent work for?" className="flex-1">
        <Select value={id} onChange={(e) => setId(Number(e.target.value))}>
          {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </Field>
      <Button onClick={() => run('biz', () => chooseBusinessAction(id))} disabled={!!busy}>Save</Button>
    </div>
  )
}

export function ConnectGithubForm({ repo }: { repo: string | null }) {
  const { busy, run } = useAction()
  const [r, setR] = React.useState(repo ?? '')
  const [t, setT] = React.useState('')
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run('gh', () => connectGithubAction({ repo: r, token: t }), () => setT('')) }}>
      <Field label="Website repository" hint="owner/name on GitHub, e.g. cy-group/easyliquidations">
        <Input value={r} onChange={(e) => setR(e.target.value)} required />
      </Field>
      <Field label="GitHub token" hint="Fine-grained token for that one repository: Contents and Pull requests, read and write. Stored encrypted. The agent only ever opens draft pull requests.">
        <Input value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" spellCheck={false} required />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!!busy}>{busy === 'gh' && <Spinner />}{repo ? 'Replace' : 'Connect website'}</Button>
        {repo && <Button type="button" variant="ghost" onClick={() => run('ghx', () => disconnectAction('github'))}>Disconnect</Button>}
      </div>
    </form>
  )
}

export function DisconnectCrm() {
  const { busy, run } = useAction()
  return <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => run('crmx', () => disconnectAction('crm'))}>Disconnect CRM</Button>
}

/* ----------------------------------------------------------- schedule */

export function ScheduleForm({ initial, canConfigure, canOutreach, outreachAllowedByCrm }: {
  initial: { dailyBrief: boolean; findLeads: boolean; outreach: boolean }; canConfigure: boolean; canOutreach: boolean; outreachAllowedByCrm: boolean
}) {
  const { busy, run } = useAction()
  const [s, setS] = React.useState(initial)
  const rows = [
    { k: 'dailyBrief' as const, label: 'Daily brief', when: 'Weekdays 07:40', disabled: !canConfigure },
    { k: 'findLeads' as const, label: 'Find leads', when: 'Mondays and Thursdays 09:10', disabled: !canConfigure },
    { k: 'outreach' as const, label: 'Send due emails', when: 'Weekdays 09:40', disabled: !canOutreach || (!outreachAllowedByCrm && !s.outreach), note: outreachAllowedByCrm ? undefined : 'Needs the outreach scope on the CRM token and outreach switched on in the CRM' },
  ]
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <label key={r.k} className="flex items-start gap-3 rounded-lg px-1 py-1.5">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--brand-solid))]" checked={s[r.k]} disabled={r.disabled} onChange={(e) => setS({ ...s, [r.k]: e.target.checked })} />
          <span>
            <span className="block text-sm font-medium text-ink">{r.label}</span>
            <span className="block text-xs text-ink-muted">{r.when} (UK time){r.note ? ` · ${r.note}` : ''}</span>
          </span>
        </label>
      ))}
      {canConfigure && <Button size="sm" onClick={() => run('sched', () => saveScheduleAction(s))} disabled={!!busy}>Save schedule</Button>}
    </div>
  )
}

/* ------------------------------------------------------------ targets */

export function TargetsForm({ initial, canEdit }: { initial: { sicCodes: string[]; locations: string[]; excludedSections: string[]; incorporatedFrom?: string | null }; canEdit: boolean }) {
  const { busy, run } = useAction()
  const [sic, setSic] = React.useState(initial.sicCodes.join(', '))
  const [loc, setLoc] = React.useState(initial.locations.join('\n'))
  const [ex, setEx] = React.useState(initial.excludedSections.join(', '))
  const [from, setFrom] = React.useState(initial.incorporatedFrom ?? '')
  const split = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run('targets', () => saveTargetsAction({ sicCodes: split(sic), locations: split(loc), excludedSections: split(ex), incorporatedFrom: from || null })) }}>
      <Field label="Sectors (SIC codes)" hint="Five-digit codes, comma separated. e.g. 41100 building, 43999 trades, 56101 restaurants. Petitioned companies are always included.">
        <Input value={sic} onChange={(e) => setSic(e.target.value)} disabled={!canEdit} placeholder="41100, 43999, 56101" />
      </Field>
      <Field label="Areas" hint="One per line, as Companies House understands them: a town or postcode area.">
        <Textarea rows={3} value={loc} onChange={(e) => setLoc(e.target.value)} disabled={!canEdit} placeholder={'Stoke-on-Trent\nStaffordshire'} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Never these sectors" hint="Section letters, e.g. K (finance), O (public).">
          <Input value={ex} onChange={(e) => setEx(e.target.value)} disabled={!canEdit} placeholder="K, O" />
        </Field>
        <Field label="Incorporated after" hint="Optional.">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!canEdit} />
        </Field>
      </div>
      {canEdit && <Button size="sm" type="submit" disabled={!!busy}>Save targets</Button>}
    </form>
  )
}

/* ---------------------------------------------------------- questions */

const FIELD_TO_ANSWER: Record<string, string> = {
  services: 'services', targets: '', capacityPerMonth: 'capacityPerMonth', idealCustomer: 'idealCustomer',
  competitors: 'competitors', voice: 'voice', monthlyGoal: 'monthlyGoal',
}

export function QuestionsForm({ questions, answers, canEdit }: { questions: { field: string; question: string; why: string }[]; answers: Record<string, string>; canEdit: boolean }) {
  const { busy, run } = useAction()
  const [vals, setVals] = React.useState<Record<string, string>>(answers)
  const open = questions.filter((q) => FIELD_TO_ANSWER[q.field] !== '')
  const feeQ = questions.find((q) => /fee cover/i.test(q.question))
  if (!open.length) return <p className="text-sm text-ink-muted">Nothing to ask right now. The agent has what it needs.</p>
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run('answers', () => saveAnswersAction(vals)) }}>
      {open.slice(0, 4).map((q) => {
        const key = feeQ === q ? 'feeScope' : FIELD_TO_ANSWER[q.field] ?? q.field
        return (
          <Field key={q.field + q.question} label={q.question} hint={q.why}>
            <Textarea rows={2} value={vals[key] ?? ''} onChange={(e) => setVals({ ...vals, [key]: e.target.value })} disabled={!canEdit} />
          </Field>
        )
      })}
      {canEdit && <Button size="sm" variant="primary" type="submit" disabled={!!busy}>Save answers</Button>}
      {open.length > 4 && <p className="text-xs text-ink-muted">{open.length - 4} more after these.</p>}
    </form>
  )
}

export function ScopeBadges({ scopes }: { scopes: string[] }) {
  return <span className="inline-flex flex-wrap gap-1">{scopes.map((s) => <Badge key={s} tone={s === 'outreach' ? 'warn' : 'neutral'}>{s}</Badge>)}</span>
}
