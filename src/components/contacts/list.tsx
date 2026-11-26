'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Ban,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button, Card, EmptyState, Input, Select } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/client'
import { RelativeTime } from '@/components/domain'
import { BASIS_BY_VALUE, BASIS_OPTIONS, type ConsentBasis } from '@/lib/contacts/consent'
import {
  deleteContactAction,
  saveContactAction,
  setSuppressedAction,
  type ContactInput,
} from '@/app/actions/contacts'
import type { ContactRow, ContactFilter } from '@/app/(app)/contacts/queries'

/**
 * The list itself.
 *
 * The column that earns its place is "can we contact them" — not because it is
 * interesting, but because it is the difference between a segment of 500 and a
 * send of 40, and that gap is otherwise only discovered at the moment somebody
 * presses publish.
 */

const FILTERS: { value: ContactFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'emailable', label: 'Can be emailed' },
  { value: 'textable', label: 'Can be texted' },
  { value: 'no_consent', label: 'No permission yet' },
  { value: 'suppressed', label: 'Unsubscribed' },
]

export function ContactList({
  rows,
  total,
  page,
  pages,
  canManage,
}: {
  rows: ContactRow[]
  total: number
  page: number
  pages: number
  canManage: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [editing, setEditing] = React.useState<ContactRow | 'new' | null>(null)
  const [q, setQ] = React.useState(params.get('q') ?? '')

  const filter = (params.get('filter') as ContactFilter) ?? 'all'

  const push = React.useCallback(
    (next: Record<string, string | undefined>) => {
      const sp = new URLSearchParams(params.toString())
      for (const [k, v] of Object.entries(next)) {
        if (v) sp.set(k, v)
        else sp.delete(k)
      }
      // Any change of filter or search restarts paging: staying on page 4 of a
      // result set that now has one page shows an empty table.
      if (!('page' in next)) sp.delete('page')
      router.push(`/contacts?${sp.toString()}`)
    },
    [params, router],
  )

  // Search as you stop typing, rather than on every keystroke.
  React.useEffect(() => {
    const current = params.get('q') ?? ''
    if (q === current) return
    const t = setTimeout(() => push({ q: q || undefined }), 350)
    return () => clearTimeout(t)
  }, [q, params, push])

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, company or number"
            className="pl-8"
            aria-label="Search contacts"
          />
        </div>
        <Select
          value={filter}
          onChange={(e) => push({ filter: e.target.value === 'all' ? undefined : e.target.value })}
          aria-label="Filter contacts"
          className="w-[180px]"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        {canManage && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            <UserPlus className="h-3.5 w-3.5" />
            Add a contact
          </Button>
        )}
      </div>

      {editing && (
        <div className="mb-3">
          <ContactForm
            contact={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <Card className="p-8">
          <EmptyState
            title={q || filter !== 'all' ? 'Nothing matches' : 'No contacts yet'}
            description={
              q || filter !== 'all'
                ? 'Try a different search, or switch the filter back to everyone.'
                : 'Import a spreadsheet or add someone by hand. Nothing can be sent until there is a list to send it to.'
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-bg-inset text-left text-[11px] uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2 font-semibold">Contact</th>
                  <th className="px-3 py-2 font-semibold">Company</th>
                  <th className="px-3 py-2 font-semibold">Can be contacted</th>
                  <th className="px-3 py-2 font-semibold">Basis</th>
                  <th className="px-3 py-2 font-semibold">Added</th>
                  {canManage && <th className="w-10 px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <Row key={c.id} contact={c} canManage={canManage} onEdit={() => setEditing(c)} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-[12px] text-ink-muted">
          <span>
            Page {page} of {pages} · {total.toLocaleString('en-GB')} contacts
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => push({ page: String(page - 1) })}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= pages}
              onClick={() => push({ page: String(page + 1) })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ row */

function Row({
  contact,
  canManage,
  onEdit,
}: {
  contact: ContactRow
  canManage: boolean
  onEdit: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [menu, setMenu] = React.useState(false)
  const router = useRouter()
  const toast = useToast()

  async function act(fn: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true)
    setMenu(false)
    try {
      const res = await fn()
      toast.push({ tone: res.ok ? 'ok' : 'danger', title: res.ok ? 'Done' : 'Not changed', body: res.message })
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const basisLabel = BASIS_BY_VALUE.get(contact.consent.basis as ConsentBasis)?.label ?? 'Not recorded'

  return (
    <tr className={cn('border-b border-line last:border-0', busy && 'opacity-50')}>
      <td className="px-3 py-2.5">
        <p className="font-medium text-ink">{contact.name ?? contact.email}</p>
        <p className="text-[12px] text-ink-muted">
          {contact.name ? contact.email : contact.jobTitle}
          {contact.phone && <span className="ml-2">{contact.phone}</span>}
        </p>
      </td>
      <td className="px-3 py-2.5 text-ink-muted">
        {contact.company ?? '—'}
        {contact.name && contact.jobTitle && (
          <span className="block text-[11px] text-ink-faint">{contact.jobTitle}</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {contact.suppressed ? (
          <Badge tone="danger">
            <Ban className="h-3 w-3" /> Unsubscribed
          </Badge>
        ) : (
          <span className="flex flex-wrap gap-1">
            {contact.consent.email && (
              <Badge tone="ok">
                <Mail className="h-3 w-3" /> Email
              </Badge>
            )}
            {contact.consent.sms &&
              (contact.phone ? (
                <Badge tone="ok">
                  <MessageSquare className="h-3 w-3" /> Text
                </Badge>
              ) : (
                <Badge tone="warn">Text — no number</Badge>
              ))}
            {!contact.consent.email && !contact.consent.sms && <Badge tone="neutral">Not yet</Badge>}
          </span>
        )}
        {contact.suppressed && contact.suppressionReason && (
          <span className="mt-0.5 block text-[11px] text-ink-faint">{contact.suppressionReason}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-ink-muted">{basisLabel}</td>
      <td className="px-3 py-2.5 text-[12px] text-ink-muted">
        <RelativeTime date={contact.createdAt} />
      </td>
      {canManage && (
        <td className="relative px-3 py-2.5">
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            disabled={busy}
            aria-label={`Actions for ${contact.email}`}
            className="rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden />
              <div className="absolute right-3 top-9 z-20 w-56 rounded-lg border border-line bg-surface-raised p-1 shadow-pop">
                <MenuItem
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  label="Edit"
                  onClick={() => {
                    setMenu(false)
                    onEdit()
                  }}
                />
                {contact.suppressed ? (
                  <MenuItem
                    icon={<Undo2 className="h-3.5 w-3.5" />}
                    label="Take off the suppression list"
                    hint="Their permission stays off until you set it."
                    onClick={() => act(() => setSuppressedAction({ id: contact.id, suppressed: false }))}
                  />
                ) : (
                  <MenuItem
                    icon={<Ban className="h-3.5 w-3.5" />}
                    label="Never contact again"
                    hint="Use this when someone asks by phone or in person."
                    onClick={() =>
                      act(() =>
                        setSuppressedAction({
                          id: contact.id,
                          suppressed: true,
                          reason: 'Asked not to be contacted',
                        }),
                      )
                    }
                  />
                )}
                <MenuItem
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  label="Erase this contact"
                  hint="Permanent. Suppressing is usually safer."
                  danger
                  onClick={() => act(() => deleteContactAction({ id: contact.id }))}
                />
              </div>
            </>
          )}
        </td>
      )}
    </tr>
  )
}

function MenuItem({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-surface-hover',
        danger ? 'text-danger-fg' : 'text-ink',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        {label}
        {hint && <span className="block text-[11px] text-ink-faint">{hint}</span>}
      </span>
    </button>
  )
}

/* ----------------------------------------------------------------- form */

function ContactForm({ contact, onClose }: { contact: ContactRow | null; onClose: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const router = useRouter()
  const toast = useToast()

  const [form, setForm] = React.useState<ContactInput>({
    email: contact?.email ?? '',
    name: contact?.name ?? '',
    phone: contact?.phone ?? '',
    company: contact?.company ?? '',
    jobTitle: contact?.jobTitle ?? '',
    country: contact?.country ?? '',
    lifecycleStage: (contact?.lifecycleStage as ContactInput['lifecycleStage']) ?? 'lead',
    basis: (contact?.consent.basis as ConsentBasis) ?? 'opt_in',
  })

  const set = (k: keyof ContactInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const res = await saveContactAction({ ...form, id: contact?.id })
      toast.push({
        tone: res.ok ? 'ok' : 'danger',
        title: res.ok ? 'Saved' : 'Not saved',
        body: res.message,
      })
      if (res.ok) {
        router.refresh()
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  const basis = BASIS_BY_VALUE.get(form.basis as ConsentBasis)

  return (
    <Card className="p-4">
      <form onSubmit={submit}>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13px] font-medium text-ink">
            {contact ? `Edit ${contact.email}` : 'Add a contact'}
          </p>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-muted hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Labelled label="Email" required>
            <Input value={form.email} onChange={set('email')} type="email" required autoFocus={!contact} />
          </Labelled>
          <Labelled label="Name">
            <Input value={form.name} onChange={set('name')} placeholder="Ann Shah" />
          </Labelled>
          <Labelled label="Company">
            <Input value={form.company} onChange={set('company')} />
          </Labelled>
          <Labelled label="Job title">
            <Input value={form.jobTitle} onChange={set('jobTitle')} />
          </Labelled>
          <Labelled label="Mobile" hint="Only needed if you will text them">
            <Input value={form.phone} onChange={set('phone')} placeholder="07700 900123" />
          </Labelled>
          <Labelled label="Stage">
            <Select value={form.lifecycleStage} onChange={set('lifecycleStage')}>
              <option value="lead">Lead</option>
              <option value="mql">Enquiry</option>
              <option value="sql">In discussion</option>
              <option value="customer">Client</option>
              <option value="churned">Former client</option>
              <option value="evangelist">Referrer</option>
            </Select>
          </Labelled>
        </div>

        <div className="mt-3">
          <Labelled label="Why may you contact them?">
            <Select value={form.basis} onChange={set('basis')}>
              {BASIS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Labelled>
          {basis && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{basis.description}</p>}
        </div>

        {contact?.suppressed && (
          <p className="mt-3 rounded-lg bg-warn-bg p-2.5 text-[11px] leading-relaxed text-warn-fg">
            This person has unsubscribed. Saving will not put them back on the list — take them off the
            suppression list first, and only if they have asked to be.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy}>
            {contact ? 'Save changes' : 'Add contact'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function Labelled({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink">
        {label}
        {required && <span className="ml-0.5 text-danger-fg">*</span>}
        {hint && <span className="ml-1.5 font-normal text-ink-faint">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
