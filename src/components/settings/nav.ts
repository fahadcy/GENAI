import type { LucideIcon } from 'lucide-react'
import {
  CreditCard,
  Palette,
  Plug,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
} from 'lucide-react'
import type { Role } from '@/lib/db/schema'
import { can, type Permission } from '@/lib/auth/rbac'

export type SettingsNavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Shown under the label in the sidebar — settings screens need explaining. */
  blurb: string
  /** Page title used by the settings topbar. */
  title: string
  description: string
  /** Hidden when the role lacks this permission. */
  requires?: Permission
}

export const SETTINGS_NAV: { section: string; items: SettingsNavItem[] }[] = [
  {
    section: 'Workspace',
    items: [
      {
        href: '/settings',
        label: 'General',
        icon: SlidersHorizontal,
        blurb: 'Name, timezone, residency',
        title: 'Workspace settings',
        description: 'How this workspace is identified, where its data lives and what it defaults to.',
      },
      {
        href: '/settings/brand',
        label: 'Brand & legal',
        icon: Palette,
        blurb: 'Voice, rules, disclaimers',
        title: 'Brand voice and legal rules',
        description:
          'The rules every generated asset is scored against before a human ever sees it.',
      },
      {
        href: '/settings/approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        blurb: 'Chains, blackouts, caps',
        title: 'Approval chains and send guards',
        description: 'Who signs off what, in what order, and when nothing may go out at all.',
        requires: 'approval:configure',
      },
    ],
  },
  {
    section: 'Access',
    items: [
      {
        href: '/settings/members',
        label: 'People',
        icon: Users,
        blurb: 'Roles and invitations',
        title: 'People and roles',
        description: 'Who has access, what each role may do, and who is still waiting to accept.',
        requires: 'member:manage',
      },
      {
        href: '/settings/connectors',
        label: 'Integrations',
        icon: Plug,
        blurb: 'CRM, ESP, social, ads',
        title: 'Integrations',
        description: 'Every channel Aurea publishes to, and every system it reads from.',
        requires: 'connector:manage',
      },
    ],
  },
  {
    section: 'Records',
    items: [
      {
        href: '/settings/audit',
        label: 'Audit trail',
        icon: ScrollText,
        blurb: 'Tamper-evident history',
        title: 'Audit trail',
        description:
          'Every state change in this workspace, hash-chained so a modified record can be proven.',
      },
      {
        href: '/settings/billing',
        label: 'Plan & usage',
        icon: CreditCard,
        blurb: 'Seats, limits, AI spend',
        title: 'Plan and usage',
        description: 'What this workspace is on, what it is using, and what the AI actually costs.',
        requires: 'billing:manage',
      },
      {
        href: '/settings/profile',
        label: 'Your profile',
        icon: UserRound,
        blurb: 'Name, password, sessions',
        title: 'Your profile',
        description: 'Your details, your password and the devices signed in as you.',
      },
    ],
  },
]

export function settingsNavForRole(role: Role) {
  return SETTINGS_NAV.map((group) => ({
    ...group,
    items: group.items.filter((i) => !i.requires || can(role, i.requires)),
  })).filter((g) => g.items.length > 0)
}

/** Longest matching href wins, so /settings never claims /settings/brand. */
export function activeSettingsItem(pathname: string): SettingsNavItem | null {
  const all = SETTINGS_NAV.flatMap((g) => g.items)
  return (
    all
      .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0] ?? null
  )
}
