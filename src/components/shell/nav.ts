import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  Bot,
  CalendarDays,
  Clapperboard,
  Megaphone,
  LayoutDashboard,
  PenLine,
  Radar,
  ScanSearch,
  Settings,
  ShieldCheck,
  Target,
  Users,
  Wallet,
  Waypoints,
} from 'lucide-react'
import type { Role } from '@/lib/db/schema'
import { can, type Permission } from '@/lib/auth/rbac'

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Hidden entirely when the role lacks this permission. */
  requires?: Permission
  description: string
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Work',
    items: [
      {
        href: '/command-center',
        label: 'Command Center',
        icon: LayoutDashboard,
        description: 'Everything in flight and what needs you',
      },
      {
        href: '/agent',
        label: 'Growth agent',
        icon: Bot,
        description: 'Ask about the business; it finds leads, follows up and drafts content for review',
      },
      {
        href: '/studio',
        label: 'Content Studio',
        icon: PenLine,
        description: 'Briefs to on-brand, scored assets',
      },
      {
        href: '/studio/video',
        label: 'Video Studio',
        icon: Clapperboard,
        description: 'Short clips, costed before they are made and reviewed before they run',
      },
      {
        href: '/planner',
        label: 'Campaign Planner',
        icon: Waypoints,
        description: 'Objectives to sequenced plans',
      },
      {
        href: '/contacts',
        label: 'Contacts',
        icon: Users,
        description: 'The list itself: names, addresses and what you may send',
      },
      {
        href: '/targeting',
        label: 'Audience Targeting',
        icon: Target,
        description: 'Plain-language audiences with real rules',
      },
      {
        href: '/ads',
        label: 'Google Ads',
        icon: Megaphone,
        description: 'Build, review and launch paid search campaigns',
      },
      {
        href: '/search',
        label: 'PPC & SEO',
        icon: ScanSearch,
        description: 'Paid and organic search read as one system, search by search',
      },
      {
        href: '/competitors',
        label: 'Competitors',
        icon: Radar,
        description: 'Who you compete with, what they promise, and where they leave room',
      },
    ],
  },
  {
    section: 'Ship',
    items: [
      {
        href: '/approvals',
        label: 'Approvals',
        icon: ShieldCheck,
        description: 'The governance gate and its audit trail',
      },
      {
        href: '/scheduler',
        label: 'Scheduler',
        icon: CalendarDays,
        description: 'One calendar for every channel',
      },
      {
        href: '/budget',
        label: 'Budget Allocator',
        icon: Wallet,
        description: 'Every pound planned, allocated on evidence, and matched to the card',
      },
      {
        href: '/performance',
        label: 'Performance',
        icon: BarChart3,
        description: 'Results tied to spend and decisions',
      },
    ],
  },
  {
    section: 'Workspace',
    items: [
      {
        href: '/settings',
        label: 'Settings',
        icon: Settings,
        description: 'Brand rules, chains, people, connectors',
      },
    ],
  },
]

export function navForRole(role: Role) {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((i) => !i.requires || can(role, i.requires)),
  })).filter((g) => g.items.length > 0)
}
