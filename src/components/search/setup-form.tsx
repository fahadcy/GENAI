'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import type { BusinessProfile, ServiceDef } from '@/lib/serptwin'
import { saveBusinessProfileAction } from '@/app/actions/search'
import { Button, Card, CardHeader, Field, Input, Select } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'

const split = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

type ServiceDraft = Omit<ServiceDef, 'keywords' | 'landingPages' | 'weeklyCapacity'> & {
  keywords: string
  landingPages: string
  weeklyCapacity: string
}

export function SetupForm({
  initial,
  isExample,
  adGroups,
  canEdit,
}: {
  initial: BusinessProfile
  isExample: boolean
  adGroups: { id: string; name: string }[]
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const [services, setServices] = React.useState<ServiceDraft[]>(
    initial.services.map((s) => ({
      ...s,
      keywords: s.keywords.join(', '),
      landingPages: s.landingPages.join(', '),
      weeklyCapacity: s.weeklyCapacity === null ? '' : String(s.weeklyCapacity),
    })),
  )
  const [areas, setAreas] = React.useState(initial.serviceAreas.join(', '))
  const [notOffered, setNotOffered] = React.useState(initial.notOffered.join(', '))
  const [sla, setSla] = React.useState(String(initial.followUpSlaHours))
  const [attempts, setAttempts] = React.useState(String(initial.unreachableAfterAttempts))
  const [maxChange, setMaxChange] = React.useState(String(Math.round(initial.maxWeeklyBudgetChange * 100)))

  const set = (i: number, patch: Partial<ServiceDraft>) =>
    setServices((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const toggleAg = (i: number, id: string) =>
    set(i, {
      adGroupIds: services[i]!.adGroupIds.includes(id)
        ? services[i]!.adGroupIds.filter((x) => x !== id)
        : [...services[i]!.adGroupIds, id],
    })

  const save = async () => {
    setBusy(true)
    try {
      const profile: BusinessProfile = {
        services: services.map((s) => ({
          id: s.id.trim(),
          name: s.name.trim(),
          keywords: split(s.keywords),
          adGroupIds: s.adGroupIds,
          marginPerCustomer: Number(s.marginPerCustomer) || 0,
          weeklyCapacity: s.weeklyCapacity.trim() === '' ? null : Math.floor(Number(s.weeklyCapacity)),
          bookedThisWeek: Math.floor(Number(s.bookedThisWeek) || 0),
          landingPages: split(s.landingPages),
          growthPriority: s.growthPriority,
        })),
        serviceAreas: split(areas).map((a) => a.toUpperCase()),
        notOffered: split(notOffered),
        followUpSlaHours: Number(sla),
        unreachableAfterAttempts: Math.floor(Number(attempts)),
        maxWeeklyBudgetChange: Number(maxChange) / 100,
      }
      const res = await saveBusinessProfileAction(profile)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Business setup saved' : 'Not saved',
        body: res.message,
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {isExample && (
        <p className="rounded-lg border border-warn-fg/25 bg-warn-bg px-3 py-2 text-[13px] text-ink">
          This is the example setup for the simulated account. Replace it with your own services and numbers.
        </p>
      )}
      {!canEdit && (
        <p className="text-[13px] text-ink-muted">
          Only owners and marketing ops can change this, because it steers budget recommendations.
        </p>
      )}

      {services.map((s, i) => (
        <Card key={i}>
          <CardHeader
            title={s.name || 'New service'}
            description="One thing you sell. Keep capacity and bookings current each week."
            actions={
              canEdit && services.length > 1 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setServices((xs) => xs.filter((_, j) => j !== i))}
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              ) : undefined
            }
          />
          <fieldset disabled={!canEdit} className="grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-4">
            <Field label="Name">
              <Input id={`s-${i}-name`} value={s.name} onChange={(e) => set(i, { name: e.target.value })} />
            </Field>
            <Field label="Short id" hint="Lower case, no spaces">
              <Input
                id={`s-${i}-id`}
                value={s.id}
                onChange={(e) => set(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
              />
            </Field>
            <Field label="Profit per new customer (£)" hint="Gross profit, first year">
              <Input
                id={`s-${i}-margin`}
                type="number"
                min={0}
                value={s.marginPerCustomer}
                onChange={(e) => set(i, { marginPerCustomer: Number(e.target.value) })}
              />
            </Field>
            <Field label="Growth">
              <Select
                id={`s-${i}-growth`}
                value={s.growthPriority}
                onChange={(e) => set(i, { growthPriority: e.target.value as ServiceDef['growthPriority'] })}
              >
                <option value="grow">Grow</option>
                <option value="maintain">Maintain</option>
                <option value="reduce">Reduce</option>
              </Select>
            </Field>
            <Field label="New customers you can take a week" hint="Blank = no practical limit">
              <Input
                id={`s-${i}-cap`}
                type="number"
                min={0}
                value={s.weeklyCapacity}
                onChange={(e) => set(i, { weeklyCapacity: e.target.value })}
              />
            </Field>
            <Field label="Already booked this week">
              <Input
                id={`s-${i}-booked`}
                type="number"
                min={0}
                value={s.bookedThisWeek}
                onChange={(e) => set(i, { bookedThisWeek: Number(e.target.value) })}
              />
            </Field>
            <Field label="Words that mean this service" hint="Comma separated" className="md:col-span-2">
              <Input
                id={`s-${i}-kw`}
                value={s.keywords}
                onChange={(e) => set(i, { keywords: e.target.value })}
              />
            </Field>
            <Field label="Landing pages" hint="Full URLs, comma separated" className="md:col-span-2">
              <Input
                id={`s-${i}-pages`}
                value={s.landingPages}
                onChange={(e) => set(i, { landingPages: e.target.value })}
              />
            </Field>
            <div className="md:col-span-2">
              <span className="label">Ad groups that promote it</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {adGroups.length === 0 && (
                  <span className="text-xs text-ink-faint">Run an analysis to list your ad groups.</span>
                )}
                {adGroups.map((g) => {
                  const on = s.adGroupIds.includes(g.id)
                  return (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleAg(i, g.id)}
                      className={
                        on
                          ? 'rounded-full border border-brand-600 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700'
                          : 'rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted'
                      }
                    >
                      {g.name}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-2xs text-ink-faint">
                Leave brand campaigns out: you cannot buy more searches for your own name.
              </p>
            </div>
          </fieldset>
        </Card>
      ))}
      {canEdit && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setServices((xs) => [
              ...xs,
              {
                id: `service-${xs.length + 1}`,
                name: '',
                keywords: '',
                adGroupIds: [],
                marginPerCustomer: 0,
                weeklyCapacity: '',
                bookedThisWeek: 0,
                landingPages: '',
                growthPriority: 'maintain',
              },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add a service
        </Button>
      )}

      <Card>
        <CardHeader title="Across the business" />
        <fieldset disabled={!canEdit} className="grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-3">
          <Field label="Where you can deliver" hint="Country codes or UK postcode areas: GB, IE, GB:M">
            <Input id="areas" value={areas} onChange={(e) => setAreas(e.target.value)} />
          </Field>
          <Field
            label="Things you do not offer"
            hint="Comma separated; enquiries asking for these are flagged"
            className="lg:col-span-2"
          >
            <Input id="not-offered" value={notOffered} onChange={(e) => setNotOffered(e.target.value)} />
          </Field>
          <Field label="Reply to new enquiries within (working hours)">
            <Input
              id="sla"
              type="number"
              min={0.25}
              step={0.25}
              value={sla}
              onChange={(e) => setSla(e.target.value)}
            />
          </Field>
          <Field label="Unreachable after this many attempts" hint="Never counted as a bad lead">
            <Input
              id="attempts"
              type="number"
              min={1}
              value={attempts}
              onChange={(e) => setAttempts(e.target.value)}
            />
          </Field>
          <Field label="Largest weekly budget move (%)">
            <Input
              id="max-change"
              type="number"
              min={1}
              max={50}
              value={maxChange}
              onChange={(e) => setMaxChange(e.target.value)}
            />
          </Field>
        </fieldset>
      </Card>

      {canEdit && (
        <Button variant="primary" loading={busy} onClick={save}>
          Save business setup
        </Button>
      )}
    </div>
  )
}
