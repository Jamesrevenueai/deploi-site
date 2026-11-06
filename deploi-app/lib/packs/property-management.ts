/**
 * Property management pack (leasing inquiries are the leasing pack's agents, which a property manager also gets).
 *   pm_maintenance_intake  logs a maintenance request from tenant email or the property system (Buildium) and tells the tenant
 *   pm_vendor_dispatch     sends it to the first available vendor for the trade; a decline or no answer goes to the next one
 *   pm_tenant_update       keeps the tenant posted (visit booked, fixed?) and confirms the fix with them
 *   pm_rent_reminder       reminds tenants whose rent is late (read from the property system)
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { onEvent, type AgentEvent } from '../events'
import { formatDate, formatMoney } from '../office/receivables'
import { registerPackAgents, type PackAgent } from './registry'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { sendPackMessage, verifySent, policyProof } from './outbound'
import { PortError, portsFor } from './ports'
import { orgPacks, type OrgPacks } from './settings'
import { fixConfirmRequest, maintenanceAck, rentReminder, tenantUpdate, vendorDispatch } from './templates'
import { addressOf, days, eventNow, hours, isoDay, replyText, rowProof, saysNo, saysYes, str } from './kit'

const PACK = 'property_management' as const
const PATH = '/store/packs/property_management'
export const PM_AGENTS: PackAgent[] = [
  { key: 'pm_maintenance_intake', name: 'Maintenance intake', pack: PACK, job: 'Logs every maintenance request from tenant email or Buildium and tells the tenant it is in hand.', triggers: ['mail.received', 'buildium.maintenance.created'], actions: ['send_customer_email', 'update_record'], status: 'synthetic_only', shopifyReady: false },
  { key: 'pm_vendor_dispatch', name: 'Vendor dispatcher', pack: PACK, job: 'Sends each request to the right vendor; if they decline or do not answer, the next one.', triggers: ['mail.received', 'sweep'], actions: ['send_vendor_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'pm_tenant_update', name: 'Tenant updates', pack: PACK, job: 'Tells the tenant when a visit is booked and confirms with them that the fix holds.', triggers: ['mail.received', 'sweep'], actions: ['send_customer_email', 'update_record'], status: 'synthetic_only', shopifyReady: false },
  { key: 'pm_rent_reminder', name: 'Rent reminder', pack: PACK, job: 'Reminds tenants whose rent is late, from the balances in your property system.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
]
registerPackAgents(PM_AGENTS)
const NAME = Object.fromEntries(PM_AGENTS.map(a => [a.key, a.name])) as Record<string, string>

export type Request = {
  id: string; org_id: string; source: string; external_id: string; property: string | null; unit: string | null; tenant_name: string | null; tenant_email: string | null; tenant_phone: string | null
  category: string; description: string; urgency: string; vendor_id: string | null; declined_vendor_ids: string[]; status: string; dispatched_at: string | null; vendor_accepted_at: string | null
  fixed_at: string | null; confirmed_at: string | null; tenant_updates: number; escalated_at: string | null
}
type Vendor = { id: string; name: string; email: string | null; phone: string | null; trades: string[] }

const CATEGORY: [string, RegExp][] = [
  ['plumbing', /\b(leak\w*|drip\w*|toilet|sink|faucet|pipe|drain|clog\w*|water heater|hot water|shower|flood\w*|sewage)\b/],
  ['electrical', /\b(outlet|breaker|electric\w*|power|lights?|sparks?|wiring|switch)\b/],
  ['hvac', /\b(heat\w*|furnace|boiler|a\/?c|air condition\w*|cooling|thermostat|hvac)\b/],
  ['appliance', /\b(fridge|refrigerator|oven|stove|dishwasher|washer|dryer|microwave|appliance)\b/],
  ['pest', /\b(mice|mouse|rats?|roach\w*|bugs?|pests?|ants|bed ?bugs|termites?)\b/],
  ['locks', /\b(lock\w*|key|keys|door won'?t)\b/],
]
const MAINTENANCE = /\b(broken|not working|doesn'?t work|stopped working|repair|fix|maintenance|leak\w*|clog\w*|no (?:heat|hot water|power)|won'?t (?:turn|open|close|flush|drain))\b/
const EMERGENCY = /\b(flood\w*|burst|gas (?:smell|leak)|smell(?:s)? (?:of )?gas|fire|smoke|sparks?|sewage|no heat|carbon monoxide|water (?:pouring|everywhere))\b/
export function classifyMaintenance(text: string): { category: string; emergency: boolean; isMaintenance: boolean } {
  const t = text.toLowerCase()
  return { category: CATEGORY.find(([, re]) => re.test(t))?.[0] ?? 'general', emergency: EMERGENCY.test(t), isMaintenance: MAINTENANCE.test(t) || EMERGENCY.test(t) }
}
const ref = (r: Pick<Request, 'id'>) => `WO-${r.id.slice(0, 8).toUpperCase()}`

// ---------------------------------------------------------------- intake

async function intake(db: Db, e: AgentEvent, org: OrgPacks, r: Omit<Request, 'id' | 'org_id' | 'vendor_id' | 'declined_vendor_ids' | 'status' | 'dispatched_at' | 'vendor_accepted_at' | 'fixed_at' | 'confirmed_at' | 'tenant_updates' | 'escalated_at'>) {
  const prior = await db.one<Request>('select * from pm_maintenance_requests where org_id = $1 and source = $2 and external_id = $3', [e.orgId, r.source, r.external_id])
  if (prior) return { status: 'nothing_to_do' as const }
  const row = (await db.one<Request>(`insert into pm_maintenance_requests (org_id, source, external_id, property, unit, tenant_name, tenant_email, tenant_phone, category, description, urgency) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [e.orgId, r.source, r.external_id, r.property, r.unit, r.tenant_name, r.tenant_email, r.tenant_phone, r.category, r.description.slice(0, 2000), r.urgency]))!
  const now = eventNow(e)
  const ack = await runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'pm_maintenance_intake', agentName: NAME.pm_maintenance_intake, actionType: 'send_customer_email', problemKey: `req:${row.id}:ack`, detailsPath: PATH,
    detect: async () => row,
    describe: () => ({ title: `${row.urgency === 'emergency' ? 'EMERGENCY ' : ''}Maintenance request logged: ${row.category}${row.unit ? `, unit ${row.unit}` : ''}`, whatHappened: `${row.tenant_name ?? 'A tenant'} reported a ${row.category} problem${row.property ? ` at ${row.property}` : ''} (${row.source}).`, whatIDid: ['Logged it, told the tenant it is in hand, and am sending a vendor.'] }),
    act: async (d, p) => {
      if (!row.tenant_email) throw new PackBlocked(`the request${row.unit ? ` for unit ${row.unit}` : ''} has no tenant email; call the tenant${row.tenant_phone ? ` on ${row.tenant_phone}` : ''}`)
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'pm_maintenance_intake', to: row.tenant_email, ...maintenanceAck({ name: row.tenant_name, business: org.config.senderName, category: row.category, emergency: row.urgency === 'emergency' }), dedupeKey: `pm:req:${row.id}:ack`, policy: 'fair_housing', recipientNames: [row.tenant_name] })
      if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the tenant update failed the content check' : `the tenant could not be reached: ${s.error}`)
      await d.query(`update pm_maintenance_requests set tenant_updates = tenant_updates + 1 where id = $1`, [row.id])
      Object.assign(p, { messageId: s.messageId })
      return { proof: [policyProof(s.policy)] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as Request & { messageId: string }).messageId, 'Tenant update'),
  })
  const dispatch = await dispatchVendor(db, e, org, row, now)
  return { ack, dispatch }
}

export async function onBuildiumMaintenance(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const id = str(e.payload.requestId, 120)
  if (!id) return null
  let r
  try { r = await (await portsFor(e.orgId)).propertySystem.getMaintenanceRequest(id) } catch (err) { if (err instanceof PortError) return { status: 'failed' as const, error: err.message }; throw err }
  if (!r) return null
  const c = classifyMaintenance(`${r.category ?? ''} ${r.description}`)
  return intake(db, e, org, { source: 'buildium', external_id: r.id, property: r.property, unit: r.unit, tenant_name: r.tenantName, tenant_email: r.tenantEmail?.toLowerCase() ?? null, tenant_phone: r.tenantPhone, category: c.category, description: r.description, urgency: c.emergency ? 'emergency' : 'normal' })
}

// ---------------------------------------------------------------- vendors

async function pickVendor(db: Db, orgId: string, r: Request): Promise<Vendor | null> {
  return db.one<Vendor>(`select id, name, email, phone, trades from pm_vendors where org_id = $1 and active and email is not null and not (id = any($3::uuid[]))
    order by ($2 = any(trades)) desc, ('general' = any(trades)) desc, name, id limit 1`, [orgId, r.category, r.declined_vendor_ids ?? []]).then(v => (v && (v.trades.includes(r.category) || v.trades.includes('general')) ? v : null))
}

export async function dispatchVendor(db: Db, e: AgentEvent, org: OrgPacks, r: Request, now: Date): Promise<PackOutcome> {
  const tried = (r.declined_vendor_ids ?? []).length
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'pm_vendor_dispatch', agentName: NAME.pm_vendor_dispatch, actionType: 'send_vendor_email', problemKey: `req:${r.id}:dispatch:${tried}`, detailsPath: PATH,
    detect: async d => ({ vendor: await pickVendor(d, e.orgId, r) }),
    describe: p => ({ title: p.vendor ? `${ref(r)} sent to ${p.vendor.name}` : `${ref(r)}: no vendor left to send it to`, whatHappened: `${r.category} request${r.unit ? ` for unit ${r.unit}` : ''}${tried ? ` (${tried} vendor${tried === 1 ? '' : 's'} could not take it)` : ''}.`, whatIDid: [p.vendor ? `Sent the work order to ${p.vendor.name}.` : 'Handed it to you: no other active vendor covers this trade.'] }),
    act: async (d, p) => {
      if (!p.vendor) {
        await d.query(`update pm_maintenance_requests set status = 'escalated', escalated_at = $2, status_reason = 'no vendor available for the trade' where id = $1`, [r.id, now.toISOString()])
        throw new PackBlocked(`no active vendor covers ${r.category}${tried ? ' who has not already declined' : ''}; add one or call your usual contractor`)
      }
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'pm_vendor_dispatch', to: p.vendor.email!, ...vendorDispatch({ vendor: p.vendor.name, business: org.config.senderName, ref: ref(r), property: r.property, unit: r.unit, category: r.category, description: r.description, emergency: r.urgency === 'emergency', tenant: r.tenant_name, tenantPhone: r.tenant_phone }), dedupeKey: `pm:req:${r.id}:dispatch:${p.vendor.id}`, policy: 'general', recipientNames: [p.vendor.name] })
      if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the work order failed the content check' : s.error)
      await d.query(`update pm_maintenance_requests set vendor_id = $2, status = 'dispatched', dispatched_at = $3, vendor_accepted_at = null where id = $1`, [r.id, p.vendor.id, now.toISOString()])
      if (r.source === 'buildium') { try { await (await portsFor(e.orgId)).propertySystem.updateMaintenanceStatus(r.external_id, 'assigned', `Sent to ${p.vendor.name}`) } catch { /* the property system is updated on the next step */ } }
      Object.assign(p, { messageId: s.messageId })
      return { proof: [policyProof(s.policy), rowProof('Vendor', p.vendor.name)] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Work order'),
  })
}

