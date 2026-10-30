import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { teamView, type TeamAgent } from '@/lib/library/switches'
import { activityLog, listActions } from '@/lib/library/actions'
import { chatHistory } from '@/lib/library/chat'
import { agentByKey } from '@/lib/library/config'

export const dynamic = 'force-dynamic'

/** One agent's dashboard: its team card, approval queue, activity log and chat history. custom-<id> is one of the merchant's own agents (queue and log only). */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { key } = await ctx.params
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'the team belongs to a merchant organization')
    const team = await teamView(actor)
    let agent: TeamAgent | undefined
    let logKey = key
    if (key.startsWith('custom-')) {
      const c = team.buildYourOwn.agents.find(x => x.id === key.slice(7))
      if (!c) throw new HttpError(404, 'not_found', 'unknown agent')
      logKey = `custom:${c.id}`
      agent = { key, name: c.name, status: 'new', character: { emoji: '🛠️', hue: 60, shape: 'square' }, tagline: 'Your own agent', description: c.job, exampleTask: c.job, tools: ['shopify'], actionTypes: [], scopes: [], protectedScopes: [],
        locked: false, upgradeTo: null, enabled: c.enabled, permission: c.permission, instructions: c.job, settings: {}, grants: [], waiting: 0, actionsThisWeek: 0, doneThisWeek: 0, lastRunAt: null, lastRunStatus: null, engineAgentId: null, needs: [], approvalOnly: [] }
    } else {
      if (!agentByKey(key)) throw new HttpError(404, 'not_found', 'unknown agent')
      agent = team.agents.find(a => a.key === key)!
    }
    const [queue, log, chat] = await Promise.all([listActions(actor, actor.orgId, { agentKey: logKey, status: 'draft' }), activityLog(actor, actor.orgId, logKey), key.startsWith('custom-') ? Promise.resolve([]) : chatHistory(actor, key)])
    if (key.startsWith('custom-')) agent.waiting = queue.length
    return NextResponse.json({ ok: true, agent, tier: team.tier, tiers: team.tiers, permissionLevels: team.permissionLevels, store: team.store, usage: team.usage, queue, log, chat })
  } catch (e) { return errorResponse(e) }
}
