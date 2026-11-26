import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/session'
import { can } from '@/lib/auth/rbac'
import { latestRun, offlineConversionsCsv } from '@/lib/search/service'

/**
 * The verified outcomes from the latest PPC & SEO analysis, as a Google Ads
 * "Upload clicks" file. Spam, wrong-service, out-of-area, unreachable and open
 * enquiries are not in it — only what is known to be a real prospect or a
 * customer, keyed by click id.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireAuth()
  if (!can(auth.role, 'search:analyse')) {
    return NextResponse.json({ error: 'Your role cannot export conversion data.' }, { status: 403 })
  }
  const run = await latestRun(auth.workspace.id)
  if (!run?.report.leads) {
    return NextResponse.json({ error: 'Run an analysis with enquiries first.' }, { status: 404 })
  }
  const csv = offlineConversionsCsv(run.report)
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="offline-conversions-${run.windowEnd ?? 'latest'}${run.source === 'simulated' ? '-SIMULATED' : ''}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
