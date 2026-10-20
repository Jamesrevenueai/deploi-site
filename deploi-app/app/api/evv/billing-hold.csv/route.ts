import { NextResponse } from 'next/server'
import { getSession, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { billingHold } from '@/lib/evv/queries'

const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

/** "Do not bill yet" list as CSV. Staff pass ?agency=<id>; clients always get their own agency. */
export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const agencyId = session.role === 'staff' ? url.searchParams.get('agency') : session.agencyId
  if (!agencyId) return NextResponse.json({ ok: false, error: 'agency required' }, { status: 400 })
  const ip = await requestIp()
  const rows = await withUser(session, db => billingHold(db, agencyId), { ip })
  const lines = ['vendor_visit_key,visit_date,service,units,aide,client,open_rules,window_closes']
  for (const r of rows) {
    lines.push([r.vendor_visit_key ?? r.visit_id, r.scheduled_start ? r.scheduled_start.slice(0, 10) : '', r.service_code, r.units ?? '', r.aide_initials ?? '', r.client_initials ?? '', r.open_rules.join('; '), r.window_closes_at ? r.window_closes_at.slice(0, 10) : ''].map(esc).join(','))
  }
  return new NextResponse(lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="billing-hold-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' },
  })
}
