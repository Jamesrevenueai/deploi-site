/**
 * What the pack pages show: the business type and its packs, each pack's agents with what they did (pack
 * activity and Resolution Engine cases), its settings, and the pack's own records (jobs, move-ins and
 * commission invoices, maintenance requests, leads). Reads run as the user (RLS); writes as the service role
 * after the caller is shown to be a merchant of the organization.
 */
import './all' // every pack's agents, commerce included, are registered before a page lists them
import { admin, type Db } from '../db'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { PACK_AGENTS, PACKS, type PackKey } from './registry'
import { BUSINESS_TYPES, TRADES, orgPacks, type PackConfig } from './settings'
import { recordPlacement, recordPayment, weeklyTotals } from './commission'
import { recordQuote, scheduleJob } from './home-services'
import { PackBlocked } from './loop'
import './index'

const orgOf = (actor: Actor) => { if (actor.kind === 'staff') throw new EngineError('forbidden', 'packs belong to a merchant'); return actor.orgId }
export const isPack = (v: unknown): v is PackKey => typeof v === 'string' && v in PACKS

export async function packsOverview(actor: Actor) {
  const orgId = orgOf(actor)
  return withActor(actor, async db => {
    const o = await orgPacks(db, orgId)
    const counts = await db.query<{ pack: string; done: number; attention: number }>(`select pack, count(*) filter (where status = 'done' and updated_at > now() - interval '30 days')::int as done,
      count(*) filter (where status in ('blocked','not_verified','failed','waiting_for_owner'))::int as attention from pack_activity where org_id = $1 group by pack`, [orgId])
    const by = new Map(counts.map(c => [c.pack, c]))
    return {
      businessType: o.businessType, trade: o.trade, config: o.config, businessTypes: BUSINESS_TYPES, trades: TRADES,
      packs: o.packs.map(k => ({ key: k, name: PACKS[k].name, agents: PACK_AGENTS.filter(a => a.pack === k).length, done30d: by.get(k)?.done ?? 0, attention: by.get(k)?.attention ?? 0 })),
    }
  })
}

async function packRecords(db: Db, orgId: string, pack: PackKey, today: string) {
  // the commerce agents keep their work in the store work log (library_actions), shown on Completed Work
  if (pack === 'commerce') return {}
  if (pack === 'home_services' || pack === 'office') return {
    jobs: await db.query(`select id, ref, customer_name, status, amount, currency, scheduled_start, invoice_number, invoice_balance, quote_follow_ups, payment_reminders, updated_at from pack_work_orders where org_id = $1 and pack = $2 order by updated_at desc limit 50`, [orgId, pack]),
    crew: await db.query(`select id, name, email, phone, trade, active from pack_crew_members where org_id = $1 order by name`, [orgId]),
  }
  if (pack === 'leasing') {
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10)
    return {
      properties: await db.query(`select p.id, p.name, p.commission_type, p.commission_value, p.payment_terms_days, coalesce(p.billing_email, c.billing_email) as bill_to, c.name as company from leasing_properties p left join leasing_companies c on c.id = p.company_id where p.org_id = $1 order by p.name`, [orgId]),
      placements: await db.query(`select pl.id, pl.tenant_name, pl.unit, to_char(pl.move_in_date, 'YYYY-MM-DD') as move_in_date, pl.monthly_rent, pl.commission_amount, pl.status, p.name as property, i.number as invoice from leasing_placements pl
        left join leasing_properties p on p.id = pl.property_id left join leasing_invoices i on i.id = pl.invoice_id where pl.org_id = $1 order by pl.move_in_date desc limit 100`, [orgId]),
      invoices: await db.query(`select i.id, i.number, to_char(i.issued_on, 'YYYY-MM-DD') as issued_on, to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.total, i.paid_amount, i.status, i.reminders, i.bill_to, p.name as property from leasing_invoices i
        left join leasing_properties p on p.id = i.property_id where i.org_id = $1 order by i.issued_on desc, i.number desc limit 100`, [orgId]),
      week: await weeklyTotals(db, orgId, from, today),
      leads: await db.query(`select id, name, source, status, criteria, created_at from pack_leads where org_id = $1 and pack = 'leasing' order by created_at desc limit 50`, [orgId]),
    }
  }
  if (pack === 'property_management') return {
    requests: await db.query(`select r.id, r.source, r.property, r.unit, r.tenant_name, r.category, r.urgency, r.status, r.updated_at, v.name as vendor from pm_maintenance_requests r left join pm_vendors v on v.id = r.vendor_id where r.org_id = $1 order by r.updated_at desc limit 50`, [orgId]),
    vendors: await db.query(`select id, name, email, phone, trades, active from pm_vendors where org_id = $1 order by name`, [orgId]),
  }
  return { leads: await db.query(`select id, name, source, intent, status, crm_record_id, created_at from pack_leads where org_id = $1 and pack = $2 order by created_at desc limit 50`, [orgId, pack]) }
}

