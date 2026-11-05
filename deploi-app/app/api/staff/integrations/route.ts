import { NextResponse } from 'next/server'
import { errorResponse } from '@/lib/store/request'
import { requireStaffApi } from '@/lib/platform/staff'
import { staffOverview } from '@/lib/integrations/diagnostics'
import type { HealthStatus } from '@/lib/integrations/types'

export const dynamic = 'force-dynamic'

const STATUSES: HealthStatus[] = ['connected', 'needs_reauth', 'error', 'not_connected', 'not_configured']

/** Staff: every organization's connections and their health, recent transitions, and the settings this deployment is missing. */
export async function GET(req: Request) {
  try {
    await requireStaffApi(req)
    const s = new URL(req.url).searchParams.get('status')
    return NextResponse.json({ ok: true, ...(await staffOverview({ status: STATUSES.includes(s as HealthStatus) ? s as HealthStatus : null })) })
  } catch (e) { return errorResponse(e) }
}
