/**
 * Human labels for every audited action.
 *
 * Deliberately a plain module with no `server-only` import and no database
 * access, so client components (the audit viewer, the activity feed) can render
 * a label without a round trip. The audit *writer* lives in ./audit.ts.
 *
 * Every action string passed to `recordAudit` should have an entry here. A
 * missing entry is not fatal — callers fall back to the raw key — but it shows
 * up in the UI as a machine string, which is a bug worth fixing.
 */
export const AUDIT_LABELS: Record<string, string> = {
  /* content */
  'asset.generated': 'Asset generated',
  'asset.edited': 'Asset edited',
  'asset.regenerated': 'Asset regenerated',
  'asset.submitted': 'Submitted for review',
  'asset.scored': 'Guardrails evaluated',

  /* video */
  'video.requested': 'Video requested',
  'video.regenerated': 'Video regenerated',
  'video.refused': 'Video refused before generating',
  'video.submitted': 'Sent to the video provider',
  'video.generated': 'Video generated',
  'video.retrying': 'Video generation retrying',
  'video.failed': 'Video generation failed',
  'video.replayed': 'Video generation replayed',
  'video.budget_changed': 'Video budget changed',

  /* PPC + SEO */
  'search.analysed': 'Search analysis run',
  'search.applied': 'Search change applied',
  'search.reverted': 'Search change reverted',
  'search.profile_updated': 'Business setup changed',
  'search.lead_updated': 'Enquiry outcome recorded',

  /* budget */
  'budget.plan_created': 'Budget plan created',
  'budget.plan_edited': 'Budget plan edited',
  'budget.line_saved': 'Budget line saved',
  'budget.line_removed': 'Budget line removed',
  'budget.plan_revised': 'Budget revision drafted',
  'budget.plan_activated': 'Budget plan made live',
  'budget.plan_closed': 'Budget plan closed',
  'budget.allocated': 'Budget allocator run',
  'budget.allocation_applied': 'Allocator recommendation applied',
  'budget.history_imported': 'Channel history imported',
  'budget.card_connected': 'Card connected',
  'budget.card_updated': 'Card settings changed',
  'budget.card_limit_set': 'Card limit set',
  'budget.card_removed': 'Card disconnected',
  'budget.statement_imported': 'Card statement imported',
  'budget.transaction_assigned': 'Card transaction assigned',
  'budget.reconciled': 'Budget reconciled',
  'budget.discrepancy_updated': 'Discrepancy updated',
  'budget.simulation_loaded': 'Simulated budget data loaded',
  'ads.budget_from_plan': 'Campaign budget set from plan',
  /* competitors */
  'competitors.profile_updated': 'Competitor profile changed',
  'competitors.discovered': 'Competitor discovery run',
  'competitors.tracked': 'Competitor tracked',
  'competitors.untracked': 'Competitor no longer tracked',
  'competitors.dismissed': 'Competitor dismissed',
  'competitors.added': 'Competitor added',
  'competitors.scanned': 'Competitor scanned',
  'competitors.landscape_built': 'Competitive analysis built',

  /* approvals */
  'approval.invalidated': 'Approval invalidated',
  'approval.requested': 'Approval requested',
  'approval.approved': 'Approved',
  'approval.rejected': 'Changes requested',
  'approval.delegated': 'Approval delegated',
  'approval.step_advanced': 'Advanced to next step',

  /* scheduling and delivery */
  'schedule.created': 'Scheduled',
  'schedule.moved': 'Rescheduled',
  'schedule.blocked': 'Scheduling blocked',
  'publish.succeeded': 'Published',
  'publish.failed': 'Publish failed',
  'publish.dead_letter': 'Moved to dead letter',

  /* audiences */
  'segment.created': 'Segment created',
  'segment.refreshed': 'Segment refreshed',
  'segment.synced': 'Segment synced to channel',

  /* campaigns */
  'campaign.created': 'Campaign created',
  'campaign.planned': 'Plan generated',
  'campaign.rescheduled': 'Plan recalculated',
  'campaign.deleted': 'Campaign deleted',

  /* copilot */
  'recommendation.applied': 'Copilot action applied',
  'recommendation.reverted': 'Copilot action reverted',
  'recommendation.dismissed': 'Recommendation dismissed',

  /* governance configuration */
  'brand.updated': 'Brand rules updated',
  'legal.rule_created': 'Legal rule added',
  'legal.rule_updated': 'Legal rule updated',
  'legal.rule_removed': 'Legal rule removed',
  'chain.created': 'Approval chain created',
  'chain.updated': 'Approval chain updated',
  'chain.retired': 'Approval chain retired',
  'chain.removed': 'Approval chain deleted',
  'blackout.saved': 'Blackout window saved',
  'blackout.removed': 'Blackout window removed',
  'frequency_cap.saved': 'Frequency cap saved',
  'frequency_cap.removed': 'Frequency cap removed',

  /* workspace administration */
  'workspace.updated': 'Workspace settings changed',
  'member.invited': 'Member invited',
  'member.invite_revoked': 'Invitation revoked',
  'member.role_changed': 'Role changed',
  'member.removed': 'Member removed',
  'connector.connected': 'Connector connected',
  'connector.disconnected': 'Connector disconnected',
  'connector.resynced': 'Connector resynced',
  'connector.tested': 'Test message sent',

  /* contact list */
  'contact.created': 'Contact added',
  'contact.updated': 'Contact updated',
  'contact.imported': 'Contacts imported',
  'contact.suppressed': 'Contact suppressed',
  'contact.unsuppressed': 'Suppression lifted',
  'contact.deleted': 'Contact erased',
  'contact.exported': 'Contact list exported',
  'billing.plan_changed': 'Plan changed',
  'user.password_changed': 'Password changed',
}

export function auditLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action
}
