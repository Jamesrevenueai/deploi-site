import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { sendWeeklySummaries } from '@/lib/agents/weekly'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Monday: one summary per merchant organization per week (a repeated call is a no-op for that week). */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const cronOk = env.cronSecret ? auth === `Bearer ${env.cronSecret}` : !env.isProd
  if (!cronOk) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const results = await sendWeeklySummaries()
  return NextResponse.json({ ok: true, results })
}