export async function packView(actor: Actor, pack: unknown, today = new Date().toISOString().slice(0, 10)) {
  if (!isPack(pack)) throw new EngineError('not_found', 'no such pack')
  const orgId = orgOf(actor)
  return withActor(actor, async db => {
    const o = await orgPacks(db, orgId)
    const agents = PACK_AGENTS.filter(a => a.pack === pack)
    const stats = await db.query<{ agent_key: string; done: number; attention: number; last: string | null }>(`select agent_key, count(*) filter (where status = 'done')::int as done,
      count(*) filter (where status in ('blocked','not_verified','failed','waiting_for_owner'))::int as attention, max(updated_at)::text as last from pack_activity where org_id = $1 and pack = $2 group by agent_key`, [orgId, pack])
    const by = new Map(stats.map(s => [s.agent_key, s]))
    const activity = await db.query(`select id, agent_key, status, mode, title, what_happened, what_i_did, proof, error, runs, updated_at from pack_activity where org_id = $1 and pack = $2 order by updated_at desc limit 50`, [orgId, pack])
    const keys = agents.map(a => `${a.key}:%`)
    const cases = await db.query(`select ref, title, status, kind, updated_at from cases where org_id = $1 and (dedupe_key like any($2::text[]) or agent_ref = any($3::text[])) order by updated_at desc limit 20`, [orgId, keys, agents.map(a => a.key)])
    return {
      pack: { key: pack, name: PACKS[pack].name, on: o.packs.includes(pack) }, config: o.config, trade: o.trade,
      agents: agents.map(a => ({ ...a, done: by.get(a.key)?.done ?? 0, attention: by.get(a.key)?.attention ?? 0, lastActive: by.get(a.key)?.last ?? null })),
      activity, cases, records: await packRecords(db, orgId, pack, today),
    }
  })
}

// ---------------------------------------------------------------- writes (the owner's records)

const s = (v: unknown, n: number, req = false) => { const x = typeof v === 'string' ? v.trim().slice(0, n) : ''; if (req && !x) throw new EngineError('invalid_input', 'a required field is empty'); return x || null }
const email = (v: unknown) => { const x = s(v, 254); if (x && !/^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x)) throw new EngineError('invalid_input', 'not a valid email address'); return x?.toLowerCase() ?? null }
const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(v); if (!Number.isFinite(n) || n < 0) throw new EngineError('invalid_input', 'not a valid amount'); return Math.round(n * 100) / 100 }
const uuid = (v: unknown) => { if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new EngineError('invalid_input', 'not a valid id'); return v }

