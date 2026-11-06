import { NW, HB, resetLibrary } from '../library/helpers'
import { admin } from '../../lib/db'
import { setSyntheticState, getSyntheticState, commerceQuietState, seedCommerceScenario, injectFault, type CommerceScenario, type SynthCommerce } from '../../lib/connectors/shopify/synthetic'
import { setNotifyImpl, type OwnerUpdate, type CrewMessage } from '../../lib/notify'
import { handlersFor, type AgentEvent } from '../../lib/events'
import '../../lib/commerce/pack'

export { NW, HB, injectFault }

export const owner: OwnerUpdate[] = []
export const crew: CrewMessage[] = []
setNotifyImpl({
  owner: async u => { owner.push(u); return { status: 'sent', id: `owner-${owner.length}` } },
  crew: async m => { crew.push(m); return { status: 'sent', id: `crew-${crew.length}` } },
})

/** A quiet synthetic commerce store for the merchant with the given scenarios seeded; work log and captured updates cleared. */
export async function resetCommerce(m: typeof NW, scenarios: CommerceScenario[] = [], now = new Date()) {
  await resetLibrary(m)
  // the shared loop's state (lib/events/loop) for this store: a loop another test left open would answer for this one
  await admin(db => db.query(`delete from agent_loops where org_id = $1`, [m.org]))
  await admin(db => db.query(`update store_connections set status = 'active', status_reason = null where id = $1`, [m.conn]))
  const s = commerceQuietState(now)
  for (const sc of scenarios) seedCommerceScenario(s, sc, now)
  await setSyntheticState(m.conn, s)
  owner.length = 0
  crew.length = 0
}

export const commerce = async (m: typeof NW) => (await getSyntheticState(m.conn))!.commerce as SynthCommerce
export const productOf = async (m: typeof NW, id: string) => (await getSyntheticState(m.conn))!.products.find(p => p.id === id)!

let n = 0
export function event(m: typeof NW, type: string, payload: Record<string, unknown> = {}, source: AgentEvent['source'] = type === 'sweep' ? 'sweep' : type.startsWith('mail') ? 'mailbox' : 'shopify'): AgentEvent {
  return { source, type, orgId: m.org, externalId: `${type}:${++n}`, occurredAt: new Date().toISOString(), payload }
}
/** Hand an event to every registered handler, as the router does after its own dedupe. */
export async function deliver(e: AgentEvent) {
  for (const h of handlersFor(e.type)) await h.fn(null as never, e)
  return e
}

export type WorkRow = { id: string; agent_key: string; action_type: string; status: string; mode: string; title: string; summary: string; status_reason: string | null; evidence: Record<string, unknown>; payload: Record<string, unknown>; proof: { items: { label: string; value: string }[]; verified: boolean } | null }
export const work = (m: typeof NW, kind?: string) => admin(db => db.query<WorkRow>(`select id, agent_key, action_type, status, mode, title, summary, status_reason, evidence, payload, proof from library_actions where org_id = $1 ${kind ? 'and action_type = $2' : ''} order by created_at`, kind ? [m.org, kind] : [m.org]))

/** Detection latency per scenario, printed at the end of the run. */
export const latencies: Record<string, number> = {}
export function recordLatency(name: string, rows: WorkRow[]) {
  const l = rows.map(r => Number(r.evidence.latencyMs)).filter(Number.isFinite)
  if (l.length) latencies[name] = Math.max(...l)
  return l
}
