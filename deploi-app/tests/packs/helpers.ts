/** Test helpers for the agent packs: a clean organization with a business type, synthetic ports, captured owner and crew updates. */
import { admin } from '../../lib/db'
import { handlersFor, type AgentEvent } from '../../lib/events'
import { setNotifyImpl, type OwnerUpdate } from '../../lib/notify'
import { NW, HB, merchantActor, clearFirstDay } from '../merchant/helpers'
import { getSynth, mutateSynth, resetSynth } from '../../lib/packs/synthetic'
import { chooseBusinessType } from '../../lib/packs/settings'
import type { BusinessType } from '../../lib/packs/registry'
import '../../lib/packs'

export { NW, HB, merchantActor, getSynth, mutateSynth }
export const owner: OwnerUpdate[] = []
// owner updates are captured; crew messages go through the real crew pipeline (lib/notify/crew.ts: crew_jobs,
// crew_messages, the held system email), so a pack can only reach someone on the one crew roster (crew_members)
setNotifyImpl({
  owner: async u => { if (!owner.some(x => x.dedupeKey === u.dedupeKey)) owner.push(u); return { status: 'sent', id: u.dedupeKey } },
})

export const PACK_TABLES = ['pack_activity', 'pack_messages', 'pack_appointments', 'pm_maintenance_requests', 'pm_vendors', 'leasing_payments', 'leasing_placements', 'leasing_invoices', 'leasing_listings', 'leasing_properties', 'leasing_companies',
  'pack_work_orders', 'pack_crew_members', 'pack_leads', 'pack_settings']

const CREW_TABLES = ['crew_job_links', 'crew_messages', 'crew_jobs', 'crew_members']

/** A crew member on the one roster (crew_members, Settings -> Crew). `email: null` makes one nobody can reach. */
export async function crewMember(m: typeof NW, o: { name?: string; email?: string | null; phone?: string | null; role?: string } = {}) {
  return (await admin(db => db.one<{ id: string }>(`insert into crew_members (org_id, name, role, email, phone, channels) values ($1,$2,$3,$4,$5,array['email']::text[]) returning id`,
    [m.org, o.name ?? 'Sam Ortiz', o.role ?? 'field', o.email === undefined ? 'sam@crew.example' : o.email, o.phone === undefined ? '+15550100' : o.phone])))!
}
/** What the real crew pipeline sent (one row per message and channel), oldest first. */
export const crewSent = (m: typeof NW) => admin(db => db.query<{ crew_member_id: string; dedupe_key: string; job_refs: string[]; status: string; status_reason: string | null; body: string }>(
  `select crew_member_id, dedupe_key, job_refs, status, status_reason, body from crew_messages where org_id = $1 and direction = 'out' order by created_at, id`, [m.org]))
/** The crew job the pipeline recorded for a job reference. */
export const crewJob = (m: typeof NW, ref: string) => admin(db => db.one<{ crew_member_id: string; address: string | null; details: string | null; status: string }>(
  `select crew_member_id, address, details, status from crew_jobs where org_id = $1 and job_ref = $2`, [m.org, ref]))

export async function resetPacks(m: typeof NW, businessType: BusinessType | null, opts: { trade?: string; settings?: Record<string, unknown> } = {}) {
  await admin(async db => { for (const t of [...PACK_TABLES, ...CREW_TABLES]) await db.query(`delete from ${t} where org_id = $1`, [m.org]) })
  await resetSynth(m.org)
  await clearFirstDay(m.org)
  owner.length = 0
  if (businessType) await chooseBusinessType(await merchantActor(m), { businessType, trade: opts.trade ?? null })
  if (opts.settings) await admin(db => db.query(`update pack_settings set settings = settings || $2::jsonb where org_id = $1`, [m.org, JSON.stringify(opts.settings)]))
  await admin(db => db.query(`update agencies set timezone = 'UTC' where id = $1`, [m.org]))
}

let seq = 0
/** Deliver an event to every registered handler (the router's job; W1 adds dedupe and retries around it). */
export async function fire(m: typeof NW, type: string, payload: Record<string, unknown>, at: Date, externalId?: string) {
  const e: AgentEvent = { source: type.split('.')[0] as AgentEvent['source'], type, orgId: m.org, externalId: externalId ?? `ev-${Date.now()}-${++seq}`, occurredAt: at.toISOString(), payload }
  for (const h of handlersFor(type)) await admin(db => h.fn(db, e))
  return e
}
export const sweep = (m: typeof NW, at: Date) => fire(m, 'sweep', {}, at, `sweep-${at.toISOString()}`)

/** A Monday 08:00 UTC well in the future relative to seeded data, so slots are deterministic. */
export function monday(weeksAhead = 1): Date {
  const d = new Date(); d.setUTCHours(8, 0, 0, 0)
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back + 7 * weeksAhead)
  return d
}
export const plus = (d: Date, h: number) => new Date(d.getTime() + h * 3600e3)

export const sentMail = async (m: typeof NW) => (await getSynth(m.org, 'mail')).sent
export const rows = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => admin(db => db.query<T>(sql, params))
export const one = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => admin(db => db.one<T>(sql, params))
export const activity = (m: typeof NW, agentKey?: string) => rows<{ agent_key: string; problem_key: string; status: string; title: string; error: string | null; proof: { label: string; value: string }[] }>(
  `select agent_key, problem_key, status, title, error, proof from pack_activity where org_id = $1 ${agentKey ? 'and agent_key = $2' : ''} order by created_at`, agentKey ? [m.org, agentKey] : [m.org])

export function leadEmail(o: { id: string; from?: string; name?: string; email?: string; text?: string; subject?: string; fields?: Record<string, string> }) {
  const lines = [o.name ? `Name: ${o.name}` : '', o.email ? `Email: ${o.email}` : '', ...Object.entries(o.fields ?? {}).map(([k, v]) => `${k}: ${v}`), '', o.text ?? ''].filter((l, i) => l || i > 0)
  return { from: o.from ?? 'leads@zillow.com', subject: o.subject ?? 'New rental lead', text: lines.join('\n'), messageId: o.id }
}
