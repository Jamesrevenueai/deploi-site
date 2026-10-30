import { NextResponse } from 'next/server'
import { runDueLibraryAgents } from '@/lib/library/actions'
import { cronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Hourly: run every switched-on library agent that has not run in the last 24 hours (each at most once per call). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, results: await runDueLibraryAgents() })
}
