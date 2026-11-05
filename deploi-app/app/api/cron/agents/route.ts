import { NextResponse } from 'next/server'
import '@/lib/connectors'
import { runQueuedTasks } from '@/lib/agents/tasks'
import { enqueueDueWork, recordHeartbeat, runDueJobs } from '@/lib/jobs'
import { cronAuthorized } from '@/lib/cron-auth'
import { enforceLapsedPlans } from '@/lib/plans/enforce'
import { billingHourly } from '@/lib/billing/jobs'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Hourly: due agent runs and queued email go onto the durable job queue (each queued once, whatever
 * overlaps), then the queue is worked until shortly before the time limit. A run or send cut off by a
 * timeout is picked up again by the next worker (/api/cron/jobs) when its lease expires; runAgent and
 * sendMessage each claim under a row lock, so nothing runs or sends twice.
 */
export async function GET(req: Request) {
  const cronOk = cronAuthorized(req)
  if (!cronOk) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  // subscriptions past due beyond their grace period lapse by time alone: apply the lower limits first (billing on only)
  const plans = await enforceLapsedPlans()
  // trial-ending reminders and any billing notice left unsent (billing on only)
  const billing = await billingHourly()
  const queued = await enqueueDueWork()
  // plain-language tasks left queued (for example while their agent was paused)
  const tasks = await runQueuedTasks()
  const r = await runDueJobs({ deadlineMs: 200_000, limit: 200 })
  await recordHeartbeat('cron.agents', r.paused ? 'paused' : 'ok', { ran: r.ran.length })
  return NextResponse.json({ ok: true, paused: r.paused, queued: { agentRuns: queued.agentRuns.filter(q => q.created).length, sends: queued.sends.filter(q => q.created).length }, ran: r.ran.length, results: r.ran, tasks, plansEnforced: plans.length, billing })
}
