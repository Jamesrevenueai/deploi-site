import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { listAgents } from '@/lib/agents/queries'
import { createAgent } from '@/lib/agents/lifecycle'
import { parseTask } from '@/lib/agents/parse'
import { TEMPLATES, templateByKey, templatePolicy } from '@/lib/agents/templates'
import { withActor } from '@/lib/engine/actor'

export const dynamic = 'force-dynamic'

/** The organization's agents. ?connection=<id> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, agents: await listAgents(actor, new URL(req.url).searchParams.get('connection')), templates: TEMPLATES })
  } catch (e) { return errorResponse(e) }
}

/**
 * Body { op: 'parse', text } turns plain English into a draft for review (grants nothing).
 * Body { name, taskText, policy } creates the agent as a draft whose first authorization waits for a grant.
 * Body { template, connectionId, name?, notify?, supplierAddress?, competitor? } creates an agent from a template, at drafts
 * only for every tool, with its own mailbox when it has email tasks; its authorization still waits for a grant.
 * competitor: { stores: string[], keywords?: string[], alerts?: string[], cadence?: 'daily' | 'weekly', emailSummary?: boolean }
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.op === 'parse') {
      const text = String(body.text ?? '').slice(0, 2000)
      if (!text.trim()) throw new HttpError(400, 'invalid_input', 'describe the task in a sentence or two')
      return NextResponse.json({ ok: true, draft: parseTask(text) })
    }
    if (typeof body.template === 'string') {
      const t = templateByKey(body.template)
      if (!t) throw new HttpError(400, 'invalid_input', 'unknown template')
      const connectionId = String(body.connectionId ?? '')
      // read under the actor's RLS: another organization's store is simply not found here (and createAgent refuses it)
      const tz = await withActor(actor, db => db.one<{ timezone: string | null }>('select timezone from store_connections where id = $1', [connectionId]))
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 40) : [])
      const c = body.competitor && typeof body.competitor === 'object' ? body.competitor as Record<string, unknown> : {}
      const policy = templatePolicy(t.key, { connectionId, timezone: tz?.timezone || 'UTC', notify: typeof body.notify === 'string' ? body.notify : null, supplierAddress: typeof body.supplierAddress === 'string' ? body.supplierAddress : null,
        competitor: { stores: strings(c.stores), keywords: strings(c.keywords), alerts: strings(c.alerts), cadence: c.cadence === 'weekly' ? 'weekly' : 'daily',
          minPriceChangePct: typeof c.minPriceChangePct === 'number' ? c.minPriceChangePct : undefined, emailSummary: c.emailSummary === true } })
      const name = typeof body.name === 'string' && body.name.trim() ? body.name : t.name
      // an agent gets its own address only when it has email tasks (the competitor watcher's summary is optional)
      return NextResponse.json({ ok: true, ...(await createAgent(actor, { name, taskText: t.job, policy, mailbox: t.mailbox && Boolean(policy.email), templateKey: t.key })) })
    }
    const r = await createAgent(actor, { name: String(body.name ?? ''), taskText: String(body.taskText ?? ''), policy: body.policy, mailbox: body.mailbox === true })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
