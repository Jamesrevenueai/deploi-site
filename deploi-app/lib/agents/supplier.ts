/**
 * Supplier Chaser workflow:
 *  1. low stock (the agent's threshold) -> each SKU's supplier from the merchant's supplier mapping file
 *     (or the policy's default supplier) -> one consolidated request per supplier per day, drafted from the
 *     agent's mailbox. Recipients come only from the mapping or the policy, and must satisfy the policy's
 *     recipient rules; an address outside them is never written to.
 *  2. the email engine decides each message by the agent's tier (draft / approve each / within limits) and sends it.
 *  3. supplier_requests mirrors each request: sent, followed up once (email/run.ts) after N days without a reply,
 *     replied (the follow-up is cancelled if it has not gone out). A date found in the reply is kept as an ETA
 *     for the merchant to read: data only, never an instruction, never acted on.
 * Idempotent: the per-supplier-per-day dedupe key, the per-variant cooldown and the unique request row
 * mean a second run on the same day creates nothing new.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { decryptSecret } from '../connectors/credentials'
import type { ResourceRecord } from '../engine/types'
import { inScope, recipientAllowed, type AgentPolicy } from './policy'
import { loadReference, type SupplierRow } from './references'
import { reorderCandidates, requestDay, supplierReorder, type DraftMessage, type ReorderItem } from '../email/tasks'

export type SupplierSkip = { variantId: string; sku: string | null; reason: string }
export type SupplierCounts = { requests: number; awaitingYou: number; sent: number; followedUp: number; replied: number; skipped: number }

/** Build today's consolidated supplier requests for one agent run. */
export async function supplierDrafts(input: { agentId: string; runId: string; agentName: string; storeName: string; policy: AgentPolicy; records: ResourceRecord[]; now: Date }): Promise<{ drafts: DraftMessage[]; skipped: SupplierSkip[] }> {
  const e = input.policy.email
  const sr = e?.supplierReorder
  if (!e || !sr || !e.tasks.includes('supplier_reorder')) return { drafts: [], skipped: [] }
  // replies first: a supplier who answered is never chased, and a pending follow-up to them is withdrawn
  await syncSupplierRequests(input.agentId)
  return admin(async db => {
    const agent = await db.one<{ org_id: string; connection_id: string }>('select org_id, connection_id from agents where id = $1', [input.agentId])
    if (!agent) return { drafts: [], skipped: [] }
    const recent = await db.query<{ v: string }>(
      `select jsonb_array_elements_text(meta->'variant_ids') as v from email_messages where agent_id = $1 and task_key = 'supplier_reorder'
       and status not in ('cancelled','failed') and created_at > $2`, [input.agentId, new Date(input.now.getTime() - sr.cooldownDays * 864e5).toISOString()])
    const cooling = new Set(recent.map(r => r.v))
    const candidates = reorderCandidates(input.records, sr.thresholdAvailable, r => inScope(input.policy, String(r.productId ?? ''), Array.isArray(r.productTags) ? (r.productTags as string[]) : []))
      .filter(i => !cooling.has(i.variantId))
    if (!candidates.length) return { drafts: [], skipped: [] }

    const skipped: SupplierSkip[] = []
    let mapping: Map<string, SupplierRow[]> | null = null
    if (sr.mappingSourceId) {
      // the file must belong to this agent's own store: a policy can never point at another organization's file
      const owned = await db.one<{ id: string }>(`select id from reference_sources where id = $1 and org_id = $2 and connection_id = $3 and kind = 'supplier_mapping' and status = 'active'`,
        [sr.mappingSourceId, agent.org_id, agent.connection_id])
      const ref = owned ? await loadReference(db, owned.id) : null
      if (!ref) return { drafts: [], skipped: candidates.map(c => ({ variantId: c.variantId, sku: c.sku, reason: 'the supplier mapping file is missing or archived; nothing was drafted' })) }
      mapping = new Map([...ref.byKey].map(([k, rows]) => [k, rows.map(r => r.row as SupplierRow)]))
    }

    const groups = new Map<string, { name: string | null; items: ReorderItem[] }>()
    for (const c of candidates) {
      let address: string | null = null, name: string | null = null
      let item: ReorderItem = c
      if (mapping) {
        const rows = c.sku ? mapping.get(`sku:${c.sku.toLowerCase()}`) ?? [] : []
        if (rows.length > 1 || rows.some(r => r.ambiguous)) { skipped.push({ variantId: c.variantId, sku: c.sku, reason: 'the SKU is listed more than once in the supplier mapping; Deploi does not pick one' }); continue }
        if (rows.length === 1) {
          address = rows[0].supplierEmail; name = rows[0].supplierName
          item = { ...c, reorderQty: rows[0].reorderQty, leadTimeDays: rows[0].leadTimeDays }
        } else if ((sr.unmapped ?? 'default_supplier') === 'skip') { skipped.push({ variantId: c.variantId, sku: c.sku, reason: 'the SKU is not in the supplier mapping' }); continue }
      }
      address = (address ?? sr.supplierAddress).toLowerCase()
      if (!recipientAllowed(e, address)) { skipped.push({ variantId: c.variantId, sku: c.sku, reason: `${address} is outside this agent's recipient rules; widen the agent to include it` }); continue }
      const g = groups.get(address) ?? { name, items: [] }
      g.items.push(item)
      groups.set(address, g)
    }
    const drafts: DraftMessage[] = []
    for (const [address, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const d = supplierReorder(e, { runId: input.runId, agentName: input.agentName, storeName: input.storeName, at: input.now, items: g.items, supplier: { address, name: g.name } })
      if (d) drafts.push(d)
    }
    return { drafts, skipped }
  })
}

// ------------------------------------------------------------------ ETA (data only)

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const iso = (d: Date) => d.toISOString().slice(0, 10)

/** The supplier's own words: quoted history (our request, with its own dates) is cut off. */
export function unquoted(text: string): string {
  const out: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) continue
    if (/^\s*On .{3,200}wrote:\s*$/i.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^\s*From:\s.+@/i.test(line)) break
    out.push(line)
  }
  return out.join('\n')
}

