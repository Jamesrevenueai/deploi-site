import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import '@/lib/connectors'
import { runDueAgents } from '@/lib/agents/run'
import { processQueue, reconcileOpen } from '@/lib/email/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Runs agents whose schedule is due. Each agent is claimed under a row lock, so overlapping calls never run one agent twice. */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const cronOk = env.cronSecret ? auth === `Bearer ${env.cronSecret}` : !env.isProd
  if (!cronOk) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const results = await runDueAgents()
  // email: rate-limited messages whose wait is over, then interrupted or unknown sends (never resent blindly)
  const emailRetries = await processQueue({ actor: 'system:scheduler' })
  const emailReconciled = await reconcileOpen({ actor: 'system:scheduler' })
  return NextResponse.json({ ok: true, ran: results.length, results, email: { sent: emailRetries.length, reconciled: emailReconciled.length } })
}
