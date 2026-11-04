/**
 * The customer inbox: every agent mailbox of the organization as conversations. A thread is an agent's
 * message (or a mail that arrived on its own) with everything that followed it, inbound and outbound,
 * in order. Threads have read/unread and an assigned agent (a label: assigning grants nothing and
 * never makes an agent act on the mail). A person can reply from here; the reply goes out from the
 * agent's mailbox through the same send path and gates as agent mail (sendMessage), bound to the exact
 * text the person sent.
 *
 * Rows are read as the actor (RLS); content is decrypted on the server only for merchant users of the
 * organization. Staff see senders, statuses and times only. Incoming text is data, never instructions.
 */
import { randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { encryptSecret, decryptSecret } from '../connectors/credentials'
import { orgStopReason } from '../engine/kill-switch'
import { contentHash, decryptContent } from './content'
import { emailConfig } from './config'
import { newInternetMessageId } from './mime'
import { sendMessage, type SendOutcome } from './engine'
import { sendBlockers } from './check'
import { parsePolicy } from '../agents/policy'
import { suppressedAmong } from './suppression'
import type { EmailAccountRow } from './accounts'

type MsgRow = { id: string; org_id: string; agent_id: string | null; account_id: string; task_key: string; status: string; status_reason: string | null; from_address: string; to_addresses: string[]; cc_addresses: string[]
  internet_message_id: string; in_reply_to: string | null; created_at: string; accepted_at: string | null; approved_by: string | null; meta: Record<string, unknown> }
type InRow = { id: string; org_id: string; agent_id: string | null; account_id: string; internet_message_id: string | null; from_address: string; to_addresses: string[]; classification: string; status: string; status_reason: string | null
  thread_message_id: string | null; received_at: string; attachments: { filename: string; contentType: string; size: number | null }[]; auto_reply: boolean; auto_reply_reason: string | null }

export type InboxItem = {
  id: string; direction: 'outbound' | 'inbound'; at: string; from: string; to: string[]; status: string; statusReason: string | null
  subject: string | null; body: string | null; byPerson: string | null; attachments: { filename: string; contentType: string; size: number | null }[]; autoReply: string | null
}
export type InboxThread = {
  key: string; agentId: string | null; agentName: string | null; mailbox: string | null; subject: string | null; participants: string[]
  lastAt: string; unread: boolean; inboundCount: number; outboundCount: number; assignedAgentId: string | null; assignedAgentName: string | null; quarantined: boolean
}

const KEY = /^[mi]:[0-9a-f-]{36}$/
const MAX_SHOWN = 8000
const shown = (t: string) => (t.length > MAX_SHOWN ? `${t.slice(0, MAX_SHOWN)}\n… (shortened here; the full message is ${t.length} characters)` : t)

/** Group messages and inbound mail into threads: follow replies (In-Reply-To, the thread a reply matched) back to the first item. */
function threadKeys(msgs: MsgRow[], inbound: InRow[]): Map<string, string> {
  const byMid = new Map<string, { kind: 'm' | 'i'; id: string }>()
  for (const m of msgs) byMid.set(m.internet_message_id, { kind: 'm', id: m.id })
  for (const i of inbound) if (i.internet_message_id) byMid.set(i.internet_message_id, { kind: 'i', id: i.id })
  const msgById = new Map(msgs.map(m => [m.id, m])), inById = new Map(inbound.map(i => [i.id, i]))
  const parent = (k: string): string | null => {
    const [kind, id] = [k[0], k.slice(2)]
    if (kind === 'm') {
      const m = msgById.get(id)!
      const fixed = typeof m.meta?.thread_key === 'string' && KEY.test(m.meta.thread_key) ? m.meta.thread_key : null
      if (fixed && fixed !== k) return fixed
      const p = m.in_reply_to ? byMid.get(m.in_reply_to) : undefined
      return p ? `${p.kind}:${p.id}` : null
    }
    const i = inById.get(id)!
    return i.thread_message_id && msgById.has(i.thread_message_id) ? `m:${i.thread_message_id}` : null
  }
  const out = new Map<string, string>()
  const root = (k: string): string => {
    let cur = k
    for (let n = 0; n < 50; n++) {
      if (out.has(cur)) return out.get(cur)!
      const p = parent(cur)
      if (!p || p === cur || (p[0] === 'm' && !msgById.has(p.slice(2))) || (p[0] === 'i' && !inById.has(p.slice(2)))) return cur
      cur = p
    }
    return cur
  }
  for (const m of msgs) out.set(`m:${m.id}`, root(`m:${m.id}`))
  for (const i of inbound) out.set(`i:${i.id}`, root(`i:${i.id}`))
  return out
}

async function loadOrgMail(db: Db, actor: Actor) {
  const scope = actor.kind === 'staff' ? 'true' : 'm.org_id = current_org_id()'
  const msgs = await db.query<MsgRow>(
    `select m.id, m.org_id, m.agent_id, m.account_id, m.task_key, m.status, m.status_reason, m.from_address, m.to_addresses, m.cc_addresses, m.internet_message_id, m.in_reply_to, m.created_at, m.accepted_at, m.approved_by, m.meta
     from email_messages m join email_accounts a on a.id = m.account_id where ${scope} and a.provider = 'deploi' order by m.created_at desc limit 500`)
  const inbound = await db.query<InRow>(
    `select i.id, i.org_id, i.agent_id, i.account_id, i.internet_message_id, i.from_address, i.to_addresses, i.classification, i.status, i.status_reason, i.thread_message_id, i.received_at, i.attachments, i.auto_reply, i.auto_reply_reason
     from email_inbound i where ${scope.replace('m.', 'i.')} order by i.received_at desc limit 500`)
  const agents = await db.query<{ id: string; name: string }>(`select id, name from agents where ${scope.replace('m.', '')}`)
  const accounts = await db.query<{ id: string; address: string; agent_id: string | null }>(`select id, address, agent_id from email_accounts a where ${scope.replace('m.', 'a.')} and provider = 'deploi'`)
  const states = await db.query<{ thread_key: string; read_at: string | null; assigned_agent_id: string | null }>(`select thread_key, read_at, assigned_agent_id from email_thread_state where ${scope.replace('m.', '')}`)
  // timestamps as ISO strings, so ordering and comparisons are by time
  const t = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString())
  for (const m of msgs) { m.created_at = t(m.created_at)!; m.accepted_at = t(m.accepted_at) }
  for (const i of inbound) i.received_at = t(i.received_at)!
  for (const s of states) s.read_at = t(s.read_at)
  return { msgs, inbound, agents: new Map(agents.map(a => [a.id, a.name])), accounts: new Map(accounts.map(a => [a.id, a])), states: new Map(states.map(s => [s.thread_key, s])), keys: threadKeys(msgs, inbound) }
}