/**
 * A delivery date mentioned in a supplier's reply, if one is clearly stated: an ISO date, "Month day",
 * "day Month", or "in/within N days|weeks". Only dates from the day before the reply to a year after it
 * are accepted. The result is shown to the merchant as "mentioned in the reply"; it changes nothing.
 */
export function extractEta(text: string, receivedAt: Date): { date: string; text: string } | null {
  const body = unquoted(text).slice(0, 20_000)
  const lo = receivedAt.getTime() - 864e5, hi = receivedAt.getTime() + 366 * 864e5
  const ok = (d: Date) => !Number.isNaN(d.getTime()) && d.getTime() >= lo && d.getTime() <= hi
  const found: { at: number; date: Date; phrase: string }[] = []
  for (const m of body.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    if (d.getUTCMonth() === Number(m[2]) - 1 && ok(d)) found.push({ at: m.index ?? 0, date: d, phrase: m[0] })
  }
  const monthDay = (mon: string, day: string, year?: string) => {
    const mi = MONTHS.indexOf(mon.slice(0, 3).toLowerCase())
    if (mi < 0) return null
    const y = year ? Number(year) : receivedAt.getUTCFullYear()
    let d = new Date(Date.UTC(y, mi, Number(day)))
    if (d.getUTCDate() !== Number(day)) return null
    if (!year && d.getTime() < lo) d = new Date(Date.UTC(y + 1, mi, Number(day)))
    return d
  }
  const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
  for (const m of body.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`, 'gi'))) {
    const d = monthDay(m[1], m[2], m[3]); if (d && ok(d)) found.push({ at: m.index ?? 0, date: d, phrase: m[0] })
  }
  for (const m of body.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b(?:,?\\s+(20\\d\\d))?`, 'gi'))) {
    const d = monthDay(m[2], m[1], m[3]); if (d && ok(d)) found.push({ at: m.index ?? 0, date: d, phrase: m[0] })
  }
  for (const m of body.matchAll(/\b(?:in|within)\s+(\d{1,3})\s+(business\s+|working\s+)?(days?|weeks?)\b/gi)) {
    const n = Number(m[1])
    const days = /week/i.test(m[3]) ? n * 7 : m[2] ? Math.ceil((n * 7) / 5) : n
    const d = new Date(Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate() + days))
    if (ok(d)) found.push({ at: m.index ?? 0, date: d, phrase: m[0] })
  }
  if (!found.length) return null
  const first = found.sort((a, b) => a.at - b.at)[0]
  return { date: iso(first.date), text: first.phrase.replace(/\s+/g, ' ').slice(0, 80) }
}

// ------------------------------------------------------------------ request status

