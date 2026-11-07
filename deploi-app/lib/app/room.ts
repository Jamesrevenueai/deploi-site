/**
 * The team room: one conversation where the agents talk to each other and to the owner, built from what really
 * happened (never invented lines). Every message comes from a stored record:
 *   case events (lib/cases)    an agent found a problem, did something, asked the owner, checked it worked, or handed
 *                              the work to another agent ("Inventory Watcher -> Supplier Coordinator: ..."); a task the
 *                              owner gave an agent and the agent picking it up
 *   discovery runs             Deploi reading the business (what it read, how long it took, what it found)
 *   the team conversation      what the owner said to the team and the team's answers (agent_chat_messages; a task
 *                              given in the chat shows once, as the task itself)
 * The owner writes into the room through the team conversation (POST /api/app/chat): "<Agent name>, please ..."
 * gives that agent a task (lib/app/tasks.ts).
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import { merchantOrg, ago } from './feeds'
import { teamState, refOfCase, type TeamState } from './team'
import type { Workspace } from './contract'

export type RoomParty = { id: string | null; name: string; color: string | null; kind: 'agent' | 'owner' | 'deploi' }
export type RoomKind = 'found' | 'did' | 'asked' | 'checked' | 'handoff' | 'task' | 'picked_up' | 'note' | 'learned' | 'chat' | 'stuck'
export type RoomMessage = { id: string; at: string; ago: string; from: RoomParty; to: RoomParty | null; kind: RoomKind; text: string; href: string | null; caseRef: string | null }

const YOU: RoomParty = { id: null, name: 'You', color: null, kind: 'owner' }
const DEPLOI: RoomParty = { id: null, name: 'Deploi', color: null, kind: 'deploi' }
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

function party(st: TeamState, id: string | null): RoomParty | null {
  if (!id) return null
  const src = st.sources.find(s => s.id === id)
  if (!src) return null
  return { id, name: src.name, color: st.profiles.get(id)?.color ?? null, kind: 'agent' }
}

type EvRow = { id: string; at: string; actor: string; type: string; to_status: string | null; summary: string; detail: Record<string, unknown>; ref: string; kind: string; title: string; problem: string; agent_kind: string | null; agent_ref: string | null; dedupe_key: string; records: { type: string; id: string }[] }

export async function teamRoom(actor: Actor, workspace: Workspace, opts: { limit?: number; now?: Date } = {}): Promise<RoomMessage[]> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const limit = Math.min(200, Math.max(1, opts.limit ?? 80))
  return admin(async db => {
    const st = await teamState(db, orgId)
    const out: RoomMessage[] = []
    const evs = await db.query<EvRow>(
      `select e.id::text as id, e.at, e.actor, e.type, e.to_status, e.summary, e.detail, c.ref, c.kind, c.title, c.problem, c.agent_kind, c.agent_ref, c.dedupe_key, c.records
         from case_events e join cases c on c.id = e.case_id
        where e.org_id = $1 and c.suite = $2 and e.type in ('opened','handoff','status','action','verification','note')
        order by e.at desc, e.id desc limit $3`, [orgId, workspace === 'store' ? 'commerce' : 'office', limit])
    for (const e of evs) {
      const ownerRef = refOfCase(st.idx, e)
      const agent = party(st, ownerRef)
      const byOwner = e.actor.startsWith('user:') || e.actor.startsWith('shopify:')
      const base = { id: `case:${e.id}`, at: new Date(e.at).toISOString(), ago: ago(new Date(e.at).toISOString(), now), href: `/store/work/${encodeURIComponent(e.ref)}`, caseRef: e.ref }
      const isTask = e.kind === 'owner_task'
      if (e.type === 'handoff') {
        const d = e.detail as { from?: { kind: string; ref: string } | null; to?: { kind: string; ref: string } }
        const fromRef = d.from ? refOfCase(st.idx, { agent_kind: d.from.kind, agent_ref: d.from.ref, dedupe_key: '', records: [] }) : null
        const toRef = d.to ? refOfCase(st.idx, { agent_kind: d.to.kind, agent_ref: d.to.ref, dedupe_key: '', records: [] }) : null
        const from = party(st, fromRef) ?? DEPLOI, to = party(st, toRef)
        out.push({ ...base, from, to, kind: 'handoff', text: clip(`${to ? `${to.name}, ` : ''}this one is yours: ${e.title}. ${e.summary}`) })
      } else if (e.type === 'opened') {
        if (isTask || byOwner) out.push({ ...base, from: YOU, to: agent, kind: 'task', text: clip(`${agent ? `${agent.name}, ` : ''}${e.problem}`) })
        else if (agent) out.push({ ...base, from: agent, to: null, kind: 'found', text: clip(`I found something: ${e.title}`) })
      } else if (e.type === 'status') {
        const from = byOwner ? YOU : agent
        if (!from) continue
        if (e.to_status === 'awaiting_approval') out.push({ ...base, from, to: YOU, kind: 'asked', text: clip(`I need your yes or no: ${e.title}`) })
        else if (e.to_status === 'investigating' && isTask && e.summary.startsWith('Picked up')) out.push({ ...base, from, to: YOU, kind: 'picked_up', text: clip(`On it: ${e.title}`) })
        else if (e.to_status === 'blocked' || e.to_status === 'failed') out.push({ ...base, from, to: null, kind: 'stuck', text: clip(`I am stuck on ${e.title}: ${e.summary}`) })
        else if (e.to_status === 'cancelled' && byOwner) out.push({ ...base, from: YOU, to: agent, kind: 'note', text: clip(`Cancelled: ${e.title}`) })
        else if (e.to_status === 'executing' || e.to_status === 'waiting_external') out.push({ ...base, from, to: null, kind: 'did', text: clip(`${e.to_status === 'executing' ? 'Working on it' : 'Waiting on someone else'}: ${e.title}`) })
      } else if (e.type === 'action') {
        if (agent) out.push({ ...base, from: agent, to: null, kind: 'did', text: clip(e.summary) })
      } else if (e.type === 'verification') {
        out.push({ ...base, from: byOwner ? YOU : agent ?? DEPLOI, to: null, kind: 'checked', text: clip(byOwner ? `Done: ${e.title}` : `Done and checked: ${e.summary}`) })
      } else if (e.type === 'note' && e.actor.startsWith('agent:')) {
        if (agent) out.push({ ...base, from: agent, to: YOU, kind: 'note', text: clip(e.summary) })
      }
    }
    const runs = await db.query<{ id: string; started_at: string; finished_at: string; findings_count: number; cases_opened: number; sources: { label: string; status: string }[] }>(
      `select id, started_at, finished_at, findings_count, cases_opened, sources from discovery_runs where org_id = $1 and status in ('completed','partial') order by finished_at desc limit 5`, [orgId])
    for (const r of runs) {
      const secs = Math.max(0, Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000))
      const read = [...new Set((Array.isArray(r.sources) ? r.sources : []).filter(s => s.status === 'read').map(s => s.label))]
      const at = new Date(r.finished_at).toISOString()
      out.push({ id: `learn:${r.id}`, at, ago: ago(at, now), from: DEPLOI, to: null, kind: 'learned', href: '/store/discover', caseRef: null,
        text: clip(`I read your business in ${secs < 1 ? 'under a second' : `${secs} second${secs === 1 ? '' : 's'}`}${read.length ? ` (${read.join(', ')})` : ''}: ${r.findings_count} thing${r.findings_count === 1 ? '' : 's'} found, ${r.cases_opened} handed to the team.`) })
    }
    const chat = await db.query<{ id: string; role: 'owner' | 'agent'; text: string; created_at: string }>(
      `select id, role, text, created_at from agent_chat_messages where org_id = $1 and agent_ref is null and intent is distinct from 'delegate' order by created_at desc limit 40`, [orgId])
    for (const m of chat) {
      const at = new Date(m.created_at).toISOString()
      out.push({ id: `chat:${m.id}`, at, ago: ago(at, now), from: m.role === 'owner' ? YOU : { id: null, name: 'Your team', color: null, kind: 'agent' }, to: null, kind: 'chat', text: clip(m.text, 1000), href: null, caseRef: null })
    }
    // oldest first, like a conversation; the newest `limit`
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-limit)
  })
}
