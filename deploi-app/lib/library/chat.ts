/**
 * Text and voice chat with one agent. The agent answers from its own real data (what is waiting,
 * what it did, what it may do) and turns a few kinds of message into actions:
 *   "run now"            -> runs the agent (if it is on)
 *   "from now on ..."    -> saved as a standing instruction (the runner reads it on every run)
 *   "approve everything" -> approves the open drafts that are not money or publishing actions
 *   "what's waiting"     -> lists the approval queue
 * Anything it cannot do, it says so and names the agent or the screen that can. No language model
 * is called in this build: replies are composed from store facts, so nothing here can invent a
 * result. `LibraryBrain` is the seam where a model-written reply plugs in later.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { agentByKey, LIBRARY } from './config'
import { LibraryError } from './errors'
import { APPROVAL_ONLY, approveAction, runLibraryAgent, type ActionRow } from './actions'
import { setInstructions } from './switches'
import { matchCapabilities } from './runners'
import { recordUsage } from './usage'

export type ChatOutcome = { kind: 'answer' | 'run' | 'instruction' | 'approved' | 'refused' | 'off'; detail?: Record<string, unknown> }
export type ChatMessage = { id: string; role: 'merchant' | 'agent'; text: string; via: 'text' | 'voice'; outcome: ChatOutcome; created_at: string }

/** Where a model-written reply would plug in. The default brain is rule-based and reads only store facts. */
export type LibraryBrain = (input: { agentKey: string; text: string; facts: ChatFacts }) => Promise<{ text: string; outcome: ChatOutcome } | null>
let brain: LibraryBrain | null = null
export function setLibraryBrain(b: LibraryBrain | null) { brain = b }

export type ChatFacts = { enabled: boolean; permission: string; waiting: ActionRow[]; recent: ActionRow[]; instructions: string; lastRun: { at: string; status: string } | null }

async function facts(actor: Actor, orgId: string, agentKey: string): Promise<ChatFacts> {
  return withActor(actor, async db => {
    const sw = await db.one<{ enabled: boolean; permission: string; standing_instructions: string; last_run_at: string | null; last_run_status: string | null }>('select enabled, permission, standing_instructions, last_run_at, last_run_status from library_switches where org_id = $1 and agent_key = $2', [orgId, agentKey])
    const waiting = await db.query<ActionRow>(`select * from library_actions where org_id = $1 and agent_key = $2 and status = 'draft' order by created_at desc limit 20`, [orgId, agentKey])
    const recent = await db.query<ActionRow>(`select * from library_actions where org_id = $1 and agent_key = $2 and status <> 'draft' order by created_at desc limit 10`, [orgId, agentKey])
    return { enabled: Boolean(sw?.enabled), permission: sw?.permission ?? 'draft', waiting, recent, instructions: sw?.standing_instructions ?? '', lastRun: sw?.last_run_at ? { at: sw.last_run_at, status: sw.last_run_status ?? 'completed' } : null }
  })
}

const list = (rows: ActionRow[], n = 5) => rows.slice(0, n).map(r => `• ${r.title}`).join('\n') + (rows.length > n ? `\n• …and ${rows.length - n} more` : '')
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }

export async function chat(actor: Actor, agentKey: string, text: string, via: 'text' | 'voice' = 'text'): Promise<{ merchant: ChatMessage; agent: ChatMessage }> {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'chat belongs to the merchant')
  const orgId = actor.orgId
  assertMerchant(actor, orgId)
  const cfg = agentByKey(agentKey)
  if (!cfg) throw new LibraryError('not_found', 'unknown agent')
  const t = text.trim().slice(0, 4000)
  if (!t) throw new LibraryError('invalid_input', 'say something first')
  const f = await facts(actor, orgId, agentKey)
  const m = await admin(db => db.one<ChatMessage>(`insert into library_chat_messages (org_id, agent_key, role, text, via) values ($1,$2,'merchant',$3,$4) returning id, role, text, via, outcome, created_at`, [orgId, agentKey, t, via]))
  let reply: { text: string; outcome: ChatOutcome } | null = brain ? await brain({ agentKey, text: t, facts: f }) : null
  if (!reply) reply = await ruleBrain(actor, orgId, cfg.key, cfg.name, t, f)
  const a = await admin(async db => {
    const row = await db.one<ChatMessage>(`insert into library_chat_messages (org_id, agent_key, role, text, via, outcome) values ($1,$2,'agent',$3,$4,$5) returning id, role, text, via, outcome, created_at`, [orgId, agentKey, reply!.text.slice(0, 4000), via, JSON.stringify(reply!.outcome)])
    await recordUsage(db, { orgId, agentKey, actionType: 'chat_turn' })
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.chat', actor: actor.label, detail: { agent_key: agentKey, via, outcome: reply!.outcome.kind } })
    return row!
  })
  return { merchant: m!, agent: a }
}