function acceptDate(text: string, today: string): string | null {
  const m = /\b(20\d\d-\d\d-\d\d)\b/.exec(text)
  if (m) return m[1]
  if (/\btomorrow\b/.test(text)) return isoDay(new Date(Date.parse(`${today}T00:00:00Z`) + days(1)))
  if (/\btoday\b/.test(text)) return today
  return null
}

async function onVendorReply(db: Db, e: AgentEvent, org: OrgPacks, vendor: Vendor, text: string) {
  const r = await db.one<Request>(`select * from pm_maintenance_requests where org_id = $1 and vendor_id = $2 and status in ('dispatched','scheduled') order by (status = 'dispatched') desc, dispatched_at desc limit 1`, [e.orgId, vendor.id])
  if (!r) return null
  const now = eventNow(e)
  const verb = /\bdecline[ds]?\b|\bcan'?t take\b|\bcannot take\b|\bnot available\b|\bunavailable\b/.test(text) ? 'decline' : /\bfixed\b|\bdone\b|\bcompleted?\b|\brepaired\b/.test(text) ? 'fixed' : /\baccept(?:ed)?\b|\bi'?ll take\b|\bcan do\b|\bbooked\b|\bscheduled\b/.test(text) ? 'accept' : null
  if (!verb) return null
  if (verb === 'decline') {
    await db.query(`update pm_maintenance_requests set declined_vendor_ids = array_append(declined_vendor_ids, $2::uuid), vendor_id = null, status = 'new' where id = $1`, [r.id, vendor.id])
    const fresh = (await db.one<Request>('select * from pm_maintenance_requests where id = $1', [r.id]))!
    return dispatchVendor(db, e, org, fresh, now)
  }
  const when = verb === 'accept' ? acceptDate(text, isoDay(now)) : null
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'pm_tenant_update', agentName: NAME.pm_tenant_update, actionType: 'send_customer_email', problemKey: `req:${r.id}:${verb}:${vendor.id}`, detailsPath: PATH,
    detect: async () => r,
    describe: () => ({ title: verb === 'accept' ? `${vendor.name} took ${ref(r)}` : `${vendor.name} says ${ref(r)} is fixed`, whatHappened: verb === 'accept' ? `${vendor.name} accepted the work order${when ? ` for ${formatDate(when)}` : ''}.` : `${vendor.name} reported the ${r.category} work done.`,
      whatIDid: [verb === 'accept' ? 'Told the tenant a visit is booked.' : 'Asked the tenant to confirm the fix.'] }),
    act: async (d, p) => {
      if (!r.tenant_email) throw new PackBlocked(`there is no tenant email for ${ref(r)}; call the tenant${r.tenant_phone ? ` on ${r.tenant_phone}` : ''}`)
      const draft = verb === 'accept'
        ? tenantUpdate({ name: r.tenant_name, business: org.config.senderName, line: `${vendor.name} will come to fix the ${r.category} issue${when ? ` on ${formatDate(when)}` : ' shortly; they will contact you with the time'}.` })
        : fixConfirmRequest({ name: r.tenant_name, business: org.config.senderName, category: r.category })
      const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'pm_tenant_update', to: r.tenant_email, ...draft, dedupeKey: `pm:req:${r.id}:${verb}:${vendor.id}`, policy: 'fair_housing', recipientNames: [r.tenant_name, vendor.name] })
      if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the tenant update failed the content check' : `the tenant could not be reached: ${s.error}`)
      await d.query(verb === 'accept' ? `update pm_maintenance_requests set status = 'scheduled', vendor_accepted_at = $2, tenant_updates = tenant_updates + 1 where id = $1`
        : `update pm_maintenance_requests set status = 'fixed', fixed_at = $2, tenant_updates = tenant_updates + 1 where id = $1`, [r.id, now.toISOString()])
      Object.assign(p, { messageId: s.messageId })
      return { proof: [policyProof(s.policy)] }
    },
    verify: async (_d, p) => verifySent(e.orgId, (p as Request & { messageId: string }).messageId, 'Tenant update'),
  })
}

