import * as React from 'react'
import { requireAuth } from '@/lib/auth/session'
import { listNotifications } from '@/lib/notifications'
import { SettingsNavRail, SettingsNavStrip, SettingsTopbar } from '@/components/settings/shell'
import { tierFor } from '@/components/settings/plans'

/**
 * The settings shell. One header and one rail for every sub-screen, so moving
 * between brand rules and approval chains never feels like leaving the area.
 * The header title is derived from the route inside the client shell rather
 * than declared per page — see components/settings/shell.tsx.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth()
  const notifications = await listNotifications(auth.workspace.id, auth.user.id)

  return (
    <>
      <SettingsTopbar
        user={auth.user}
        role={auth.role}
        notifications={notifications}
        workspaceName={auth.workspace.name}
        planLabel={tierFor(auth.workspace.plan).name}
      />
      <SettingsNavStrip role={auth.role} />
      <div className="flex min-w-0 flex-1 items-start">
        <SettingsNavRail role={auth.role} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </>
  )
}
