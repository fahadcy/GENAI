/**
 * Kept as a re-export so Settings screens keep a stable import path. The single
 * source of truth is `@/lib/workflow/audit-labels`, a plain module (no
 * `server-only`) that both server and client components can import.
 */
export { auditLabel, AUDIT_LABELS } from '@/lib/workflow/audit-labels'