async function onTenantConfirm(db: Db, e: AgentEvent, org: OrgPacks, r: Request, text: string) {
  const yes = saysYes(text), no = saysNo(text)
  if (!yes && !no) return null
  const now = eventNow(e)
  if (no) {
    // not fixed: back to the same vendor
    await db.query(`update pm_maintenance_requests set status = 'new', fixed_at = null, declined_vendor_ids = array_remove(declined_vendor_ids, vendor_id) where id = $1`, [r.id])
    const fresh = (await db.one<Request>('select * from pm_maintenance_requests where id = $1', [r.id]))!
    return runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'pm_vendor_dispatch', agentName: NAME.pm_vendor_dispatch, actionType: 'send_vendor_email', problemKey: `req:${r.id}:revisit:${e.externalId}`, detailsPath: PATH,
      detect: async d => (r.vendor_id ? d.one<Vendor>('select id, name, email, phone, trades from pm_vendors where id = $1', [r.vendor_id]) : null),
      describe: v => ({ title: `${ref(r)} is not fixed: ${v.name} asked back`, whatHappened: `${r.tenant_name ?? 'The tenant'} says the ${r.category} issue is not fixed.`, whatIDid: [`Sent ${v.name} back.`] }),
      act: async (d, v) => {
        if (!v.email) throw new PackBlocked('the vendor has no email address')
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'pm_vendor_dispatch', to: v.email, ...vendorDispatch({ vendor: v.name, business: org.config.senderName, ref: `${ref(r)} (return visit)`, property: r.property, unit: r.unit, category: r.category, description: `The tenant reports it is not fixed. ${r.description}`, emergency: r.urgency === 'emergency', tenant: r.tenant_name, tenantPhone: r.tenant_phone }), dedupeKey: `pm:req:${r.id}:revisit:${e.externalId}`, policy: 'general', recipientNames: [v.name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the work order failed the content check' : s.error)
        await d.query(`update pm_maintenance_requests set status = 'dispatched', vendor_id = $2, dispatched_at = $3 where id = $1`, [fresh.id, v.id, now.toISOString()])
        Object.assign(v, { messageId: s.messageId })
        return { proof: [policyProof(s.policy)] }
      },
      verify: async (_d, v) => verifySent(e.orgId, (v as Vendor & { messageId: string }).messageId, 'Return visit'),
    })
  }
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'pm_tenant_update', agentName: NAME.pm_tenant_update, actionType: 'update_record', problemKey: `req:${r.id}:confirmed`, detailsPath: PATH,
    detect: async () => r,
    describe: () => ({ title: `${ref(r)} fixed and confirmed by the tenant`, whatHappened: `${r.tenant_name ?? 'The tenant'} confirmed the ${r.category} issue is fixed.`, whatIDid: ['Closed the request', ...(r.source === 'buildium' ? ['and marked it completed in your property system.'] : [])] }),
    act: async d => {
      await d.query(`update pm_maintenance_requests set status = 'confirmed', confirmed_at = $2 where id = $1`, [r.id, now.toISOString()])
      if (r.source === 'buildium') await (await portsFor(e.orgId)).propertySystem.updateMaintenanceStatus(r.external_id, 'completed', 'Fixed; confirmed by the tenant')
      return {}
    },
    verify: async d => {
      const row = await d.one<{ status: string }>('select status from pm_maintenance_requests where id = $1', [r.id])
      let sys = 'not tracked there'
      if (r.source === 'buildium') { const x = await (await portsFor(e.orgId)).propertySystem.getMaintenanceRequest(r.external_id); sys = x?.status ?? 'missing' }
      return { ok: row?.status === 'confirmed' && (r.source !== 'buildium' || sys === 'completed'), proof: [rowProof('Request status', row?.status ?? 'missing'), rowProof('Property system', sys)] }
    },
  })
}