/** One of the owner's record edits, by op. Every row is written for the caller's own organization only. */
export async function packWrite(actor: Actor, op: unknown, b: Record<string, unknown>) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  try {
    return await admin(async db => {
      switch (op) {
        case 'crew': return db.one(`insert into pack_crew_members (org_id, name, email, phone, trade) values ($1,$2,$3,$4,$5) returning id`, [orgId, s(b.name, 120, true), email(b.email), s(b.phone, 40), s(b.trade, 60)])
        case 'vendor': {
          const trades = Array.isArray(b.trades) ? b.trades.filter(t => typeof t === 'string' && ['plumbing', 'electrical', 'hvac', 'appliance', 'pest', 'locks', 'general'].includes(t)) : []
          if (!trades.length) throw new EngineError('invalid_input', 'choose at least one trade for the vendor')
          return db.one(`insert into pm_vendors (org_id, name, email, phone, trades) values ($1,$2,$3,$4,$5) returning id`, [orgId, s(b.name, 160, true), email(b.email), s(b.phone, 40), trades])
        }
        case 'property': {
          const company = s(b.company, 160)
          const co = company ? await db.one<{ id: string }>(`insert into leasing_companies (org_id, name, billing_email, contact_name) values ($1,$2,$3,$4) returning id`, [orgId, company, email(b.companyEmail), s(b.contactName, 160)]) : null
          const type = b.commissionType === 'flat' ? 'flat' : 'percent'
          const value = num(b.commissionValue)
          if (type === 'percent' && value > 200) throw new EngineError('invalid_input', 'a percent commission is at most 200% of one month')
          return db.one(`insert into leasing_properties (org_id, company_id, name, address, billing_email, commission_type, commission_value, payment_terms_days) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [orgId, co?.id ?? null, s(b.name, 160, true), s(b.address, 300), email(b.billingEmail), type, value, Number.isInteger(b.paymentTermsDays) ? b.paymentTermsDays : 30])
        }
        case 'listing': {
          const prop = uuid(b.propertyId)
          if (!(await db.one('select 1 from leasing_properties where id = $1 and org_id = $2', [prop, orgId]))) throw new EngineError('not_found', 'property not found')
          const beds = Number(b.bedrooms)
          if (!Number.isInteger(beds) || beds < 0 || beds > 10) throw new EngineError('invalid_input', 'bedrooms must be 0 to 10')
          return db.one(`insert into leasing_listings (org_id, property_id, unit, bedrooms, monthly_rent, available_from, pets_allowed, application_url) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [orgId, prop, s(b.unit, 40, true), beds, num(b.monthlyRent), s(b.availableFrom, 10), b.petsAllowed === true, s(b.applicationUrl, 500)])
        }
        case 'placement': return recordPlacement(db, orgId, { propertyId: uuid(b.propertyId), tenantName: s(b.tenantName, 160, true)!, tenantEmail: email(b.tenantEmail), unit: s(b.unit, 40, true)!, moveInDate: s(b.moveInDate, 10, true)!, monthlyRent: num(b.monthlyRent) })
        case 'payment': return recordPayment(db, orgId, { invoiceId: uuid(b.invoiceId), amount: num(b.amount), receivedOn: s(b.receivedOn, 10) ?? new Date().toISOString().slice(0, 10), note: s(b.note, 300) })
        case 'quote': return recordQuote(db, orgId, { customerName: s(b.customerName, 160), customerEmail: email(b.customerEmail), customerPhone: s(b.customerPhone, 40), address: s(b.address, 300), description: s(b.description, 2000) ?? '', amount: num(b.amount), pack: b.pack === 'office' ? 'office' : 'home_services' })
        case 'schedule': {
          const start = new Date(String(b.start ?? ''))
          if (Number.isNaN(start.getTime())) throw new EngineError('invalid_input', 'choose a start time')
          return scheduleJob(db, orgId, uuid(b.workOrderId), { crewMemberId: uuid(b.crewMemberId), start })
        }
        default: throw new EngineError('invalid_input', 'unknown operation')
      }
    })
  } catch (e) {
    if (e instanceof PackBlocked) throw new EngineError('invalid_input', e.message.replace(/^blocked: /, ''))
    throw e
  }
}
export type { PackConfig }
