import type { Role } from '@/lib/db/schema'

/**
 * Permission model. Roles map to the five PRD personas plus a read-only analyst.
 * Checks are deny-by-default: absence from the set means no.
 */
export const PERMISSIONS = [
  'workspace:read',
  'asset:create',
  'asset:edit',
  'asset:submit',
  'asset:delete',
  'approval:decide',
  'approval:configure',
  'campaign:create',
  'campaign:edit',
  'segment:create',
  'segment:edit',
  /* Contact data is personal data. Creating and editing it is ordinary
     marketing work, but exporting the list is the action that takes personal
     data out of the platform's control, so it sits with audit export. */
  'contact:manage',
  'contact:export',
  'schedule:create',
  'schedule:edit',
  'schedule:publish',
  'brand:manage',
  'connector:manage',
  'member:manage',
  'billing:manage',
  'recommendation:apply',
  'audit:export',
  /* Paid advertising. Split three ways because the consequences differ: building
     a campaign costs nothing, creating it in Google costs nothing while it is
     paused, and turning it on starts spending real money. Only the last one is
     restricted to owners and marketing ops. */
  'ads:create',
  'ads:push',
  'ads:golive',
  /* Generated video. Split the same way as paid, and for the same reason:
     writing a brief costs nothing, generating spends real money per attempt,
     and raising the monthly ceiling spends more of it. */
  'video:create',
  'video:budget',
  /* PPC + SEO (SERP Twin). Running an analysis reads data and writes a report,
     so growth marketers can do it. Applying an approved change touches live
     ads and live pages, so it sits with owners and marketing ops, like going
     live with a campaign. */
  'search:analyse',
  'search:apply',
  /* Competitor intelligence. Reading the landscape is open to everyone in the
     workspace. Running discovery and scans spends API credit and changes what
     the generators are told, so it sits with the people who plan campaigns. */
  'competitor:analyse',
  /* Budget Allocator. Planning and running the allocator cost nothing and
     commit nothing, so growth marketers can do it. Making a plan live,
     pushing its figures into campaigns and the video ceiling, and connecting
     or capping a company card are spend and finance decisions, so they sit
     with owners and marketing ops — like going live with a campaign. */
  'budget:plan',
  'budget:activate',
  'budget:cards',
  /* Growth agent. Asking it questions and running the brief or lead finding
     reads data and drafts things for people (leads in the CRM's New column,
     tasks, draft pull requests), so growth marketers can do it. Sending
     email and connecting the CRM or website act on the outside world, so
     they sit with owners and marketing ops. */
  'agent:run',
  'agent:outreach',
  'agent:configure',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ALL = new Set<Permission>(PERMISSIONS)

const MATRIX: Record<Role, Set<Permission>> = {
  owner: ALL,
  admin: new Set<Permission>([
    'workspace:read',
    'asset:create',
    'asset:edit',
    'asset:submit',
    'asset:delete',
    'approval:configure',
    'campaign:create',
    'campaign:edit',
    'segment:create',
    'segment:edit',
    'contact:manage',
    'contact:export',
    'schedule:create',
    'schedule:edit',
    'schedule:publish',
    'brand:manage',
    'connector:manage',
    'member:manage',
    'billing:manage',
    'audit:export',
    'ads:create',
    'ads:push',
    'ads:golive',
    'video:create',
    'video:budget',
    'search:analyse',
    'search:apply',
    'competitor:analyse',
    'budget:plan',
    'budget:activate',
    'budget:cards',
    'agent:run',
    'agent:outreach',
    'agent:configure',
  ]),
  creator: new Set<Permission>([
    'workspace:read',
    'asset:create',
    'asset:edit',
    'asset:submit',
    'schedule:create',
    'video:create',
  ]),
  strategist: new Set<Permission>([
    'workspace:read',
    'asset:create',
    'asset:edit',
    'asset:submit',
    'campaign:create',
    'campaign:edit',
    'segment:create',
    'segment:edit',
    'contact:manage',
    'schedule:create',
    'schedule:edit',
    'recommendation:apply',
    'ads:create',
    'ads:push',
    'video:create',
    'search:analyse',
    'competitor:analyse',
    'budget:plan',
    'agent:run',
  ]),
  approver: new Set<Permission>(['workspace:read', 'approval:decide', 'audit:export', 'asset:edit']),
  analyst: new Set<Permission>(['workspace:read', 'audit:export']),
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(`Role "${role}" is not permitted to ${permission}.`)
  }
}

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Marketing ops',
  creator: 'Content creator',
  strategist: 'Growth marketer',
  approver: 'Reviewer / legal',
  analyst: 'Analyst',
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Full control including billing and workspace deletion.',
  admin: 'Governance, integrations, brand rules and access control.',
  creator: 'Produces and edits assets; submits work for review.',
  strategist: 'Plans campaigns, builds audiences, applies copilot actions.',
  approver: 'Reviews and signs off work. Cannot publish directly.',
  analyst: 'Read-only access with reporting exports.',
}

/** Where each role should land after sign-in (PRD CC-4, role-aware view). */
export const ROLE_HOME: Record<Role, string> = {
  owner: '/command-center',
  admin: '/command-center',
  creator: '/studio',
  strategist: '/planner',
  approver: '/approvals',
  analyst: '/performance',
}
