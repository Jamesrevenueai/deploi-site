/**
 * Chat with one agent or with the whole team, rules only (AI is off): a small set of intents answered from real
 * data (status, what it did today, what needs you, pause / resume, set its autonomy). Anything else gets an
 * honest answer that it cannot be answered without AI, and the list of what can. Every message is stored
 * (agent_chat_messages: retention pass and the customer privacy export/erasure cover it).
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError, isEngineError } from '../engine/errors'
import { isLibraryError } from '../library/errors'
import { AGENT_REF, type AgentAutonomy } from './profiles'
import { commandCenter, merchantOrg, isWorkspace } from './feeds'
import { actorKey, getWorkspace, pauseAgent, resumeAgent, setAgentAutonomy } from './control'
import type { ChatAction, ChatIntent, ChatMessage, NeedsYouItem, TeamAgent, Workspace } from './contract'

export const CHAT_MAX = 1000
const CAN_DO = ['"status" (what I am doing now)', '"what did you do today"', '"what needs me"', '"pause" or "resume"', '"ask me first", "do it and tell me" or "go autonomous"']
const LEVEL_WORDS: Record<AgentAutonomy, string> = { ask_first: 'ask you first', act_then_tell: 'do it and tell you after', autonomous: 'act on its own and tell you in the daily summary' }

export function intentOf(text: string): { intent: ChatIntent; autonomy?: AgentAutonomy } {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/\b(ask (me )?first|check with me|ask before|ask me before)\b/.test(t)) return { intent: 'set_autonomy', autonomy: 'ask_first' }
  if (/\b(do it and tell me|act (and|then) tell|tell me after|just do it and tell)\b/.test(t)) return { intent: 'set_autonomy', autonomy: 'act_then_tell' }
  if (/\b(autonomous|on (your|its|their) own|without asking|don'?t ask)\b/.test(t)) return { intent: 'set_autonomy', autonomy: 'autonomous' }
  if (/\b(resume|unpause|start again|turn (it |them )?back on|carry on)\b/.test(t)) return { intent: 'resume' }
  if (/\b(pause|stop|hold off|turn (it |them )?off)\b/.test(t)) return { intent: 'pause' }
  if (/\b(needs? me|need from me|waiting (on|for) me|approve|approvals?|anything for me|decide)\b/.test(t)) return { intent: 'needs_you' }
  if (/\b(today|so far|what (did|have) you (do|done)|what got done|done today)\b/.test(t)) return { intent: 'today' }
  if (/\b(status|what are you (doing|up to)|doing now|how are you|how is it going|what'?s happening|working on)\b/.test(t)) return { intent: 'status' }
  if (/\b(help|what can you do|commands?)\b/.test(t)) return { intent: 'help' }
  return { intent: 'unknown' }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
function actionsFor(items: NeedsYouItem[]): ChatAction[] {
  const out: ChatAction[] = []
  for (const i of items.slice(0, 3)) {
    if (i.decisions.includes('approve')) out.push({ label: i.primaryAction, needsYouId: i.id, decision: 'approve' })
    if (i.decisions.includes('decline')) out.push({ label: i.secondaryAction ?? 'Decline', needsYouId: i.id, decision: 'decline' })
  }
  return out
}

function honestRefusal(e: unknown): string {
  if (isEngineError(e) && e.code === 'forbidden') return `I can't do that for you: ${e.message}.`
  if (isEngineError(e) || isLibraryError(e)) return `I could not do that: ${(e as Error).message}.`
  throw e
}

async function reply(actor: Actor, agentId: string | null, workspace: Workspace, text: string): Promise<{ intent: ChatIntent; text: string; actions?: ChatAction[] }> {
  const { intent, autonomy } = intentOf(text)
  const cc = await commandCenter(actor, workspace, { doneLimit: 100 })
  const named = agentId ? null : cc.team.find(a => text.toLowerCase().includes(a.name.toLowerCase())) ?? null
  const agent: TeamAgent | null = agentId ? cc.team.find(a => a.id === agentId) ?? null : named
  if (agentId && !agent) throw new EngineError('not_found', 'agent not found')
  const needs = agent ? cc.needsYou.filter(i => i.agent.id === agent.id) : cc.needsYou
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
  const today = (agent ? cc.doneWithProof.filter(d => d.agent.id === agent.id) : cc.doneWithProof).filter(d => d.at >= dayStart.toISOString())
  switch (intent) {
    case 'status': {
      if (agent) return { intent, text: `${agent.name}: ${agent.doingNow}. ${plural(agent.todayActions, 'action')} today. I ${LEVEL_WORDS[agent.autonomy]}.` }
      if (!cc.team.length) return { intent, text: 'There are no agents on this side yet. Connect a system and the team starts on its own.' }
      return { intent, text: [`${plural(cc.hero.agentsRunning, 'agent')} running.`, ...cc.team.map(a => `${a.name}: ${a.doingNow}.`)].join('\n') }
    }
    case 'today': {
      if (!today.length) return { intent, text: agent ? `${agent.name} has not finished anything yet today.` : 'Nothing finished yet today.' }
      return { intent, text: [`Done today (${today.length}):`, ...today.slice(0, 8).map(d => `- ${d.agent.name}: ${d.what} (${d.proof.label}: ${d.proof.href})`)].join('\n') }
    }
    case 'needs_you': {
      if (!needs.length) return { intent, text: 'Nothing needs you right now.' }
      return { intent, text: [`${plural(needs.length, 'thing')} need${needs.length === 1 ? 's' : ''} you:`, ...needs.slice(0, 5).map(i => `- ${i.agent.name}: ${i.title} (${i.ago})`)].join('\n'), actions: actionsFor(needs) }
    }
    case 'pause': case 'resume': {
      if (!agent) return { intent, text: `Which agent? Say its name, e.g. "${intent} ${cc.team[0]?.name ?? 'Inventory Watcher'}".` }
      try {
        if (intent === 'pause') { await pauseAgent(actor, agent.id); return { intent, text: `${agent.name} is paused. It does nothing until you resume it.` } }
        await resumeAgent(actor, agent.id); return { intent, text: `${agent.name} is back on.` }
      } catch (e) { return { intent, text: honestRefusal(e) } }
    }
    case 'set_autonomy': {
      if (!agent) return { intent, text: 'Which agent? Say its name with what you want, e.g. "Inventory Watcher, ask me first".' }
      try {
        await setAgentAutonomy(actor, agent.id, autonomy)
        return { intent, text: `Done: ${agent.name} will now ${LEVEL_WORDS[autonomy!]}. Anything that moves money still waits for your approval.` }
      } catch (e) { return { intent, text: honestRefusal(e) } }
    }
    case 'help':
      return { intent, text: `Here is what I can do: ${CAN_DO.join(', ')}.` }
    default:
      return { intent, text: `I can't answer that without AI turned on; here is what I can do: ${CAN_DO.join(', ')}.` }
  }
}

type Row = { id: string; agent_ref: string | null; role: 'owner' | 'agent'; text: string; actions: ChatAction[]; created_at: string }
const msg = (r: Row): ChatMessage => ({ id: r.id, role: r.role, text: r.text, ...(r.actions?.length ? { actions: r.actions } : {}), at: new Date(r.created_at).toISOString(), agentId: r.agent_ref })

/** Send a message to an agent (agentId) or the team (null); returns this exchange (the owner's message and the reply). */
export async function chat(actor: Actor, agentId: string | null, text: unknown, opts: { workspace?: unknown } = {}): Promise<{ messages: ChatMessage[] }> {
  const orgId = merchantOrg(actor)
  if (agentId !== null && !AGENT_REF.test(agentId)) throw new EngineError('not_found', 'agent not found')
  if (typeof text !== 'string' || !text.trim()) throw new EngineError('invalid_input', 'say something first')
  const t = text.replace(/\u0000/g, '').trim().slice(0, CHAT_MAX)
  const workspace: Workspace = agentId ? (agentId.startsWith('store:') ? 'store' : 'office') : isWorkspace(opts.workspace) ? opts.workspace : (await getWorkspace(actor)).workspace
  const r = await reply(actor, agentId, workspace, t)
  const key = actorKey(actor)
  const rows = await admin(async db => {
    const a = (await db.one<Row>(`insert into agent_chat_messages (org_id, agent_ref, actor_key, role, text, intent) values ($1,$2,$3,'owner',$4,$5) returning *`, [orgId, agentId, key, t, r.intent]))!
    const b = (await db.one<Row>(`insert into agent_chat_messages (org_id, agent_ref, actor_key, role, text, intent, actions) values ($1,$2,$3,'agent',$4,$5,$6) returning *`, [orgId, agentId, key, r.text.slice(0, 4000), r.intent, JSON.stringify(r.actions ?? [])]))!
    return [a, b]
  })
  return { messages: rows.map(msg) }
}

/** The stored conversation with one agent (or the team), oldest first, at most the last 100 messages. */
export async function chatHistory(actor: Actor, agentId: string | null, opts: { limit?: number } = {}): Promise<ChatMessage[]> {
  const orgId = merchantOrg(actor)
  if (agentId !== null && !AGENT_REF.test(agentId)) throw new EngineError('not_found', 'agent not found')
  const n = Math.min(100, Math.max(1, opts.limit ?? 50))
  const rows = await admin(db => db.query<Row>(`select id, agent_ref, role, text, actions, created_at from agent_chat_messages where org_id = $1 and agent_ref is not distinct from $2 order by created_at desc, role asc limit $3`, [orgId, agentId, n]))
  return rows.reverse().map(msg)
}