type MsgRow = { id: string; status: string; status_reason: string | null; to_addresses: string[]; dedupe_key: string; meta: Record<string, unknown>; created_at: string; accepted_at: string | null; reply_count: number; reply_seen_at: string | null }
type FollowRow = { id: string; status: string; accepted_at: string | null; reply_count: number; reply_seen_at: string | null; follows: string | null }

const PENDING = ['draft', 'awaiting_approval', 'queued']

function requestStatus(m: MsgRow, f: FollowRow | undefined, replies: number): { status: string; reason: string | null } {
  if (replies > 0) return { status: 'replied', reason: null }
  if (f?.status === 'accepted') return { status: 'followed_up', reason: null }
  switch (m.status) {
    case 'draft': return { status: 'drafted', reason: m.status_reason }
    case 'awaiting_approval': return { status: 'awaiting_approval', reason: m.status_reason }
    case 'queued': case 'sending': return { status: 'sending', reason: m.status_reason }
    case 'accepted': return { status: 'sent', reason: null }
    case 'delivery_unknown': return { status: 'unknown', reason: m.status_reason }
    default: return { status: 'not_sent', reason: m.status_reason }
  }
}

/**
 * Bring supplier_requests up to date with the agent's messages, follow-ups and replies. Safe to call any
 * time; it never sends anything. A follow-up that has not gone out is withdrawn once the supplier replied.
 */
export async function syncSupplierRequests(agentId: string): Promise<SupplierCounts> {
  return admin(async db => {
    const agent = await db.one<{ org_id: string; connection_id: string }>('select org_id, connection_id from agents where id = $1', [agentId])
    const counts: SupplierCounts = { requests: 0, awaitingYou: 0, sent: 0, followedUp: 0, replied: 0, skipped: 0 }
    if (!agent) return counts
    const msgs = await db.query<MsgRow>(`select id, status, status_reason, to_addresses, dedupe_key, meta, created_at, accepted_at, reply_count, reply_seen_at from email_messages
      where agent_id = $1 and task_key = 'supplier_reorder' and created_at > now() - interval '60 days' order by created_at`, [agentId])
    if (!msgs.length) return counts
    const follows = await db.query<FollowRow>(`select id, status, accepted_at, reply_count, reply_seen_at, meta->>'follows_message_id' as follows from email_messages
      where agent_id = $1 and task_key = 'supplier_followup' and meta->>'follows_message_id' = any($2::text[])`, [agentId, msgs.map(m => m.id)])
    const ids = [...msgs.map(m => m.id), ...follows.map(f => f.id)]
    const inbound = await db.query<{ id: string; thread_message_id: string; received_at: string; key_id: string; content_ciphertext: string }>(
      `select id, thread_message_id, received_at, key_id, content_ciphertext from email_inbound where agent_id = $1 and status = 'accepted' and classification = 'reply'
       and thread_message_id = any($2::uuid[]) and key_id <> 'pending' order by received_at desc`, [agentId, ids])
    for (const m of msgs) {
      const f = follows.find(x => x.follows === m.id)
      const threadIds = [m.id, ...(f ? [f.id] : [])]
      const mine = inbound.filter(i => threadIds.includes(i.thread_message_id))
      const replies = Math.max(m.reply_count + (f?.reply_count ?? 0), mine.length)
      const repliedAt = [m.reply_seen_at, f?.reply_seen_at, ...mine.map(i => i.received_at)].filter((x): x is string => Boolean(x)).sort().pop() ?? null
      let eta: { date: string; text: string } | null = null
      for (const i of mine) {
        try {
          const c = JSON.parse(decryptSecret(i.key_id, i.content_ciphertext, `email-inbound:${i.id}`)) as { text?: string }
          eta = extractEta(String(c.text ?? ''), new Date(i.received_at))
          if (eta) break
        } catch { /* unreadable content: no ETA */ }
      }
      if (replies > 0 && f && PENDING.includes(f.status)) {
        const cancelled = await db.query(`update email_messages set status = 'cancelled', status_reason = 'the supplier replied; the follow-up is not needed', next_attempt_at = null where id = $1 and status = any($2::text[]) returning id`, [f.id, PENDING])
        if (cancelled.length) {
          f.status = 'cancelled'
          await audit(db, { orgId: agent.org_id, entityType: 'execution', entityId: f.id, event: 'email.cancelled', actor: 'system:supplier-chaser', detail: { email_message: true, agent_id: agentId, reason: 'supplier replied' } })
        }
      }
      const st = requestStatus(m, f, replies)
      const supplier = String(m.meta.supplier ?? m.to_addresses[0] ?? '').toLowerCase()
      const day = typeof m.meta.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.meta.day) ? m.meta.day : requestDay(new Date(m.created_at))
      const items = Array.isArray(m.meta.items) ? m.meta.items : (Array.isArray(m.meta.variant_ids) ? m.meta.variant_ids : []).map(v => ({ variantId: v }))
      const vals = [m.id, st.status, st.reason, m.accepted_at, f?.status === 'accepted' ? f.accepted_at : null, repliedAt, replies, eta?.date ?? null, eta?.text ?? null, f?.id ?? null, JSON.stringify(items)]
      const prev = await db.one<{ eta_date: string | null }>('select eta_date from supplier_requests where message_id = $1', [m.id])
      if (eta && !prev?.eta_date) await audit(db, { orgId: agent.org_id, connectionId: agent.connection_id, entityType: 'agent', entityId: agentId, event: 'supplier.eta_noted', actor: 'system:supplier-chaser', detail: { message_id: m.id, eta: eta.date } })
      const upd = await db.query(`update supplier_requests set status = $2, status_reason = $3, sent_at = $4, followed_up_at = $5, replied_at = $6, reply_count = $7,
          eta_date = coalesce($8::date, eta_date), eta_text = coalesce($9, eta_text), followup_message_id = $10, items = $11 where message_id = $1 returning id`, vals)
      if (!upd.length) {
        await db.query(`insert into supplier_requests (message_id, status, status_reason, sent_at, followed_up_at, replied_at, reply_count, eta_date, eta_text, followup_message_id, items,
            org_id, agent_id, connection_id, supplier_address, request_day) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict do nothing`,
          [...vals, agent.org_id, agentId, agent.connection_id, supplier, day])
      }
      counts.requests++
      if (st.status === 'drafted' || st.status === 'awaiting_approval') counts.awaitingYou++
      if (['sent', 'followed_up', 'replied'].includes(st.status)) counts.sent++
      if (st.status === 'followed_up' || (st.status === 'replied' && f?.status === 'accepted')) counts.followedUp++
      if (st.status === 'replied') counts.replied++
    }
    return counts
  })
}

