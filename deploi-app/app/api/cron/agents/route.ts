import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import '@/lib/connectors'
import { runDueAgents } from '@/lib/agents/run'
import { processQueue, reconcileOpen } from '@/lib/email/engine'
import { runQueuedTasks } from '@/lib/agents/tasks'
import { cronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Runs agents whose schedule is due. Each agent is claimed under a row lock, so overlapping calls never run one agent twice. */
export async function GET(req: Request) {
  const cronOk = cronAuthorized(req)
  if (!cronOk) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const results = await runDueAgents()
  // plain-language tasks left queued (for example while their agent was paused)
  const tasks = await runQueuedTasks()
  // email: rate-limited messages whose wait is over, then interrupted or unknown sends (never resent blindly)
  const emailRetries = await processQueue({ actor: 'system:scheduler' })
  const emailReconciled = await reconcileOpen({ actor: 'system:scheduler' })
  return NextResponse.json({ ok: true, ran: results.length, results, tasks, email: { sent: emailRetries.length, reconciled: emailReconciled.length } })
}
