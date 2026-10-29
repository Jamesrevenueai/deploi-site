/**
 * Turn a competitor finding into a sourcing-request draft for one of the merchant's Supplier Chaser agents.
 *
 * What this does NOT do: it grants nothing, sends nothing and changes nothing. The message is created
 * under the Supplier Chaser's own email permission and never queued automatically: a drafts-only Supplier
 * Chaser gets a draft; one that may send after approval gets a message waiting for the merchant's approval
 * of that exact text. The finding's evidence (stores, products, links, observation times) travels with the
 * message and both agents' work logs record the link.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { parsePolicy } from '../agents/policy'
import { createAgentMessages } from '../email/engine'
import type { DraftMessage } from '../email/tasks'
import type { InsightProduct } from './insights'

const clean = (s: unknown, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

type InsightRow = { id: string; org_id: string; agent_id: string; kind: string; headline: string; basis: string; products: InsightProduct[]; sources: { url: string; observedAt: string }[]; period_start: string; period_end: string; limitations: string[]; status: string; handoff: Record<string, unknown> | null }

export function sourcingRequest(f: { insight: InsightRow; storeName: string; supplierAddress: string; note: string | null; supplierAgentId: string }): DraftMessage {
  const items = f.insight.products.slice(0, 12)
  const lines = [
    'Hello,', '',
    `${clean(f.storeName, 120)} is looking into adding products like the ones below and would like to know whether you can supply something similar.`,
    ...(f.note ? ['', clean(f.note, 1000)] : []), '',
    'Reference products (as listed publicly by other stores):',
    ...items.map(p => `- ${clean(p.title, 120)}${p.url ? ` — ${p.url}` : ''} (seen ${String(p.observedAt).slice(0, 10)})`),
    '', 'Could you tell us whether you can supply comparable items, with indicative prices, minimum order quantities and lead times? This is an enquiry, not an order.',
    '', 'Thank you,', clean(f.storeName, 120),
  ]
  return {
    taskKey: 'sourcing_request', dedupeKey: `sourcing_request:${f.insight.id}`, to: [f.supplierAddress], cc: [],
    meta: { insight_id: f.insight.id, competitor_agent_id: f.insight.agent_id, basis: f.insight.basis, evidence: { headline: f.insight.headline, sources: f.insight.sources.slice(0, 12), period: [f.insight.period_start, f.insight.period_end], products: items, limitations: f.insight.limitations } },
    content: { subject: clean(`Sourcing enquiry from ${f.storeName}`, 180), bodyText: lines.join('\n'), attachments: [] },
  }
}

export async function handOffInsight(actor: Actor, insightId: string, input: { supplierAgentId: string; note?: string | null }) {
  const insight = await withActor(actor, db => db.one<InsightRow>('select * from competitor_insights where id = $1', [insightId]))
  if (!insight) throw new EngineError('not_found', 'finding not found')
  assertMerchant(actor, insight.org_id)
  const supplier = await withActor(actor, db => db.one<{ id: string; org_id: string; name: string; status: string; connection_id: string; policy: unknown }>(
    `select a.id, a.org_id, a.name, a.status, a.connection_id, p.policy from agents a join agent_policies p on p.id = a.active_policy_id where a.id = $1 and p.status = 'active'`, [input.supplierAgentId]))
  if (!supplier) throw new EngineError('not_found', 'that Supplier Chaser has no active authorization')
  assertMerchant(actor, supplier.org_id)
  if (supplier.status !== 'active') throw new EngineError('agent_inactive', `the Supplier Chaser is ${supplier.status}`)
  if (insight.basis === 'unavailable' || !insight.products.length) throw new EngineError('invalid_input', 'this finding has no products to ask a supplier about')
  const policy = parsePolicy(supplier.policy)
  const address = policy.email?.supplierReorder?.supplierAddress
  if (!policy.email || !address) throw new EngineError('invalid_input', 'that agent is not a Supplier Chaser with a supplier address')

  // an earlier handoff of the same finding to the same agent returns that message instead of a second one
  const existing = await admin(db => db.one<{ id: string; status: string }>(`select id, status from email_messages where agent_id = $1 and dedupe_key = $2`, [supplier.id, `sourcing_request:${insight.id}`]))
  if (existing) return { messageId: existing.id, status: existing.status, duplicate: true }

  const store = await admin(db => db.one<{ name: string }>('select coalesce(display_name, external_id) as name from store_connections where id = $1', [supplier.connection_id]))
  const draft = sourcingRequest({ insight, storeName: store?.name ?? 'Our store', supplierAddress: address, note: input.note ?? null, supplierAgentId: supplier.id })
  const r = await createAgentMessages({ agentId: supplier.id, runId: null, drafts: [draft], actor: actor.label, neverAutoSend: true })
  const made = r.created[0]
  if (!made) throw new EngineError('invalid_input', 'the sourcing request could not be created')
  await admin(async db => {
    const handoff = { supplier_agent_id: supplier.id, supplier_agent: supplier.name, message_id: made.id, message_status: made.status, at: new Date().toISOString(), by: actor.label }
    await db.query(`update competitor_insights set status = 'handed_off', handoff = $2 where id = $1`, [insight.id, JSON.stringify(handoff)])
    await audit(db, { orgId: insight.org_id, entityType: 'agent', entityId: insight.agent_id, event: 'competitor.handed_off', actor: actor.label, detail: { insight_id: insight.id, to_agent_id: supplier.id, message_id: made.id, message_status: made.status } })
    await audit(db, { orgId: insight.org_id, entityType: 'agent', entityId: supplier.id, event: 'email.handoff_received', actor: actor.label, detail: { agent_id: supplier.id, from_agent_id: insight.agent_id, insight_id: insight.id, message_id: made.id, message_status: made.status } })
  })
  return { messageId: made.id, status: made.status, duplicate: false }
}

export async function dismissInsight(actor: Actor, insightId: string) {
  const insight = await withActor(actor, db => db.one<{ id: string; org_id: string; agent_id: string }>('select id, org_id, agent_id from competitor_insights where id = $1', [insightId]))
  if (!insight) throw new EngineError('not_found', 'finding not found')
  assertMerchant(actor, insight.org_id)
  await admin(async db => {
    await db.query(`update competitor_insights set status = 'dismissed' where id = $1 and status = 'new'`, [insightId])
    await audit(db, { orgId: insight.org_id, entityType: 'agent', entityId: insight.agent_id, event: 'competitor.dismissed', actor: actor.label, detail: { insight_id: insightId } })
  })
}