export async function onPmMail(db: Db, e: AgentEvent, cfg?: OrgPacks) {
  const org = cfg ?? await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const from = addressOf(e.payload.from)
  if (!from) return null
  const text = replyText(e.payload.subject, e.payload.text)
  const vendor = await db.one<Vendor>('select id, name, email, phone, trades from pm_vendors where org_id = $1 and lower(email) = $2 and active', [e.orgId, from])
  if (vendor) return onVendorReply(db, e, org, vendor, text)
  const awaiting = await db.one<Request>(`select * from pm_maintenance_requests where org_id = $1 and lower(tenant_email) = $2 and status = 'fixed' order by fixed_at desc limit 1`, [e.orgId, from])
  if (awaiting) { const r = await onTenantConfirm(db, e, org, awaiting, text); if (r) return r }
  // a lead of any pack is not a maintenance request
  if (await db.one(`select 1 from pack_leads where org_id = $1 and lower(email) = $2 and status not in ('duplicate') limit 1`, [e.orgId, from])) return null
  const c = classifyMaintenance(text)
  if (!c.isMaintenance) return null
  const unit = /\b(?:unit|apt|apartment|suite|#)\s*([a-z0-9-]{1,10})\b/i.exec(String(e.payload.text ?? ''))?.[1] ?? null
  const external = str(e.payload.messageId, 300) ?? e.externalId
  return intake(db, e, org, { source: 'email', external_id: external, property: null, unit, tenant_name: str(e.payload.fromName, 160), tenant_email: from, tenant_phone: null, category: c.category,
    description: String(e.payload.subject ?? '').slice(0, 200) || `${c.category} problem reported by email`, urgency: c.emergency ? 'emergency' : 'normal' })
}

// ---------------------------------------------------------------- sweeps

export async function sweepVendors(db: Db, e: AgentEvent, org: OrgPacks) {
  const now = eventNow(e)
  const out: PackOutcome[] = []
  // no answer from the vendor: treat as a decline and go to the next one (emergencies wait half as long)
  const quiet = await db.query<Request>(`select * from pm_maintenance_requests where org_id = $1 and status = 'dispatched' and vendor_accepted_at is null and dispatched_at <= $2 order by dispatched_at limit 50`, [e.orgId, new Date(now.getTime() - hours(Math.max(1, Math.floor(org.config.confirmEscalateHours / 2)))).toISOString()])
  for (const r of quiet) {
    if (r.urgency !== 'emergency' && Date.parse(r.dispatched_at!) > now.getTime() - hours(org.config.confirmEscalateHours)) continue
    await db.query(`update pm_maintenance_requests set declined_vendor_ids = array_append(declined_vendor_ids, vendor_id), vendor_id = null, status = 'new' where id = $1 and vendor_id is not null`, [r.id])
    out.push(await dispatchVendor(db, e, org, (await db.one<Request>('select * from pm_maintenance_requests where id = $1', [r.id]))!, now))
  }
  // fixed, but the tenant never answered: closed after three days, the owner is told
  const unconfirmed = await db.query<Request>(`select * from pm_maintenance_requests where org_id = $1 and status = 'fixed' and fixed_at <= $2 limit 50`, [e.orgId, new Date(now.getTime() - days(3)).toISOString()])
  for (const r of unconfirmed) {
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'pm_tenant_update', agentName: NAME.pm_tenant_update, actionType: 'update_record', problemKey: `req:${r.id}:closed_unconfirmed`, detailsPath: PATH,
      detect: async () => r,
      describe: () => ({ title: `${ref(r)} closed without the tenant's confirmation`, whatHappened: `The vendor reported the ${r.category} issue fixed three days ago; the tenant has not answered.`, whatIDid: ['Closed the request. If the tenant writes again it opens a new one.'] }),
      act: async d => { await d.query(`update pm_maintenance_requests set status = 'closed', status_reason = 'the tenant did not answer the fix check' where id = $1`, [r.id]); return {} },
      verify: async d => { const x = await d.one<{ status: string }>('select status from pm_maintenance_requests where id = $1', [r.id]); return { ok: x?.status === 'closed', proof: [rowProof('Request status', x?.status ?? 'missing')] } },
    }))
  }
  return out
}

