'use client'

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Tabs } from '@/components/ui/client'

/**
 * Tabs whose panels are rendered on the server and passed in. The choice is
 * kept in the URL (?tab=) so a notification can link straight to the
 * reconciliation and a reload keeps the place.
 */
export function BudgetTabs({
  initial,
  tabs,
}: {
  initial: string
  tabs: { value: string; label: string; count?: number; panel: React.ReactNode }[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [value, setValue] = React.useState(tabs.some((t) => t.value === initial) ? initial : tabs[0].value)
  const change = (v: string) => {
    setValue(v)
    router.replace(`${pathname}?tab=${v}`, { scroll: false })
  }
  const active = tabs.find((t) => t.value === value) ?? tabs[0]
  return (
    <div className="space-y-4">
      <Tabs tabs={tabs.map(({ value, label, count }) => ({ value, label, count }))} value={value} onChange={change} className="border-b border-line pb-2" />
      <div role="tabpanel">{active.panel}</div>
    </div>
  )
}