export const SUPPLIER_STATUS_LABEL: Record<string, string> = {
  drafted: 'Drafted: read it and send it yourself, or let the agent send',
  awaiting_approval: 'Waiting for your approval',
  sending: 'Being sent',
  sent: 'Sent: waiting for the supplier to reply',
  followed_up: 'Followed up once: waiting for the supplier to reply',
  replied: 'Supplier replied',
  not_sent: 'Not sent',
  unknown: 'Delivery unknown: check the mailbox Sent folder',
}

export type SupplierRequestView = { id: string; supplier: string; day: string; status: string; label: string; reason: string | null; items: unknown[]; sentAt: string | null; followedUpAt: string | null; repliedAt: string | null; eta: { date: string; text: string | null; note: string } | null }

/** The merchant-facing list of an agent's supplier requests (RLS: own organization only). */
export async function listSupplierRequests(actor: Actor, agentId: string): Promise<SupplierRequestView[]> {
  const rows = await withActor(actor, async (db: Db) => {
    const a = await db.one<{ id: string }>('select id from agents where id = $1', [agentId])
    if (!a) throw new EngineError('not_found', 'agent not found')
    return db.query<{ id: string; supplier_address: string; request_day: string; status: string; status_reason: string | null; items: unknown[]; sent_at: string | null; followed_up_at: string | null; replied_at: string | null; eta_date: string | null; eta_text: string | null }>(
      `select id, supplier_address, to_char(request_day, 'YYYY-MM-DD') as request_day, status, status_reason, items, sent_at, followed_up_at, replied_at, to_char(eta_date, 'YYYY-MM-DD') as eta_date, eta_text
       from supplier_requests where agent_id = $1 order by request_day desc, supplier_address limit 100`, [agentId])
  })
  return rows.map(r => ({
    id: r.id, supplier: r.supplier_address, day: r.request_day, status: r.status, reason: r.status_reason, items: r.items, sentAt: r.sent_at, followedUpAt: r.followed_up_at, repliedAt: r.replied_at,
    label: `${SUPPLIER_STATUS_LABEL[r.status] ?? r.status}${r.status === 'replied' && r.eta_date ? `; a date is mentioned: ${r.eta_date}` : ''}`,
    eta: r.eta_date ? { date: r.eta_date, text: r.eta_text, note: 'read from the supplier\'s reply; not confirmed, and the agent does nothing with it' } : null,
  }))
}
