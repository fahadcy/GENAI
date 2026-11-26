import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { listWorkspaces, requireAuth } from '@/lib/auth/session'
import { Sidebar } from '@/components/shell/sidebar'

export const dynamic = 'force-dynamic'

type Counts = { approvals: number; recommendations: number; deadLetter: number }

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth()
  const wsId = auth.workspace.id

  const [counts, spaces] = await Promise.all([badgeCounts(wsId), listWorkspaces(auth.user.id)])

  return (
    /*
     * Column on small screens, row from `lg`. The Sidebar renders two things:
     * a full-width bar for phones and a fixed-width rail for desktop. In a row
     * layout the phone bar would become a *column* beside the content and
     * squeeze it to a few hundred pixels, so the axis has to flip with the
     * breakpoint that swaps which of the two is visible.
     */
    <div className="flex min-h-screen flex-col bg-bg lg:flex-row">
      <Sidebar
        role={auth.role}
        workspace={{
          id: auth.workspace.id,
          name: auth.workspace.name,
          plan: auth.workspace.plan,
          trialEndsAt: auth.workspace.trialEndsAt?.toISOString() ?? null,
        }}
        workspaces={spaces}
        counts={counts}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/** One round trip for the three sidebar badges. */
async function badgeCounts(workspaceId: string): Promise<Counts> {
  const result = await db.execute<{ approvals: number; recommendations: number; dead_letter: number }>(sql`
    select
      (select count(*) from approval_requests where workspace_id = ${workspaceId} and status = 'pending')::int as approvals,
      (select count(*) from recommendations   where workspace_id = ${workspaceId} and status = 'open')::int    as recommendations,
      (select count(*) from schedule_items    where workspace_id = ${workspaceId} and status = 'dead_letter')::int as dead_letter
  `)
  const row = (result as unknown as { approvals: number; recommendations: number; dead_letter: number }[])[0]
  return {
    approvals: Number(row?.approvals ?? 0),
    recommendations: Number(row?.recommendations ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
  }
}
