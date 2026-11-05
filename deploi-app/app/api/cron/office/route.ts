import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { runOfficeScheduler } from '@/lib/office/scheduler'
import '@/lib/office/actions'
import { flushWorkflowCounters } from '@/lib/ai/meter'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Deploi Office scheduler: reconcile uncertain outcomes, then per organization (under its lease) run due agents and carry out due actions. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const r = await runOfficeScheduler()
  // HubSpot, Calendar, QuickBooks and mailbox calls counted during the run (lib/ai/meter.ts)
  await flushWorkflowCounters()
  return NextResponse.json({ ok: true, ...r })
}
