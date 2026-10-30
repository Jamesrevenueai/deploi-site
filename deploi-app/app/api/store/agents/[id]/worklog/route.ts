import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { agentWorkLog } from '@/lib/agents/worklog'
import { listTasks } from '@/lib/agents/tasks'
import { emailConfig } from '@/lib/email/config'

export const dynamic = 'force-dynamic'

/**
 * The agent's work log (what, when, why, which permission), its plain-language tasks, its own mailbox
 * and the latest mail received there (sender, classification and status only; never the content).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    const [log, tasks] = await Promise.all([agentWorkLog(actor, id), listTasks(actor, id)])
    const mail = await withActor(actor, async db => ({
      mailbox: await db.one<{ id: string; address: string; status: string }>(`select id, address, status from email_accounts where agent_id = $1 and provider = 'deploi' and status <> 'disconnected'`, [id]),
      inbound: await db.query<{ id: string; from_address: string; classification: string; status: string; status_reason: string | null; received_at: string; thread_message_id: string | null }>(
        'select id, from_address, classification, status, status_reason, received_at, thread_message_id from email_inbound where agent_id = $1 order by received_at desc limit 20', [id]),
    }))
    return NextResponse.json({ ok: true, log, tasks, ...mail, mailDomain: emailConfig.agentMailDomain || null })
  } catch (e) { return errorResponse(e) }
}
