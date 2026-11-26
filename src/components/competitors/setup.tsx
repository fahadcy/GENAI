'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Building2, MapPin, Plus, Search, X } from 'lucide-react'
import { draftProfileAction, findCompaniesAction, saveProfileAction } from '@/app/actions/competitors'
import type { CompanyProfile, Scope } from '@/lib/competitors/types'
import type { RegisterHit } from '@/lib/competitors/sources/register'
import { Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { cn } from '@/lib/cn'
import { RefreshProgress, useRefresh } from './refresh'

/**
 * Two steps. First, who you are: picked from Companies House when it is
 * connected, typed in otherwise. Second, what you do and how customers find
 * you, drafted by the classifier and corrected by a person — the searches on
 * this screen are what every competitor is measured against, so they deserve
 * a human look.
 */

const SCOPES: { value: Scope; label: string; blurb: string }[] = [
  { value: 'local', label: 'Local', blurb: 'Customers come from nearby: trades, clinics, shops, restaurants.' },
  { value: 'hybrid', label: 'Local and national', blurb: 'Work comes from anywhere, but being local still matters: law, accountancy, insolvency.' },
  { value: 'national', label: 'National', blurb: 'Sold online or nationwide; location barely matters.' },
]

export function ProfileSetup({
  companiesHouse,
  initial,
  firstRun,
}: {
  companiesHouse: boolean
  initial: CompanyProfile | null
  /** On first setup, saving runs discovery and the first analysis straight away. */
  firstRun: boolean
}) {
  const [draft, setDraft] = React.useState<CompanyProfile | null>(initial)
  return draft ? (
    <ProfileEditor profile={draft} onBack={initial ? undefined : () => setDraft(null)} firstRun={firstRun} />
  ) : (
    <FindCompany companiesHouse={companiesHouse} onDraft={setDraft} />
  )
}

function FindCompany({ companiesHouse, onDraft }: { companiesHouse: boolean; onDraft: (p: CompanyProfile) => void }) {
  const toast = useToast()
  const [mode, setMode] = React.useState<'register' | 'manual'>(companiesHouse ? 'register' : 'manual')
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<RegisterHit[] | null>(null)
  const [picked, setPicked] = React.useState<RegisterHit | null>(null)
  const [name, setName] = React.useState('')
  const [domain, setDomain] = React.useState('')
  const [postcode, setPostcode] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim().length < 2) return
    setBusy(true)
    try {
      const r = await findCompaniesAction(query)
      if (!r.ok) toast.push({ tone: 'danger', title: 'Search failed', body: r.message })
      setHits(r.data ?? [])
    } finally {
      setBusy(false)
    }
  }

  const draft = async () => {
    setBusy(true)
    try {
      const r = await draftProfileAction(
        mode === 'register' && picked
          ? { companyNumber: picked.companyNumber, domain: domain || null, postcode: postcode || null }
          : { companyName: name, domain: domain || null, postcode: postcode || null },
      )
      if (!r.ok || !r.data) {
        toast.push({ tone: 'danger', title: 'Could not read that', body: r.message })
        return
      }
      onDraft(r.data)
    } finally {
      setBusy(false)
    }
  }

  const ready = mode === 'register' ? Boolean(picked) : name.trim().length >= 2

  return (
    <Card>
      <CardHeader
        title="Who are you?"
        description="Competitors are found from what your business does, where it is and the searches your customers make."
        icon={<Building2 className="h-4 w-4" />}
      />
      <div className="space-y-5 p-5">
        {companiesHouse && (
          <div className="flex gap-1 rounded-lg bg-bg-inset p-1 text-[13px]" role="tablist">
            {(['register', 'manual'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 rounded-md px-3 py-1.5 font-medium',
                  mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                )}
              >
                {m === 'register' ? 'Find on Companies House' : 'Type it in'}
              </button>
            ))}
          </div>
        )}

        {mode === 'register' ? (
          <div className="space-y-3">
            <form onSubmit={search} className="flex gap-2">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Your company name" autoFocus />
              <Button type="submit" variant="secondary" loading={busy && !picked}>
                {!busy && <Search className="h-3.5 w-3.5" />}
                Search
              </Button>
            </form>
            {hits && hits.length === 0 && <p className="text-[13px] text-ink-muted">No companies match. Try the registered name.</p>}
            {hits && hits.length > 0 && (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                {hits.map((h) => (
                  <li key={h.companyNumber}>
                    <button
                      onClick={() => setPicked(h)}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left text-[13px] hover:bg-surface-hover',
                        picked?.companyNumber === h.companyNumber && 'bg-brand-50',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{h.name}</span>
                        <span className="block truncate text-xs text-ink-faint">
                          {h.companyNumber} · {h.address ?? 'no address'}
                        </span>
                      </span>
                      <Badge tone={h.status === 'active' ? 'ok' : 'neutral'}>{h.status ?? 'unknown'}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <Field label="Company name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Currie Young Ltd" autoFocus={!companiesHouse} />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your website" hint="Read to describe what you do, and compared with every competitor.">
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.co.uk" inputMode="url" />
          </Field>
          <Field
            label="Postcode"
            hint={mode === 'register' ? 'Leave blank to use the registered office.' : 'Where customers find you, for local competitors.'}
          >
            <Input value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="M2 3AW" autoComplete="postal-code" />
          </Field>
        </div>

        {!companiesHouse && (
          <p className="text-xs leading-relaxed text-ink-faint">
            Companies House is not connected, so the register cannot be searched. Add COMPANIES_HOUSE_API_KEY (free) to look your company up and find
            same-industry companies.
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="primary" onClick={draft} disabled={!ready} loading={busy && ready}>
            Continue
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ProfileEditor({ profile, onBack, firstRun }: { profile: CompanyProfile; onBack?: () => void; firstRun: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const { run, steps, busy: running } = useRefresh()
  const [p, setP] = React.useState<CompanyProfile>(profile)
  const [newKw, setNewKw] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const update = (patch: Partial<CompanyProfile>) => setP((x) => ({ ...x, ...patch, source: 'manual' }))

  const addKeyword = () => {
    const k = newKw.trim()
    if (k.length < 2 || p.keywords.some((x) => x.toLowerCase() === k.toLowerCase()) || p.keywords.length >= 10) return
    update({ keywords: [...p.keywords, k] })
    setNewKw('')
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await saveProfileAction({ ...p, domain: p.domain?.trim() || null, postcode: p.postcode?.trim() || null })
      if (!r.ok) {
        toast.push({ tone: 'danger', title: 'Not saved', body: r.message })
        return
      }
      if (firstRun) {
        await run({ discover: true, trackedIds: [] })
        router.push('/competitors')
      } else {
        toast.push({ tone: 'ok', title: 'Saved', body: 'Find competitors again to use the new searches.' })
        router.refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="What you do and how customers find you"
          description={
            p.source === 'manual'
              ? 'Edited by you.'
              : p.source === 'ai'
                ? `Drafted from ${p.domain ? 'your website, ' : ''}your name${p.sicCodes.length ? ' and SIC codes' : ''}. Check it: every competitor is measured against these searches.`
                : 'Drafted from your name and SIC codes with built-in rules. Check it: every competitor is measured against these searches.'
          }
          actions={p.confidence < 0.5 && p.source !== 'manual' ? <Badge tone="warn">Low confidence — please check</Badge> : undefined}
        />
        <div className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company" required>
              <Input value={p.companyName} onChange={(e) => update({ companyName: e.target.value })} />
            </Field>
            <Field label="What the business does" required hint="In a customer's words, e.g. “insolvency practitioner”.">
              <Input value={p.businessType} onChange={(e) => update({ businessType: e.target.value })} />
            </Field>
          </div>

          <Field
            label="Searches customers use to find you"
            hint="Up to ten. Each is searched on Google for every competitor, so keep them to real buying searches."
          >
            <div className="flex flex-wrap gap-1.5">
              {p.keywords.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-md bg-bg-inset py-1 pl-2.5 pr-1 text-[13px] text-ink">
                  {k}
                  <button
                    onClick={() => update({ keywords: p.keywords.filter((x) => x !== k) })}
                    className="rounded p-0.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
                    aria-label={`Remove ${k}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                value={newKw}
                onChange={(e) => setNewKw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addKeyword()
                  }
                }}
                placeholder="Add a search, e.g. company liquidation cost"
                disabled={p.keywords.length >= 10}
              />
              <Button variant="secondary" onClick={addKeyword} disabled={p.keywords.length >= 10}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          </Field>

          <Field label="Where you compete">
            <div className="grid gap-2 sm:grid-cols-3">
              {SCOPES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => update({ scope: s.value, radiusKm: s.value === 'local' ? 8 : s.value === 'hybrid' ? 25 : 50 })}
                  aria-pressed={p.scope === s.value}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    p.scope === s.value ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-line-strong',
                  )}
                >
                  <span className="block text-[13px] font-semibold text-ink">{s.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{s.blurb}</span>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Website">
              <Input value={p.domain ?? ''} onChange={(e) => update({ domain: e.target.value })} placeholder="yourcompany.co.uk" />
            </Field>
            <Field label="Postcode" hint={p.locality ? `${p.locality}` : undefined}>
              <Input value={p.postcode ?? ''} onChange={(e) => update({ postcode: e.target.value })} placeholder="M2 3AW" />
            </Field>
            <Field label="Local radius" hint="How far nearby competitors are looked for.">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={p.radiusKm}
                  onChange={(e) => update({ radiusKm: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
                  className="w-24"
                />
                <span className="text-[13px] text-ink-muted">km</span>
              </div>
            </Field>
          </div>

          {(p.companyNumber || p.sicCodes.length > 0) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
              {p.companyNumber && <span>Company number {p.companyNumber}</span>}
              {p.sicCodes.length > 0 && <span>SIC {p.sicCodes.join(', ')}</span>}
              {p.lat !== null && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  located
                </span>
              )}
            </p>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={saving || running}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" size="lg" onClick={save} loading={saving || running} disabled={p.keywords.length === 0}>
          {firstRun ? 'Save and find my competitors' : 'Save'}
        </Button>
      </div>

      <RefreshProgress steps={steps} busy={running} />
    </div>
  )
}