export async function sweepRent(db: Db, e: AgentEvent, org: OrgPacks) {
  const now = eventNow(e)
  const today = isoDay(now)
  let due
  try { due = await (await portsFor(e.orgId)).propertySystem.listRentDue(today) } catch { return [] }
  const out: PackOutcome[] = []
  for (const r of due.filter(x => x.dueDate < today && x.amountDue > 0)) {
    const key = createHash('sha256').update(`${r.tenantId}|${r.dueDate}`).digest('hex').slice(0, 16)
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'pm_rent_reminder', agentName: NAME.pm_rent_reminder, actionType: 'send_customer_email', problemKey: `rent:${key}`, detailsPath: PATH,
      detect: async () => r,
      describe: () => ({ title: `Rent reminder: ${r.tenantName ?? 'a tenant'}${r.unit ? `, unit ${r.unit}` : ''}`, whatHappened: `${formatMoney(r.amountDue, r.currency)} rent was due on ${formatDate(r.dueDate)} and is not paid.`, whatIDid: ['Sent a friendly rent reminder.'] }),
      act: async (d, p) => {
        if (!r.tenantEmail) throw new PackBlocked(`${r.tenantName ?? 'the tenant'}${r.unit ? ` (unit ${r.unit})` : ''} has no email in the property system`)
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: 'pm_rent_reminder', to: r.tenantEmail, ...rentReminder({ name: r.tenantName, business: org.config.senderName, amount: formatMoney(r.amountDue, r.currency), due: formatDate(r.dueDate), unit: r.unit }), dedupeKey: `pm:rent:${key}`, policy: 'fair_housing', recipientNames: [r.tenantName] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the reminder failed the content check' : `the tenant could not be reached: ${s.error}`)
        Object.assign(p, { messageId: s.messageId })
        return { proof: [policyProof(s.policy), rowProof('Balance read from the property system', formatMoney(r.amountDue, r.currency))] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as typeof p & { messageId: string }).messageId, 'Rent reminder'),
    }))
  }
  return out
}

export async function pmSweep(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  return { vendors: await sweepVendors(db, e, org), rent: await sweepRent(db, e, org) }
}

export function registerPropertyManagement() {
  onEvent('buildium.maintenance.created', 'pm_maintenance_intake', async (db, e) => { await onBuildiumMaintenance(db, e) })
  onEvent('mail.received', 'pm_maintenance_intake', async (db, e) => { await onPmMail(db, e) })
  onEvent('sweep', 'pm_sweep', async (db, e) => { await pmSweep(db, e) })
}
