'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { BookmarkPlus, MoreHorizontal, Trash2 } from 'lucide-react'
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives'
import { Modal, useToast } from '@/components/ui/client'
import {
  deleteCampaignAction,
  saveAsTemplateAction,
  setCampaignStatusAction,
} from '@/app/(app)/planner/actions'

const STATUSES = ['draft', 'planning', 'active', 'paused', 'completed', 'archived'] as const

/**
 * Campaign-level controls that sit in the detail header: the status the rest of
 * the product reads, CP-5's "save this shape for next time", and deletion.
 */
export function CampaignActions({
  campaignId,
  campaignName,
  status,
  taskCount,
  canEdit,
}: {
  campaignId: string
  campaignName: string
  status: string
  taskCount: number
  canEdit: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [menu, setMenu] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [name, setName] = React.useState(`${campaignName} playbook`)
  const [description, setDescription] = React.useState('')

  const changeStatus = async (next: string) => {
    setBusy(true)
    try {
      const res = await setCampaignStatusAction(campaignId, next as (typeof STATUSES)[number])
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Status updated' : 'Not updated',
        body: res.message,
      })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const saveTemplate = async () => {
    setBusy(true)
    try {
      const res = await saveAsTemplateAction(campaignId, { name, description })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Template saved' : 'Not saved',
        body: res.ok
          ? `${res.message} Dates became offsets and owners became roles, so it lands correctly whenever it is next used.`
          : res.message,
      })
      if (res.ok) {
        setSaving(false)
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const res = await deleteCampaignAction(campaignId)
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Campaign deleted' : 'Not deleted',
        body: res.message,
      })
      if (res.ok) router.push('/planner')
      else setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit) return null

  return (
    <>
      <Select
        value={status}
        disabled={busy}
        onChange={(e) => void changeStatus(e.target.value)}
        className="h-8 w-[132px] py-0 text-[13px] capitalize"
        aria-label="Campaign status"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s} className="capitalize">
            {s}
          </option>
        ))}
      </Select>

      <Button size="sm" onClick={() => setSaving(true)} disabled={busy || taskCount === 0}>
        <BookmarkPlus className="h-3.5 w-3.5" />
        Save as template
      </Button>

      <div className="relative">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMenu((v) => !v)}
          aria-label="More campaign actions"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menu && (
          <div className="absolute right-0 top-full z-40 mt-1.5 w-52 animate-fade-in overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-pop">
            <button
              type="button"
              onClick={() => {
                setMenu(false)
                setConfirming(true)
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-danger-fg"
            >
              <Trash2 className="h-4 w-4" />
              Delete campaign
            </button>
          </div>
        )}
      </div>

      <Modal
        open={saving}
        onClose={() => !busy && setSaving(false)}
        title="Save this plan as a template"
        description={`All ${taskCount} tasks, their phases, dependencies and gates — with dates stored as offsets from day one.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaving(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={saveTemplate}
              loading={busy}
              disabled={name.trim().length < 3}
            >
              Save template
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Template name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="When to reach for it"
            hint="Written for whoever picks this up in six months, not for you today."
          >
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use for any multi-channel product launch with a legal gate before paid goes live."
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        title={`Delete "${campaignName}"?`}
        description="The plan, its tasks and its dependency graph go with it. Assets and metrics recorded against the campaign are kept."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="danger" size="sm" onClick={remove} loading={busy}>
              Delete campaign
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Save it as a template first if the shape of this plan is worth keeping — the audit trail
          keeps a record of the deletion either way.
        </p>
      </Modal>
    </>
  )
}
