import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { errorResponse, HttpError } from '@/lib/store/request'
import { requireStaffApi } from '@/lib/platform/staff'
import { currentMonth, economicsReport } from '@/lib/platform/economics'

export const dynamic = 'force-dynamic'

/** Staff only: unit economics per organization for ?month=YYYY-MM (default: this month). */
export async function GET(req: Request) {
  try {
    await requireStaffApi(req)
    const month = new URL(req.url).searchParams.get('month') ?? currentMonth()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'invalid_input', 'month must be YYYY-MM')
    return NextResponse.json({ ok: true, ...(await admin(db => economicsReport(db, month))) }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}
