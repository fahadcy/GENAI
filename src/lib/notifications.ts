import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { notifications } from '@/lib/db/schema'
import type { TopbarNotification } from '@/components/shell/topbar'

export async function listNotifications(
  workspaceId: string,
  userId: string,
  limit = 12,
): Promise<TopbarNotification[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  return rows.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    href: n.href,
    createdAt: n.createdAt.toISOString(),
    read: n.readAt !== null,
  }))
}
