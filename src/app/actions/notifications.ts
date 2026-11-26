'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { notifications } from '@/lib/db/schema'
import { requireAuth } from '@/lib/auth/session'

export async function markNotificationsRead() {
  const auth = await requireAuth()
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.workspaceId, auth.workspace.id),
        eq(notifications.userId, auth.user.id),
        isNull(notifications.readAt),
      ),
    )
  revalidatePath('/', 'layout')
}
