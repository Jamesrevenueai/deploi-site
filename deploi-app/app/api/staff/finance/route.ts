import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { errorResponse, HttpError } from '@/lib/store/request'
import { requireStaffApi } from '@/lib/platform/staff'
import { currentMonth } from '@/lib/platform/economics'
import { financeCsv, financeReport } from '@/lib/billing/finance'

export const dynamic = 'force-dynamic'

/** Staff only: the finance report for ?month=YYYY-MM (default: this month); ?format=csv downloads the per-organization rows. */
export async function GET(req: Request) {
  try {
    await requireStaffApi(req)
    const q = new URL(req.url).searchParams
    const month = q.get('month') ?? currentMonth()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'invalid_input', 'month must be YYYY-MM')
    const r = await admin(db => financeReport(db, month))
    if (q.get('format') === 'csv') return new NextResponse(financeCsv(r), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="deploi-finance-${month}.csv"`, 'cache-control': 'no-store' } })
    return NextResponse.json({ ok: true, ...r }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}