async function ruleBrain(actor: Actor, orgId: string, key: string, name: string, text: string, f: ChatFacts): Promise<{ text: string; outcome: ChatOutcome }> {
  const t = text.toLowerCase()
  const can = (agentByKey(key)?.actionTypes ?? []).map(a => a.label.toLowerCase())
  if (/^(from now on|always|never|remember|in future|going forward|please (always|never)|don'?t ever)\b/.test(t) || /\bfrom now on\b/.test(t)) {
    const merged = f.instructions ? `${f.instructions}\n${text.trim()}` : text.trim()
    await setInstructions(actor, key, merged)
    return { text: `Noted. I will follow that on every run: "${text.trim()}". You can edit or remove it under Standing instructions.`, outcome: { kind: 'instruction', detail: { instructions: merged } } }
  }
  if (/\b(run|check|look|go|do it|start)\b/.test(t) && /\b(now|again|today|please|run|check)\b/.test(t) && !/\bwhat\b/.test(t)) {
    if (!f.enabled) return { text: `I am switched off, so I cannot run. Flip my switch on the team page or on my dashboard and ask again.`, outcome: { kind: 'off' } }
    const r = await runLibraryAgent({ orgId, agentKey: key, trigger: 'chat', actor: actor.label })
    const c = r.counts
    const parts = [c.done ? `${c.done} done` : '', c.drafted ? `${c.drafted} waiting for your approval` : '', c.noted ? `${c.noted} reported` : '', c.approvedUnsent ? `${c.approvedUnsent} approved but not sent (email is off here)` : '', c.failed ? `${c.failed} failed` : '', c.skipped ? `${c.skipped} already open or skipped` : ''].filter(Boolean)
    return { text: r.status === 'completed' ? `Done. ${parts.length ? parts.join(', ') + '.' : 'Nothing new to report.'} Everything is in my activity log with the proof.` : `I could not finish: ${r.reason}. Nothing was changed.`, outcome: { kind: 'run', detail: { runId: r.runId, status: r.status, counts: c } } }
  }
  if (/\bapprove\b.*\b(all|everything|them)\b/.test(t)) {
    const ok = f.waiting.filter(w => !APPROVAL_ONLY.has(w.action_type))
    const held = f.waiting.filter(w => APPROVAL_ONLY.has(w.action_type))
    let done = 0, failed = 0
    for (const w of ok) { try { const r = await approveAction(actor, w.id); if (r.status === 'failed') failed++; else done++ } catch { failed++ } }
    return { text: `${done ? `Approved ${done}.` : 'Nothing to approve.'}${failed ? ` ${failed} could not be applied; see the log.` : ''}${held.length ? ` ${held.length} ${held.length === 1 ? 'is' : 'are'} money or publishing actions, which you approve one by one in the queue.` : ''}`, outcome: { kind: 'approved', detail: { approved: done, failed, held: held.length } } }
  }
  if (/\b(waiting|pending|queue|approve|approval)\b/.test(t) || /what('s| is| do you) (need|want)/.test(t)) {
    return { text: f.waiting.length ? `${f.waiting.length} item${f.waiting.length === 1 ? '' : 's'} waiting for you:\n${list(f.waiting)}\nOpen the approval queue to approve or decline each one.` : 'Nothing is waiting for your approval right now.', outcome: { kind: 'answer', detail: { waiting: f.waiting.length } } }
  }
  if (/\b(what (did|have) you|status|last run|what happened|recently|done)\b/.test(t) || /^(hi|hello|hey)\b/.test(t)) {
    const last = f.lastRun ? `My last run ${f.lastRun.status} ${ago(f.lastRun.at)}.` : 'I have not run yet.'
    return { text: `${/^(hi|hello|hey)\b/.test(t) ? `Hello. I am ${name}. ` : ''}${f.enabled ? `I am on, at "${f.permission}".` : 'I am switched off.'} ${last} ${f.waiting.length} waiting for you, ${f.recent.length} recent item${f.recent.length === 1 ? '' : 's'} in my log.${f.recent.length ? `\nMost recent:\n${list(f.recent, 3)}` : ''}`, outcome: { kind: 'answer', detail: { waiting: f.waiting.length } } }
  }
  if (/\b(what can you|help|how do you|what do you do)\b/.test(t)) {
    return { text: `I can: ${can.join('; ')}. At "read" I only report, at "draft" everything waits for your approval, and at "act" I run the action types you grant auto-run for, except money and publishing actions, which always wait for you. Say "run now", ask "what's waiting", or tell me "from now on …" to set a standing instruction.`, outcome: { kind: 'answer' } }
  }
  const others = matchCapabilities(text).filter(k => k !== key).map(k => agentByKey(k)?.name).filter(Boolean)
  return { text: `I can't do that from chat, and I won't guess. ${others.length ? `That sounds like a job for ${others.join(' or ')}; you can switch ${others.length === 1 ? 'it' : 'them'} on from the team page.` : `What I can do: ${can.join('; ')}.`} Say "help" for the commands I understand.`, outcome: { kind: 'refused', detail: { suggested: others } } }
}

export async function chatHistory(actor: Actor, agentKey: string, limit = 50): Promise<ChatMessage[]> {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'chat belongs to the merchant')
  const rows = await withActor(actor, db => db.query<ChatMessage>('select id, role, text, via, outcome, created_at from library_chat_messages where org_id = $1 and agent_key = $2 order by created_at desc limit $3', [actor.orgId, agentKey, Math.min(limit, 200)]))
  return rows.reverse()
}

export const AGENT_NAMES = LIBRARY.agents.map(a => a.name)