function decryptSubjects(msgs: { id: string }[], inbound: { id: string }[]) {
  return admin(async db => {
    const out = new Map<string, { subject: string; body: string }>()
    if (msgs.length) for (const e of await db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_messages where id = any($1::uuid[])', [msgs.map(m => m.id)])) {
      try { const c = decryptContent(e.id, e.key_id, e.content_ciphertext); out.set(`m:${e.id}`, { subject: c.subject, body: c.bodyText }) } catch { /* unavailable */ }
    }
    if (inbound.length) for (const e of await db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_inbound where id = any($1::uuid[])', [inbound.map(i => i.id)])) {
      try { const c = JSON.parse(decryptSecret(e.key_id, e.content_ciphertext, `email-inbound:${e.id}`)) as { subject: string; text: string }; out.set(`i:${e.id}`, { subject: c.subject, body: c.text }) } catch { /* unavailable */ }
    }
    return out
  })
}

/** The organization's conversations, newest activity first. filter: all | unread | assigned (to agentId). */
export async function listInboxThreads(actor: Actor, f: { filter?: 'all' | 'unread' | 'assigned'; agentId?: string | null } = {}): Promise<InboxThread[]> {
  const d = await withActor(actor, db => loadOrgMail(db, actor))
  const groups = new Map<string, { msgs: MsgRow[]; inbound: InRow[] }>()
  for (const m of d.msgs) { const k = d.keys.get(`m:${m.id}`)!; const g = groups.get(k) ?? { msgs: [], inbound: [] }; g.msgs.push(m); groups.set(k, g) }
  for (const i of d.inbound) { const k = d.keys.get(`i:${i.id}`)!; const g = groups.get(k) ?? { msgs: [], inbound: [] }; g.inbound.push(i); groups.set(k, g) }
  const roots = [...groups.keys()].map(k => ({ k, kind: k[0], id: k.slice(2) }))
  const content = actor.kind === 'staff' ? new Map() : await decryptSubjects(roots.filter(r => r.kind === 'm'), roots.filter(r => r.kind === 'i'))
  const threads: InboxThread[] = []
  for (const [key, g] of groups) {
    const first = key[0] === 'm' ? g.msgs.find(m => m.id === key.slice(2)) : undefined
    const firstIn = key[0] === 'i' ? g.inbound.find(i => i.id === key.slice(2)) : undefined
    const accountId = first?.account_id ?? firstIn?.account_id ?? null
    const acc = accountId ? d.accounts.get(accountId) : undefined
    const agentId = first?.agent_id ?? firstIn?.agent_id ?? acc?.agent_id ?? null
    const times = [...g.msgs.map(m => m.created_at), ...g.inbound.map(i => i.received_at)].map(t => new Date(t).getTime())
    const lastIn = Math.max(0, ...g.inbound.map(i => new Date(i.received_at).getTime()))
    const st = d.states.get(key)
    const unread = g.inbound.length > 0 && (!st?.read_at || new Date(st.read_at).getTime() < lastIn)
    const participants = [...new Set([...g.msgs.flatMap(m => m.to_addresses), ...g.inbound.map(i => i.from_address)])]
    const t: InboxThread = {
      key, agentId, agentName: agentId ? d.agents.get(agentId) ?? null : null, mailbox: acc?.address ?? null, subject: content.get(key)?.subject ?? null, participants,
      lastAt: new Date(Math.max(...times)).toISOString(), unread, inboundCount: g.inbound.length, outboundCount: g.msgs.length,
      assignedAgentId: st?.assigned_agent_id ?? null, assignedAgentName: st?.assigned_agent_id ? d.agents.get(st.assigned_agent_id) ?? null : null,
      quarantined: g.inbound.length > 0 && g.inbound.every(i => i.status === 'quarantined'),
    }
    if (f.filter === 'unread' && !t.unread) continue
    if (f.filter === 'assigned' && (!t.assignedAgentId || (f.agentId && t.assignedAgentId !== f.agentId))) continue
    threads.push(t)
  }
  return threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

/** One conversation in order, with the exact text of every message (merchant users only). */
export async function getInboxThread(actor: Actor, key: string): Promise<{ thread: InboxThread; items: InboxItem[] }> {
  if (!KEY.test(key)) throw new EngineError('invalid_input', 'unknown conversation')
  const d = await withActor(actor, db => loadOrgMail(db, actor))
  const msgs = d.msgs.filter(m => d.keys.get(`m:${m.id}`) === key), inbound = d.inbound.filter(i => d.keys.get(`i:${i.id}`) === key)
  if (!msgs.length && !inbound.length) throw new EngineError('not_found', 'conversation not found')
  const content = actor.kind === 'staff' ? new Map<string, { subject: string; body: string }>() : await decryptSubjects(msgs, inbound)
  const items: InboxItem[] = [
    ...msgs.map(m => ({ id: m.id, direction: 'outbound' as const, at: m.accepted_at ?? m.created_at, from: m.from_address, to: [...m.to_addresses, ...m.cc_addresses], status: m.status, statusReason: m.status_reason,
      subject: content.get(`m:${m.id}`)?.subject ?? null, body: content.has(`m:${m.id}`) ? shown(content.get(`m:${m.id}`)!.body) : null, byPerson: m.task_key === 'human_reply' ? m.approved_by : null, attachments: [], autoReply: null })),
    ...inbound.map(i => ({ id: i.id, direction: 'inbound' as const, at: i.received_at, from: i.from_address, to: i.to_addresses, status: i.status, statusReason: i.status_reason,
      subject: content.get(`i:${i.id}`)?.subject ?? null, body: content.has(`i:${i.id}`) ? shown(content.get(`i:${i.id}`)!.body) : null, byPerson: null, attachments: i.attachments ?? [], autoReply: i.auto_reply ? i.auto_reply_reason ?? 'automatic reply' : null })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const thread = (await listInboxThreads(actor)).find(t => t.key === key)!
  return { thread, items }
}

async function visibleThread(actor: Actor, key: string) {
  if (!KEY.test(key)) throw new EngineError('invalid_input', 'unknown conversation')
  const d = await withActor(actor, db => loadOrgMail(db, actor))
  const msgs = d.msgs.filter(m => d.keys.get(`m:${m.id}`) === key), inbound = d.inbound.filter(i => d.keys.get(`i:${i.id}`) === key)
  const orgId = msgs[0]?.org_id ?? inbound[0]?.org_id
  if (!orgId) throw new EngineError('not_found', 'conversation not found')
  assertMerchant(actor, orgId)
  return { orgId, msgs, inbound, data: d }
}

export async function markThread(actor: Actor, key: string, read: boolean) {
  const t = await visibleThread(actor, key)
  await admin(db => db.query(`insert into email_thread_state (org_id, thread_key, read_at, read_by) values ($1,$2,$3,$4)
    on conflict (org_id, thread_key) do update set read_at = $3, read_by = $4`, [t.orgId, key, read ? new Date().toISOString() : null, read ? actor.label : null]))
  return { read }
}

/** Assign a conversation to one of the organization's agents (or clear it). A label only: the agent is not given the mail to act on. */
export async function assignThread(actor: Actor, key: string, agentId: string | null) {
  const t = await visibleThread(actor, key)
  if (agentId) {
    const a = await withActor(actor, db => db.one<{ id: string; org_id: string; status: string }>('select id, org_id, status from agents where id = $1', [agentId]))
    if (!a || a.org_id !== t.orgId || a.status === 'deleted') throw new EngineError('not_found', 'agent not found')
  }
  await admin(async db => {
    await db.query(`insert into email_thread_state (org_id, thread_key, assigned_agent_id, assigned_by, assigned_at) values ($1,$2,$3,$4,now())
      on conflict (org_id, thread_key) do update set assigned_agent_id = $3, assigned_by = $4, assigned_at = now()`, [t.orgId, key, agentId, actor.label])
    await audit(db, { orgId: t.orgId, entityType: 'email', entityId: key, event: 'email.thread_assigned', actor: actor.label, detail: { agent_id: agentId } })
  })
  return { assignedAgentId: agentId }
}

/**
 * Reply as a person. The reply goes to whoever last wrote in the conversation (or the agent's original
 * recipients), from the agent's own mailbox, through sendMessage with every gate: the agent's email
 * authorization (it must be allowed to send what a person approves), its allowed recipients,
 * suppression, the daily cap, EMAIL_LIVE_SENDS and store access. A quarantined sender is never answered.
 * `idempotencyKey` (from the client) makes a double submit send once.
 */
export async function replyToThread(actor: Actor, key: string, input: { bodyText: string; idempotencyKey: string }): Promise<SendOutcome> {
  const t = await visibleThread(actor, key)
  const body = String(input.bodyText ?? '').replace(/\r\n/g, '\n').trim()
  if (!body || body.length > 20_000) throw new EngineError('invalid_input', 'write a reply of 1 to 20,000 characters')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey ?? '')) throw new EngineError('invalid_input', 'a reply needs an idempotency key')
  const items = [...t.msgs.map(m => ({ at: m.created_at, kind: 'm' as const, m })), ...t.inbound.map(i => ({ at: i.received_at, kind: 'i' as const, i }))].sort((a, b) => a.at.localeCompare(b.at))
  const lastIn = [...t.inbound].sort((a, b) => a.received_at.localeCompare(b.received_at)).pop()
  if (lastIn && lastIn.status !== 'accepted') throw new EngineError('forbidden', 'the last message came from a quarantined sender; Deploi does not reply to it')
  const accountId = (t.msgs[0] ?? t.inbound[0]).account_id
  const root = t.msgs.find(m => `m:${m.id}` === key)
  const to = lastIn ? [lastIn.from_address] : root ? root.to_addresses : []
  if (!to.length) throw new EngineError('invalid_input', 'nobody to reply to in this conversation')
  const last = items[items.length - 1]
  const inReplyTo = last.kind === 'm' ? last.m.internet_message_id : last.i.internet_message_id
  const subjects = await decryptSubjects(root ? [root] : [], !root && t.inbound[0] ? [t.inbound[0]] : [])
  const baseSubject = (subjects.get(key)?.subject ?? 'your message').replace(/^(\s*(re|aw|fwd?):\s*)+/i, '').slice(0, 230)
  const content = { subject: `Re: ${baseSubject}`, bodyText: body, attachments: [] }

  const id = await admin(async db => {
    const stopped = await orgStopReason(db, t.orgId)
    if (stopped) throw new EngineError('agent_inactive', `${stopped}; replies are held`)
    const dup = await db.one<{ id: string }>(`select id from email_messages where org_id = $1 and dedupe_key = $2`, [t.orgId, `human_reply:${input.idempotencyKey}`])
    if (dup) return { id: dup.id, duplicate: true }
    const account = await db.one<EmailAccountRow & { agent_id: string | null }>('select * from email_accounts where id = $1', [accountId])
    if (!account || account.provider !== 'deploi' || account.org_id !== t.orgId || !account.agent_id) throw new EngineError('not_found', 'the mailbox of this conversation is no longer available')
    const agent = await db.one<{ id: string; status: string; active_policy_id: string | null }>('select id, status, active_policy_id from agents where id = $1', [account.agent_id])
    const pol = agent?.active_policy_id ? await db.one<{ id: string; version: number; status: string; policy: unknown }>('select id, version, status, policy from agent_policies where id = $1', [agent.active_policy_id]) : null
    const policy = pol ? parsePolicy(pol.policy) : null
    if (!agent || !policy) throw new EngineError('agent_inactive', 'the agent of this mailbox has no active authorization, so its mailbox cannot send')
    const blockers = sendBlockers({ agentStatus: agent.status, policyStatus: pol!.status, policy, account, message: { from: account.address, to, cc: [] } as never })
    if (blockers.length) throw new EngineError(agent.status !== 'active' ? 'agent_inactive' : 'forbidden', `cannot send: ${blockers.join('; ')}`)
    const suppressed = await suppressedAmong(db, t.orgId, to)
    if (suppressed.length) throw new EngineError('forbidden', `not sent: ${suppressed.join(', ')} bounced, complained or unsubscribed earlier`)
    const hash = contentHash({ from: account.address, to, cc: [], content })
    const row = await db.one<{ id: string }>(`insert into email_messages (org_id, agent_id, run_id, account_id, policy_id, policy_version, task_key, dedupe_key, status, status_reason, from_address, to_addresses, cc_addresses,
        attachment_count, attachment_bytes, key_id, content_ciphertext, content_hash, internet_message_id, meta, in_reply_to, reply_token, approval_kind, approved_by, approved_hash, approved_at)
      values ($1,$2,null,$3,$4,$5,'human_reply',$6,'queued','sent by you from the inbox',$7,$8,'{}',0,0,'pending','pending',$9,$10,$11,$12,$13,'individual',$14,$9,now()) returning id`,
      [t.orgId, account.agent_id, account.id, pol!.id, pol!.version, `human_reply:${input.idempotencyKey}`, account.address, to, hash,
        newInternetMessageId(emailConfig.agentMailDomain || undefined), JSON.stringify({ thread_key: key }), inReplyTo, randomBytes(16).toString('hex'), actor.label])
    const enc = encryptSecret(JSON.stringify(content), `email-message:${row!.id}`)
    await db.query('update email_messages set key_id = $2, content_ciphertext = $3 where id = $1', [row!.id, enc.keyId, enc.ciphertext])
    await db.query(`insert into email_thread_state (org_id, thread_key, read_at, read_by) values ($1,$2,now(),$3) on conflict (org_id, thread_key) do update set read_at = now(), read_by = $3`, [t.orgId, key, actor.label])
    await audit(db, { orgId: t.orgId, entityType: 'approval', entityId: row!.id, event: 'email.approved', actor: actor.label, detail: { email_message: true, human_reply: true, thread_key: key, content_hash: hash, agent_id: account.agent_id, policy_version: pol!.version } })
    return { id: row!.id, duplicate: false }
  })
  if (id.duplicate) {
    const m = await admin(db => db.one<{ status: string; status_reason: string | null }>('select status, status_reason from email_messages where id = $1', [id.id]))
    return { messageId: id.id, status: m!.status as SendOutcome['status'], reason: m!.status_reason, duplicate: true }
  }
  return sendMessage(id.id, { actor: actor.label })
}
