import * as React from 'react'
import Link from 'next/link'
import type { AgentStoredEvidence } from '@/lib/db/schema'

/**
 * The agent's report, with every citation shown as a small link to the
 * evidence behind it. The report is plain text with **bold** and "- " lists;
 * nothing in it is treated as HTML.
 */
export function Report({ text, evidence, runHref }: { text: string; evidence: AgentStoredEvidence[]; runHref?: string }) {
  const byId = new Map(evidence.map((e) => [e.id, e]))
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let list: React.ReactNode[] = []
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`} className="my-2 space-y-1.5 pl-5 [list-style:disc]">{list}</ul>)
    list = []
  }
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t) { flush(); return }
    if (/^[-•*]\s+/.test(t)) { list.push(<li key={i} className="text-sm leading-relaxed text-ink">{inline(t.replace(/^[-•*]\s+/, ''), byId, runHref)}</li>); return }
    flush()
    blocks.push(<p key={i} className="my-2 text-sm leading-relaxed text-ink">{inline(t, byId, runHref)}</p>)
  })
  flush()
  return <div>{blocks}</div>
}

function inline(s: string, byId: Map<string, AgentStoredEvidence>, runHref?: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|\[(E\d+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    if (m[1]) out.push(<strong key={k++} className="font-semibold">{m[1]}</strong>)
    else {
      const e = byId.get(m[2]!)
      const href = `${runHref ?? ''}#${m[2]}`
      out.push(
        <Link key={k++} href={href} title={e?.label ?? 'Evidence'} className="mx-0.5 inline-flex items-center rounded bg-brand-50 px-1 align-baseline text-2xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100">
          {m[2]}
        </Link>,
      )
    }
    last = re.lastIndex
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

export const SOURCE_LABEL: Record<string, string> = {
  companies_house: 'Companies House', gazette: 'The Gazette', crm: 'CRM', website: 'Website', competitors: 'Competitors',
  search_console: 'Search Console', ads: 'Google Ads', budget: 'Budget', brain: 'Business profile', computed: 'Calculated',
}
