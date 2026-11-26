'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Globe2, Landmark } from 'lucide-react'
import { Card, CardHeader, Input, Select } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { updateWorkspaceGeneral } from '@/app/(app)/settings/actions'
import { CURRENCIES, RESIDENCY, TIMEZONES } from './plans'
import { ReadOnlyNotice, SaveBar, SettingRow } from './bits'

export type GeneralValues = {
  name: string
  defaultTimezone: string
  currency: 'GBP' | 'EUR' | 'USD'
  weekStartsOn: number
  dataResidency: 'eu' | 'uk' | 'us'
  requireApprovalAboveSpend: number
}

export function WorkspaceGeneralForm({
  initial,
  canEdit,
  slug,
  createdAt,
}: {
  initial: GeneralValues
  canEdit: boolean
  slug: string
  createdAt: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [form, setForm] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)

  // The saved values are the baseline for "dirty", so a save that succeeds
  // clears the bar without a round trip through the router.
  const [baseline, setBaseline] = React.useState(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)

  const set = <K extends keyof GeneralValues>(key: K, value: GeneralValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const save = async () => {
    setSaving(true)
    try {
      const result = await updateWorkspaceGeneral(form)
      toast.push({ tone: result.ok ? 'ok' : 'danger', title: result.message })
      if (result.ok) {
        setBaseline(form)
        router.refresh()
      }
    } finally {
      setSaving(false)
    }
  }

  const residency = RESIDENCY.find((r) => r.value === form.dataResidency)

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Workspace"
          description="Identity and the defaults every campaign, schedule and report inherits."
          icon={<Landmark className="h-4 w-4" />}
        />

        {!canEdit && (
          <div className="border-b border-line px-5 py-3">
            <ReadOnlyNotice what="these settings" />
          </div>
        )}

        <SettingRow
          label="Workspace name"
          hint="Appears in the sidebar, on exports and in every invitation email."
          htmlFor="ws-name"
        >
          <Input
            id="ws-name"
            value={form.name}
            disabled={!canEdit}
            maxLength={80}
            onChange={(e) => set('name', e.target.value)}
          />
        </SettingRow>

        <SettingRow label="Workspace URL" hint="Fixed after creation — audit exports are filed under it.">
          <div className="flex h-9 items-center rounded-lg border border-line bg-bg-subtle px-3 text-sm text-ink-muted">
            <span className="text-ink-faint">genai.app/</span>
            <span className="font-medium text-ink">{slug}</span>
          </div>
        </SettingRow>

        <SettingRow
          label="Default timezone"
          hint="Schedule slots, blackout windows and every report boundary are resolved in this zone unless a send overrides it."
          htmlFor="ws-tz"
        >
          <Select
            id="ws-tz"
            value={form.defaultTimezone}
            disabled={!canEdit}
            onChange={(e) => set('defaultTimezone', e.target.value)}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow label="Week starts on" hint="Used by the scheduler calendar and weekly rollups." htmlFor="ws-week">
          <Select
            id="ws-week"
            value={String(form.weekStartsOn)}
            disabled={!canEdit}
            onChange={(e) => set('weekStartsOn', Number(e.target.value))}
          >
            <option value="1">Monday</option>
            <option value="0">Sunday</option>
          </Select>
        </SettingRow>

        <SettingRow
          label="Reporting currency"
          hint="Budgets, spend and cost-per-outcome are shown in this currency across the product."
          htmlFor="ws-currency"
        >
          <Select
            id="ws-currency"
            value={form.currency}
            disabled={!canEdit}
            onChange={(e) => set('currency', e.target.value as GeneralValues['currency'])}
          >
            {CURRENCIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </SettingRow>
      </Card>

      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title="Residency and thresholds"
          description="Where this workspace's data physically lives, and the spend at which sign-off becomes mandatory."
          icon={<Globe2 className="h-4 w-4" />}
        />

        <SettingRow
          label="Data residency"
          hint={residency ? residency.detail : 'Contacts, assets and the audit trail are stored in this region.'}
          htmlFor="ws-residency"
        >
          <Select
            id="ws-residency"
            value={form.dataResidency}
            disabled={!canEdit}
            onChange={(e) => set('dataResidency', e.target.value as GeneralValues['dataResidency'])}
          >
            {RESIDENCY.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow
          label="Mandatory approval above"
          hint="Any campaign carrying more spend than this matches the high-spend approval chain, whatever channel it runs on."
          htmlFor="ws-spend"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-faint">
              {form.currency === 'GBP' ? '£' : form.currency === 'EUR' ? '€' : '$'}
            </span>
            <Input
              id="ws-spend"
              type="number"
              min={0}
              step={100}
              className="tnum"
              value={form.requireApprovalAboveSpend}
              disabled={!canEdit}
              onChange={(e) => set('requireApprovalAboveSpend', Number(e.target.value))}
            />
          </div>
        </SettingRow>
      </Card>

      <p className="mt-3 px-1 text-2xs text-ink-faint">
        Workspace created {new Date(createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
      </p>

      {canEdit && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          onSave={save}
          onReset={() => setForm(baseline)}
          summary="Workspace settings changed."
        />
      )}
    </>
  )
}
