/**
 * An agent mailbox as conversations: each message the agent wrote, with the replies matched to it,
 * plus mail that matched no thread (forwards, copies) and quarantined mail. Content is decrypted only
 * for merchant users of the owning organization; staff see senders, statuses and times only.
 * Incoming text is shown as data for the merchant to read. The agent never acts on it.
 */
import { admin } from '../db'
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { decryptSecret } from '../connectors/credentials'
import { decryptContent } from './content'

export type ThreadMessage = { id: string; status: string; status_reason: string | null; task_key: string; to_addresses: string[]; created_at: string; accepted_at: string | null; reply_count: number; subject: string | null; body: string | null }
export type InboundItem = { id: string; from_address: string; classification: string; status: string; status_reason: string | null; received_at: string; thread_message_id: string | null; subject: string | null; text: string | null }

const MAX_SHOWN = 4000
const shown = (t: string) => (t.length > MAX_SHOWN ? `${t.slice(0, MAX_SHOWN)}\n… (shortened here; the full message is ${t.length} characters)` : t)

export async function agentMailThreads(actor: Actor, agentId: string): Promise<{ mailbox: { address: string } | null; threads: (ThreadMessage & { replies: InboundItem[] })[]; other: InboundItem[] }> {
  const rows = await withActor(actor, async db => {
    const agent = await db.one<{ id: string }>('select id from agents where id = $1', [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const mailbox = await db.one<{ id: string; address: string }>(`select id, address from email_accounts where agent_id = $1 and provider = 'deploi' and status <> 'disconnected'`, [agentId])
    const msgs = mailbox ? await db.query<Omit<ThreadMessage, 'subject' | 'body'>>(
      `select id, status, status_reason, task_key, to_addresses, created_at, accepted_at, reply_count from email_messages where account_id = $1 order by created_at desc limit 50`, [mailbox.id]) : []
    const inbound = mailbox ? await db.query<Omit<InboundItem, 'subject' | 'text'>>(
      `select id, from_address, classification, status, status_reason, received_at, thread_message_id from email_inbound where account_id = $1 order by received_at asc limit 200`, [mailbox.id]) : []
    return { mailbox, msgs, inbound }
  })
  const staff = actor.kind === 'staff'
  // content: decrypted server-side after the RLS read above proved the caller may see these rows
  const msgContent = new Map<string, { subject: string; body: string }>()
  const inContent = new Map<string, { subject: string; text: string }>()
  if (!staff && rows.msgs.length) {
    const enc = await admin(db => db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_messages where id = any($1::uuid[])', [rows.msgs.map(m => m.id)]))
    for (const e of enc) { try { const c = decryptContent(e.id, e.key_id, e.content_ciphertext); msgContent.set(e.id, { subject: c.subject, body: shown(c.bodyText) }) } catch { /* shown as unavailable */ } }
  }
  if (!staff && rows.inbound.length) {
    const enc = await admin(db => db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_inbound where id = any($1::uuid[])', [rows.inbound.map(i => i.id)]))
    for (const e of enc) { try { const c = JSON.parse(decryptSecret(e.key_id, e.content_ciphertext, `email-inbound:${e.id}`)) as { subject: string; text: string }; inContent.set(e.id, { subject: c.subject, text: shown(c.text) }) } catch { /* shown as unavailable */ } }
  }
  const inbound: InboundItem[] = rows.inbound.map(i => ({ ...i, subject: inContent.get(i.id)?.subject ?? null, text: inContent.get(i.id)?.text ?? null }))
  const threads = rows.msgs.map(m => ({ ...m, subject: msgContent.get(m.id)?.subject ?? null, body: msgContent.get(m.id)?.body ?? null, replies: inbound.filter(i => i.thread_message_id === m.id) }))
  const other = inbound.filter(i => !i.thread_message_id || !rows.msgs.some(m => m.id === i.thread_message_id)).reverse()
  return { mailbox: rows.mailbox ? { address: rows.mailbox.address } : null, threads, other }
}
