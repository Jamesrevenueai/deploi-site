import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { runOfficeScheduler } from '@/lib/office/scheduler'
import '@/lib/office/actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Deploi Office scheduler: reconcile uncertain outcomes, then per organization (under its lease) run due agents and carry out due actions. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, ...(await runOfficeScheduler()) })
}
