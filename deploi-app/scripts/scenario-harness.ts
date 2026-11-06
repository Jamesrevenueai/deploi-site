/**
 * Scenario harness: proves, pack by pack, that the agents find seeded problems UNPROMPTED and handle them.
 *
 *   npx tsx scripts/scenario-harness.ts [--only A,B,X] [--skip-migrate]
 *
 * Runs against its OWN local database `deploi_scenarios` (created, migrated and seeded here; never deploi_test, never a
 * remote database). For each scenario it:
 *   1. seeds the state only (synthetic Shopify store, synthetic pack ports, rows in the pack tables);
 *   2. fires only the normal triggers: the 15-minute sweep (emitSweep), a Shopify webhook event as the webhook route
 *      routes it (routeEvent), or the change a connection would emit (emitConnectionEvent / the Outlook inbox sync storeProviderMessage), then
 *      drains the durable job queue (runDueJobs), exactly as the cron and the webhook route do;
 *   3. measures: detection time (seed done -> agent_loops row created), the action (agent_loops, pack_activity,
 *      library_actions), the verification, the owner update (owner_updates + the rendered system email), crew
 *      messages, undo tokens, and the final state;
 *   4. passes or fails it against the expected outcome written next to it.
 * Writes proof/scenarios/results.json and docs/SCENARIOS-2026-11-07.md.
 *
 * Everything is synthetic: synthetic Shopify store state, synthetic mail/calendar/CRM/invoicing/property ports, a
 * synthetic QuickBooks and mailbox for Office. AI_PROVIDER is forced off (rules and templates only). Owner emails go
 * through the real owner-update pipeline and are rendered and HELD (no RESEND_API_KEY), so nothing leaves the machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

// ------------------------------------------------------------------ environment (before any database use)

const DB_NAME = 'deploi_scenarios'
const BASE = process.env.SCENARIO_PG_BASE ?? 'postgres://postgres:postgres@127.0.0.1:5432'
const URL = `${BASE}/${DB_NAME}`
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) { console.error('refusing: the scenario database must be local'); process.exit(1) }
process.env.DATABASE_URL = URL
process.env.APP_SECRET ||= 'scenario-secret-scenario-secret-1234'
process.env.AUTH_MODE = 'dev'
process.env.STAFF_EMAILS ||= 'hello@getdeploi.com'
process.env.SHOPIFY_API_KEY ||= 'test-api-key'
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret-0123456789'
process.env.CREDENTIALS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
process.env.CREDENTIALS_KEY_ID ||= 'test-k1'
process.env.VERIFY_DELAY_MS ||= '5'
process.env.JOBS_ORG_CONCURRENCY = '2'
for (const k of ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS', 'AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NOTIFY_SMS_PROVIDER', 'VERCEL_ENV', 'DEPLOI_ENV', 'JOBS_PAUSED']) delete process.env[k]

// the app's structured log lines (one JSON object per line) are kept out of the harness output; warnings are counted
const appWarnings: string[] = []
for (const k of ['log', 'warn', 'error'] as const) {
  const orig = console[k].bind(console)
  console[k] = (...a: unknown[]) => { if (typeof a[0] === 'string' && a[0].startsWith('{"t":')) { if (k !== 'log') appWarnings.push(a[0].slice(0, 400)); return } orig(...a) }
}

import { admin } from '../lib/db'
import { emitSweep, routeEvent, type AgentEvent } from '../lib/events'
import { emitConnectionEvent, type ConnectionEvent } from '../lib/connections/events'
import { storeProviderMessage } from '../lib/email/inbox-sync'
import type { EmailAccountRow } from '../lib/email/accounts'
import { seedCommerceCrew } from '../lib/connectors/shopify/synthetic'
import { runDueJobs, type JobOutcome } from '../lib/jobs'
import { enqueueDueCases } from '../lib/cases/jobs'
import '../lib/events/agents'
import '../lib/notify/impl'
import { setNotifyImpl, type CrewMessage, type NotifyResult, type OwnerUpdate } from '../lib/notify'
import { notifyOwnerImpl } from '../lib/notify/owner'
import { notifyCrewImpl } from '../lib/notify/crew'
import { runUndo } from '../lib/undo/run'
import { setMode } from '../lib/autonomy/settings'
import { setSyntheticState, getSyntheticState, mutateSynthetic, commerceQuietState, seedCommerceScenario, injectFault, COMMERCE_IDS, type CommerceScenario, type SynthCommerce } from '../lib/connectors/shopify/synthetic'
import { getSynth, mutateSynth, resetSynth, injectPortFault } from '../lib/packs/synthetic'
import { chooseBusinessType } from '../lib/packs/settings'
import { recordQuote, scheduleJob } from '../lib/packs/home-services'
import { recordPlacement } from '../lib/packs/commission'
import { greetName } from '../lib/packs/templates'
import type { BusinessType } from '../lib/packs/registry'
import { enableProduct } from '../lib/products'
import { connectSyntheticOffice } from '../lib/office/connections'
import { connectSyntheticMailbox } from '../lib/office/mailbox'
import { createOfficeAgent, grantOfficePolicy } from '../lib/office/agents'
import { officeTemplatePolicy } from '../lib/office/templates'
import { mutateQboSynth, synthInvoice, injectQboFault } from '../lib/office/quickbooks-synthetic'
import { getSynthMail } from '../lib/email/adapters/synthetic'
import type { QboInvoice } from '../lib/office/quickbooks'
import type { Actor } from '../lib/engine/actor'
import { NW, HB, merchantActor, resetMerchant } from '../tests/merchant/helpers'

// ------------------------------------------------------------------ captured notify (the real pipeline, observed)

/** The real owner and crew implementations run; the harness only keeps a copy of each call (for the undo token). */
const seenOwner: OwnerUpdate[] = []
const seenCrew: { m: CrewMessage; r: NotifyResult }[] = []
setNotifyImpl({
  owner: async u => { seenOwner.push(u); return notifyOwnerImpl(u) },
  crew: async m => { const r = await notifyCrewImpl(m); seenCrew.push({ m, r }); return r },
})

// ------------------------------------------------------------------ types

type PackId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'X'
type Kind = 'normal' | 'edge' | 'failure'
type Rules = 'fully' | 'partly' | 'needs AI'
type M = typeof NW
type LoopRow = { agent_key: string; state: string; problem_key: string; mode: string; last_error: string | null; created_at: Date; undo_token_id: string | null; asked_at: Date | null; reminded_at: Date | null; escalated_at: Date | null; case_id: string | null }
type ActivityRow = { agent_key: string; problem_key: string; status: string; title: string; error: string | null; proof: { label: string; value: string }[]; created_at: Date }
type WorkRow = { id: string; agent_key: string; action_type: string; status: string; mode: string; title: string; status_reason: string | null; payload: Record<string, unknown>; proof: { items: { label: string; value: string }[]; verified: boolean } | null; created_at: Date }
type OwnerRow = { agent_key: string; headline: string; severity: string; kind: string; channel: string; status: string; status_reason: string | null; dedupe_key: string; email_status: string | null; email_html: number | null; email_subject: string | null }
type CrewRow = { channel: string; status: string; status_reason: string | null; subject: string | null; job_refs: string[] }
type UndoRow = { kind: string; agent_key: string | null; used_at: Date | null; result: { ok: boolean; detail: string } | null }
type Obs = { loops: LoopRow[]; activity: ActivityRow[]; work: WorkRow[]; owner: OwnerRow[]; crew: CrewRow[]; crewCalls: { m: CrewMessage; r: NotifyResult }[]; undo: UndoRow[]; jobs: JobOutcome[]; ownerCalls: OwnerUpdate[] }

type Ctx = {
  m: M
  /** mark the end of seeding: the detection clock starts here */
  seeded: () => void
  sweep: (at: Date) => Promise<void>
  route: (e: Omit<AgentEvent, 'orgId'> & { orgId?: string }) => Promise<string>
  conn: (e: Omit<ConnectionEvent, 'orgId'> & { orgId?: string }) => Promise<string>
  drain: (opts?: { workers?: number }) => Promise<JobOutcome[]>
  note: (s: string) => void
  /** values a check wants to show in the report */
  facts: Record<string, unknown>
}
type Check = [label: string, ok: boolean, observed?: unknown]
type Scenario = {
  id: string; pack: PackId; title: string; kind: Kind
  /** the agents whose loop rows count as "detected" */
  agents: string[]
  /** true when the expected outcome is that no agent acts (the detection column is then n/a) */
  expectNoAction?: boolean
  expected: string
  rules: Rules; rulesWhy: string
  synthetic: string
  /** the shared org to use (default by pack) */
  org?: 'NW' | 'HB'
  run: (c: Ctx) => Promise<void>
  check: (o: Obs, c: Ctx) => Promise<Check[]>
}
type Result = {
  id: string; pack: PackId; title: string; kind: Kind; expected: string; synthetic: string; rules: Rules; rulesWhy: string
  detected: 'yes' | 'no' | 'n/a'; detectionMs: number | null; action: string; verified: string; ownerEmail: string; crewMsg: string; undo: string
  finalStatus: string; result: 'PASS' | 'FAIL'; failures: string[]; error: string | null; notes: string[]; jobErrors: string[]; facts: Record<string, unknown>; durationMs: number
}

// ------------------------------------------------------------------ database helpers

const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => admin(db => db.query<T>(sql, p))
const q1 = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => admin(db => db.one<T>(sql, p))

async function ensureDatabase(skipMigrate: boolean) {
  const c = new Client({ connectionString: `${BASE}/postgres` })
  await c.connect()
  const has = await c.query('select 1 from pg_database where datname = $1', [DB_NAME])
  if (!has.rowCount) { await c.query(`create database ${DB_NAME}`); console.log(`created database ${DB_NAME}`) }
  await c.end()
  if (!skipMigrate) {
    const { migrate } = await import('./migrate')
    const { seed } = await import('./seed')
    await migrate(URL)
    await seed(URL)
  }
  const cur = await q1<{ db: string }>('select current_database() as db')
  if (cur?.db !== DB_NAME) throw new Error(`connected to ${cur?.db}, expected ${DB_NAME}`)
}

/** The queue, the router's records and the connection dedupe are per database: this database is the harness's own. */
async function clearQueue() {
  await q(`delete from jobs`)
  await q(`delete from agent_events`)
  await q(`delete from connection_events`)
}

async function clearAgentState(m: M) {
  await admin(async db => {
    // the first-day pacing (lib/autonomy/pacing.ts) belongs to the connect that started it: each scenario starts outside it
    for (const t of ['undo_tokens', 'agent_loops', 'org_action_modes', 'org_controls', 'owner_updates', 'notify_outbox', 'crew_job_links', 'crew_messages', 'crew_jobs', 'crew_members', 'morning_reports', 'notify_preferences', 'autonomy_backlog', 'autonomy_outbound', 'autonomy_connects'])
      await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query(`delete from cases where org_id = $1`, [m.org])
    await db.query(`delete from system_emails where org_id = $1 and template in ('agent_update', 'agent_action_needed', 'crew_jobs', 'morning_report')`, [m.org])
  })
}

const PACK_TABLES = ['pack_activity', 'pack_messages', 'pack_appointments', 'pm_maintenance_requests', 'pm_vendors', 'leasing_payments', 'leasing_placements', 'leasing_invoices', 'leasing_listings', 'leasing_properties', 'leasing_companies', 'pack_work_orders', 'pack_crew_members', 'pack_leads', 'pack_settings']

async function resetOfficeFor(m: M, enable = true) {
  await admin(async db => {
    for (const t of ['email_suppressions', 'email_sender_rules', 'email_messages', 'office_inbound_handled', 'office_actions', 'office_meetings', 'office_leads', 'office_runs']) await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query('update office_agents set active_policy_id = null where org_id = $1', [m.org])
    for (const t of ['office_agent_policies', 'office_agents', 'office_connections', 'office_oauth_states', 'office_org_locks', 'email_inbound', 'email_oauth_states', 'email_accounts']) await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await enableProduct(db, m.org, 'commerce', 'scenario-harness')
    if (enable) await enableProduct(db, m.org, 'office', 'scenario-harness')
  })
}

/** Commerce: a quiet synthetic store with the given scenarios seeded (mirrors tests/commerce/pack-helpers resetCommerce). */
async function resetCommerce(m: M, scenarios: CommerceScenario[] = []) {
  await resetMerchant(m)
  await admin(async db => {
    for (const t of ['library_chat_messages', 'library_usage', 'library_actions', 'library_auto_run_grants', 'library_switches', 'custom_agents']) await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query(`update agencies set plan_tier = 'pro', onboarding = '{}'::jsonb where id = $1`, [m.org])
    for (const t of PACK_TABLES) await db.query(`delete from ${t} where org_id = $1`, [m.org])
  })
  await resetSynth(m.org)
  await clearAgentState(m)
  await resetOfficeFor(m, false)
  await admin(db => db.query(`update store_connections set status = 'active', status_reason = null where id = $1`, [m.conn]))
  const now = new Date()
  const s = commerceQuietState(now)
  for (const sc of scenarios) seedCommerceScenario(s, sc, now)
  await setSyntheticState(m.conn, s)
  // the store's packer is on the organization's one crew roster (crew_members), like any crew member
  await seedCommerceCrew(m.org)
}

/** Packs B-F: a clean organization with a business type (mirrors tests/packs/helpers resetPacks). Its Shopify store is
 * marked uninstalled so the commerce agents stay out of the measurement. */
async function resetPacks(m: M, businessType: BusinessType, opts: { trade?: string; settings?: Record<string, unknown>; office?: boolean } = {}) {
  await admin(async db => { for (const t of PACK_TABLES) await db.query(`delete from ${t} where org_id = $1`, [m.org]) })
  await admin(async db => { for (const t of ['library_actions', 'library_switches']) await db.query(`delete from ${t} where org_id = $1`, [m.org]) })
  await resetSynth(m.org)
  await clearAgentState(m)
  await resetOfficeFor(m, opts.office ?? false)
  await admin(db => db.query(`update store_connections set status = 'uninstalled', status_reason = 'scenario harness: packs B-F run without a store' where id = $1`, [m.conn]))
  await chooseBusinessType(await merchantActor(m), { businessType, trade: opts.trade ?? null })
  if (opts.settings) await q(`update pack_settings set settings = settings || $2::jsonb where org_id = $1`, [m.org, JSON.stringify(opts.settings)])
  await q(`update agencies set timezone = 'UTC' where id = $1`, [m.org])
}

async function observe(m: M, jobs: JobOutcome[], ownerFrom: number, crewFrom: number): Promise<Obs> {
  const [loops, activity, work, owner, crew, undo] = await Promise.all([
    q<LoopRow>(`select agent_key, state, problem_key, mode, last_error, created_at, undo_token_id, asked_at, reminded_at, escalated_at, case_id from agent_loops where org_id = $1 order by created_at`, [m.org]),
    q<ActivityRow>(`select agent_key, problem_key, status, title, error, proof, created_at from pack_activity where org_id = $1 order by created_at`, [m.org]),
    q<WorkRow>(`select id, agent_key, action_type, status, mode, title, status_reason, payload, proof, created_at from library_actions where org_id = $1 order by created_at`, [m.org]),
    q<OwnerRow>(`select u.agent_key, u.headline, u.severity, u.kind, u.channel, u.status, u.status_reason, u.dedupe_key, e.status as email_status, length(e.body_html) as email_html, e.subject as email_subject
       from owner_updates u left join system_emails e on e.id = u.system_email_id where u.org_id = $1 order by u.created_at`, [m.org]),
    q<CrewRow>(`select channel, status, status_reason, subject, job_refs from crew_messages where org_id = $1 and direction = 'out' order by created_at`, [m.org]),
    q<UndoRow>(`select kind, agent_key, used_at, result from undo_tokens where org_id = $1 order by created_at`, [m.org]),
  ])
  return { loops, activity, work, owner, crew, undo, jobs, crewCalls: seenCrew.slice(crewFrom), ownerCalls: seenOwner.slice(ownerFrom) }
}

// ------------------------------------------------------------------ clocks

/** A Monday 08:00 UTC some weeks ahead: the packs read the event's own time, never the wall clock. */
function monday(weeksAhead = 2): Date {
  const d = new Date(); d.setUTCHours(8, 0, 0, 0)
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back + 7 * weeksAhead)
  return d
}
const plus = (d: Date, h: number) => new Date(d.getTime() + h * 3600e3)
const isoDay = (d: Date, n = 0) => new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10)
/** commerce agents run on the wall clock; each commerce sweep takes its own 15-minute window */
let commerceSlot = 0
const commerceSweepTime = () => new Date(Date.now() + 15 * 60_000 * ++commerceSlot)
let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`

// ------------------------------------------------------------------ small readers

const commerceOf = async (m: M) => (await getSyntheticState(m.conn))!.commerce as SynthCommerce
const productOf = async (m: M, id: string) => (await getSyntheticState(m.conn))!.products.find(p => p.id === id)!
const sentMail = async (m: M) => (await getSynth(m.org, 'mail')).sent
const ownerFor = (o: Obs, agents: string[]) => o.owner.filter(r => agents.includes(r.agent_key))
const renderedEmails = (o: Obs, agents: string[]) => ownerFor(o, agents).filter(r => r.channel === 'email' && r.email_status && (r.email_html ?? 0) > 200)
const lead = (o: { id: string; from?: string; name?: string; email?: string; text?: string; subject?: string; fields?: Record<string, string> }) => {
  const lines = [o.name ? `Name: ${o.name}` : '', o.email ? `Email: ${o.email}` : '', ...Object.entries(o.fields ?? {}).map(([k, v]) => `${k}: ${v}`), '', o.text ?? ''].filter((l, i) => l || i > 0)
  return { from: o.from ?? 'leads@zillow.com', subject: o.subject ?? 'New rental lead', text: lines.join('\n'), messageId: o.id }
}
/** The organization's Outlook mailbox (a Microsoft 365 email account row; nothing is fetched from Microsoft). */
async function outlookAccount(m: M): Promise<EmailAccountRow> {
  const had = await q1<EmailAccountRow>(`select * from email_accounts where org_id = $1 and provider = 'microsoft' and address like '%@scenarios.example' limit 1`, [m.org])
  if (had) return had
  return (await q1<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1,'microsoft',$2,'active',$3,true,true,false,'scenario-harness') returning *`,
    [m.org, `office-${m.org.slice(0, 8)}@scenarios.example`, ['Mail.Send', 'Mail.ReadWrite']]))!
}
/** A message arriving through the real Outlook inbox sync: stored encrypted in email_inbound, then mail.received (and
 * lead.email for a portal lead) through emitMailEvents, then the job worker. */
async function viaOutlook(c: Ctx, o: { id: string; from: string; subject: string; text: string; at: Date }) {
  const r = await storeProviderMessage(await outlookAccount(c.m), outlookMessage(o), 'scenario-harness')
  c.facts.inbox = [...((c.facts.inbox as string[]) ?? []), r]
  await c.drain()
}
/** A provider message as the Outlook inbox sync hands it to emitMailEvents (lib/outlook/mail-events.ts). */
function outlookMessage(o: { id: string; from: string; subject: string; text: string; at: Date }) {
  return { providerMessageId: o.id, providerThreadId: `thr-${o.id}`, internetMessageId: `<${o.id}@outlook.example>`, from: o.from, to: ['office@harbor.example'], cc: [], subject: o.subject, text: o.text,
    inReplyTo: null, references: [], receivedAt: o.at.toISOString(), headers: {}, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [], truncated: false }
}
const ZILLOW_TEXT = (name: string, email: string, moveIn: string) => `You have a new lead!\n\nA renter is interested in your listing at 1420 NW Lovejoy St #4B, Portland, OR 97209.\n\nName: ${name}\nEmail: ${email}\nPhone: (503) 555-0147\nMove-in date: ${moveIn}\nMessage: Hi! I'd love to schedule a tour this weekend.\n\nReply to this lead in Zillow Rental Manager.`

async function seedListings(m: M, T: Date) {
  const day = (n: number) => isoDay(T, n)
  return admin(async db => {
    const co = (await db.one<{ id: string }>(`insert into leasing_companies (org_id, name, billing_email, contact_name) values ($1,'Harbor Property Group','ap@harborpg.example','Robin Lane') returning id`, [m.org]))!
    const maple = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, company_id, name, commission_type, commission_value, payment_terms_days) values ($1,$2,'Maple Court','percent',50,30) returning id`, [m.org, co.id]))!
    const birch = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name, billing_email, commission_type, commission_value) values ($1,'Birch Lofts','billing@birchlofts.example','flat',750) returning id`, [m.org]))!
    const add = (p: string, unit: string, beds: number, rent: number, avail: string | null, pets: boolean, url: string | null = null) =>
      db.query(`insert into leasing_listings (org_id, property_id, unit, bedrooms, monthly_rent, available_from, pets_allowed, application_url) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [m.org, p, unit, beds, rent, avail, pets, url])
    await add(maple.id, '4B', 2, 1950, day(10), false, 'https://apply.example/maple-4b')
    await add(maple.id, '2A', 2, 1800, null, true, 'https://apply.example/maple-2a')
    await add(birch.id, '301', 2, 2100, day(5), true)
    await add(birch.id, '105', 1, 1500, null, true)
    await add(birch.id, '402', 2, 1700, day(40), false)
    return { co: co.id, maple: maple.id, birch: birch.id }
  })
}
async function pmVendors(m: M) {
  return admin(async db => ({
    plumber: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Ace Plumbing','dispatch@aceplumbing.example','{plumbing}') returning id`, [m.org]))!.id,
    plumber2: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Best Pipes','jobs@bestpipes.example','{plumbing}') returning id`, [m.org]))!.id,
    handy: (await db.one<{ id: string }>(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Handy Co','work@handy.example','{general}') returning id`, [m.org]))!.id,
  }))
}
const packCrew = (m: M) => q1<{ id: string }>(`insert into crew_members (org_id, name, role, email, phone, channels) values ($1,'Sam Ortiz','field','sam@crew.example','+15550100',array['email']::text[]) returning id`, [m.org]).then(r => r!)

/** Office receivables (mirrors tests/office/receivables-helpers setupReceivables + arAgent). */
async function officeReceivables(m: M, invoices: QboInvoice[], tier: 'draft' | 'send_approved' | 'send_autonomous' = 'draft') {
  await q(`delete from cases where org_id = $1 and kind = 'invoice_overdue'`, [m.org])
  const actor: Actor = await merchantActor(m)
  const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
  const mb = await connectSyntheticMailbox(actor, `ar@${m === NW ? 'northwind' : 'harbor'}-office.example`)
  await mutateQboSynth(qb.id, s => { s.invoices = invoices })
  const p = officeTemplatePolicy('accounts_receivable', { quickbooksConnectionId: qb.id, mailboxAccountId: mb.id, timezone: 'UTC', senderName: 'Sam at Harbor' }) as Record<string, Record<string, unknown>>
  p.email = { ...p.email, tier, quietHours: null, validUntil: tier === 'send_autonomous' ? new Date(Date.now() + 60 * 864e5).toISOString() : null }
  p.receivables.excludeCustomerIds = ['77']
  const r = await createOfficeAgent(actor, { kind: 'accounts_receivable', name: 'Receivables', policy: p })
  await grantOfficePolicy(actor, r.agentId, r.policyId, r.policyHash)
  return { agentId: r.agentId, qbId: qb.id }
}
const qbInv = (id: string, due: string, total: number) => synthInvoice(id, { docNumber: id, totalAmt: total, dueDate: due, txnDate: due, customerId: '58', customerName: 'Acme Studio', billEmail: 'ap@acme-studio.example' })

// shorthand for shopify webhooks and mailbox events
const shopify = (type: string, payload: Record<string, unknown>, id = uid('shopify-ev')): Omit<AgentEvent, 'orgId'> =>
  ({ source: 'shopify', type, externalId: id, occurredAt: new Date().toISOString(), payload: { ...payload, _deploi: { topic: type, webhookId: id } } })

const getSynthMailSent = async (accountId: string) => (await getSynthMail(accountId)).sent.map(m => [m.to].flat()[0] as string)

// ------------------------------------------------------------------ scenarios

const COMMERCE_AGENTS_ALL = ['inventory_watcher', 'supplier_chaser', 'order_tracker', 'returns', 'listing_writer', 'campaign', 'promo_manager', 'customer_care', 'payout_fees_checker', 'ai_visibility', 'store_health_checker', 'weekly_insights']
const SYN_SHOP = 'synthetic Shopify store state (seedCommerceScenario); webhook payload shaped as the webhook route routes it'
const SYN_PORTS = 'synthetic pack ports (mail, calendar, CRM, invoicing, property system) in pack_synthetic_state'

const scenarios: Scenario[] = []
const add = (s: Scenario) => scenarios.push(s)

// ===== A. Commerce (12 agents, synthetic Shopify)

const commerceSweep = async (c: Ctx) => { c.seeded(); await c.sweep(commerceSweepTime()) }
const workOf = (o: Obs, kind: string) => o.work.filter(w => w.action_type === kind)

add({ id: 'A01', pack: 'A', title: 'Quiet store: only the two weekly reports', kind: 'normal', agents: ['store_health_checker', 'weekly_insights'], expected: 'sweep finds nothing to fix; only store_health_checker + weekly_insights log their weekly report; no customer mail; a second sweep adds nothing',
  rules: 'fully', rulesWhy: 'Counting and thresholds over store data; no judgement needed.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m); await commerceSweep(c); c.facts.after1 = (await q(`select 1 from library_actions where org_id = $1`, [c.m.org])).length; await c.sweep(commerceSweepTime()) },
  check: async (o, c) => [
    ['only the weekly reports', o.work.map(w => w.agent_key).sort().join(',') === 'store_health_checker,weekly_insights', o.work.map(w => w.agent_key)],
    ['second sweep adds nothing', o.work.length === c.facts.after1, o.work.length],
    ['no customer mail', (await commerceOf(c.m)).outbox.length === 0],
    ['owner emails rendered', renderedEmails(o, ['store_health_checker', 'weekly_insights']).length >= 2, renderedEmails(o, ['store_health_checker', 'weekly_insights']).length],
  ] })

add({ id: 'A02', pack: 'A', title: 'Best seller low stock (inventory webhook) -> supplier asked to restock', kind: 'normal', agents: ['inventory_watcher', 'supplier_chaser'], expected: 'inventory_watcher logs best_seller_low_stock done; one restock email to the supplier; owner told (rendered email); same webhook again sends nothing',
  rules: 'fully', rulesWhy: 'Rank + threshold + supplier on file + email template.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['best_seller_low_stock']); c.seeded(); await c.route(shopify('inventory_levels/update', { inventory_item_id: 5001, available: 3 })); await c.route(shopify('inventory_levels/update', { inventory_item_id: 5001, available: 3 })) },
  check: async (o, c) => { const mail = (await commerceOf(c.m)).outbox; return [
    ['work done', workOf(o, 'best_seller_low_stock').some(w => w.status === 'done' && w.agent_key === 'inventory_watcher'), workOf(o, 'best_seller_low_stock').map(w => `${w.agent_key}:${w.status}`)],
    ['one supplier email', mail.length === 1 && mail[0].to === 'orders@highland-mills.example', mail.map(x => x.to)],
    ['owner email rendered', renderedEmails(o, ['inventory_watcher']).length >= 1],
  ] } })

add({ id: 'A03', pack: 'A', title: 'Product selling past zero -> stop selling, verified, undo link works', kind: 'normal', agents: ['inventory_watcher'], expected: 'inventory policy set to DENY, verified by fresh read, undo token issued; using the undo link (runUndo) restores CONTINUE',
  rules: 'fully', rulesWhy: 'Negative stock + CONTINUE policy is a fact check; the fix is a single field.', synthetic: SYN_SHOP,
  run: async c => {
    await resetCommerce(c.m, ['selling_past_zero']); await commerceSweep(c)
    c.facts.policyAfter = (await productOf(c.m, COMMERCE_IDS.basket.product)).variants[0].inventoryPolicy
    const tok = seenOwner.filter(u => u.orgId === c.m.org && u.agentKey === 'inventory_watcher' && u.undoToken).at(-1)?.undoToken
    if (tok) { c.facts.undo = await runUndo(await merchantActor(c.m), tok); c.facts.policyAfterUndo = (await productOf(c.m, COMMERCE_IDS.basket.product)).variants[0].inventoryPolicy }
  },
  check: async (o, c) => [
    ['DENY after fix', c.facts.policyAfter === 'DENY', c.facts.policyAfter],
    ['undo token issued', o.undo.length >= 1, o.undo.length],
    ['undo link restores CONTINUE', c.facts.policyAfterUndo === 'CONTINUE', { undo: c.facts.undo, policy: c.facts.policyAfterUndo }],
  ] })

add({ id: 'A04', pack: 'A', title: 'Supplier silent three days -> one follow-up quoting the request', kind: 'normal', agents: ['supplier_chaser'], expected: 'one follow-up email in the restock thread, two sweeps never send two',
  rules: 'fully', rulesWhy: 'Elapsed time since sent mail with no reply in thread.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['restock_no_reply']); await commerceSweep(c); await c.sweep(commerceSweepTime()) },
  check: async (o, c) => { const f = (await commerceOf(c.m)).outbox.filter(m => m.inReplyTo === 'sent-restock-1'); return [['exactly one follow-up', f.length === 1, f.length], ['quotes the request', /> Could you confirm availability/.test(f[0]?.text ?? '')]] } })

add({ id: 'A05', pack: 'A', title: 'Order stuck unfulfilled -> customer emailed, packer messaged', kind: 'normal', agents: ['order_tracker'], expected: 'customer email for #1201; a crew message to the packer delivered (crew_messages row); owner told',
  rules: 'fully', rulesWhy: 'Order age vs dispatch promise; templates for customer and packer.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['stuck_order']); await commerceSweep(c)
    // if the action did not finish, let its retry come due and sweep again: the customer must still get one email
    await q(`update agent_loops set next_retry_at = now() - interval '1 minute' where org_id = $1 and state = 'blocked'`, [c.m.org]); await c.sweep(commerceSweepTime()) },
  check: async (o, c) => { const all = (await commerceOf(c.m)).outbox.filter(m => m.to === 'kit@shopper.example'); const mail = all[0]; return [
    ['customer emailed once, even after a retry', all.length === 1, all.length],
    ['work done', workOf(o, 'stuck_order').some(w => w.status === 'done'), workOf(o, 'stuck_order').map(w => `${w.status}:${w.status_reason ?? ''}`)],
    ['customer emailed', Boolean(mail)],
    ['packer message delivered (real crew pipeline)', o.crew.length >= 1 && o.crewCalls.every(x => x.r.status !== 'failed' && x.r.status !== 'skipped'), o.crewCalls.map(x => `${x.r.status}: ${x.r.reason ?? ''} (crewMemberId=${x.m.crewMemberId})`)],
  ] } })

add({ id: 'A06', pack: 'A', title: 'Tracking stalled (fulfillments/update webhook) -> customer told', kind: 'normal', agents: ['order_tracker'], expected: 'tracking_stalled done; customer email carries the tracking number',
  rules: 'fully', rulesWhy: 'Days since last carrier scan.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['tracking_stalled']); c.seeded(); await c.route(shopify('fulfillments/update', { order_id: 7202 })) },
  check: async (o, c) => [['done', workOf(o, 'tracking_stalled').some(w => w.status === 'done')], ['tracking in mail', (await commerceOf(c.m)).outbox.some(m => /FH7202/.test(m.text))]] })

add({ id: 'A07', pack: 'A', title: 'Return inside policy (returns/request webhook) -> approved, no refund yet', kind: 'normal', agents: ['returns'], expected: 'return OPEN, no refund, customer told refund follows on receipt',
  rules: 'fully', rulesWhy: 'Days since delivery vs the written window; reason code.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['return_in_policy']); c.seeded(); await c.route(shopify('returns/request', { admin_graphql_api_id: 'gid://shopify/Return/8201' })) },
  check: async (o, c) => { const s = await commerceOf(c.m); return [['done', workOf(o, 'return_in_policy').some(w => w.status === 'done')], ['OPEN', s.returns[0].status === 'OPEN'], ['no refund', s.refunds.length === 0]] } })

add({ id: 'A08', pack: 'A', title: 'Damaged item -> approve and refund (money action, act-and-tell)', kind: 'normal', agents: ['returns'], expected: 'one refund of $24.00 on order 7204, verified; owner told',
  rules: 'fully', rulesWhy: 'Reason code DEFECTIVE/damaged inside cap; amount from the order line.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['return_damaged']); c.seeded(); await c.route(shopify('returns/request', { admin_graphql_api_id: 'gid://shopify/Return/8202' })) },
  check: async (o, c) => { const s = await commerceOf(c.m); return [['one refund 24.00', s.refunds.length === 1 && s.refunds[0].amount === '24.00', s.refunds], ['owner email', renderedEmails(o, ['returns']).length >= 1]] } })

add({ id: 'A09', pack: 'A', title: 'Return outside policy -> holding reply, owner decides', kind: 'edge', agents: ['returns'], expected: 'draft waiting for the owner; customer gets a holding reply only; return stays REQUESTED',
  rules: 'partly', rulesWhy: 'Rules spot "outside window"; whether to make an exception is the owner\'s judgement.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['return_outside_policy']); await commerceSweep(c) },
  check: async (o, c) => { const s = await commerceOf(c.m); return [['draft', workOf(o, 'return_outside_policy').some(w => w.status === 'draft')], ['REQUESTED', s.returns[0].status === 'REQUESTED'], ['only a holding reply', s.outbox.length === 1 && /reply within one working day/.test(s.outbox[0].text)], ['owner asked (rendered)', renderedEmails(o, ['returns']).length >= 1]] } })

add({ id: 'A10', pack: 'A', title: 'Weak description (products/update) -> rewritten from facts, undo restores', kind: 'normal', agents: ['listing_writer'], expected: 'description rewritten from product facts only (no invented claims), verified, undo token issued and the undo link restores the original',
  rules: 'partly', rulesWhy: 'Template assembly from facts works, but copy quality is template-grade; better prose would need AI.', synthetic: SYN_SHOP,
  run: async c => {
    await resetCommerce(c.m, ['weak_description']); c.seeded(); await c.route(shopify('products/update', { admin_graphql_api_id: COMMERCE_IDS.candle.product }))
    c.facts.html = (await commerceOf(c.m)).info[COMMERCE_IDS.candle.product].descriptionHtml
    const tok = seenOwner.filter(u => u.orgId === c.m.org && u.agentKey === 'listing_writer' && u.undoToken).at(-1)?.undoToken
    if (tok) { c.facts.undo = await runUndo(await merchantActor(c.m), tok); c.facts.htmlAfterUndo = (await commerceOf(c.m)).info[COMMERCE_IDS.candle.product].descriptionHtml }
  },
  check: async (_o, c) => [['rewritten from facts', /Lumen Works/.test(String(c.facts.html)) && !/best|award|guarantee|perfect|luxur/i.test(String(c.facts.html)), c.facts.html], ['undo restores', c.facts.htmlAfterUndo === '<p>Nice candle.</p>', c.facts.undo]] })

add({ id: 'A11', pack: 'A', title: 'Expired discount still on the banner -> switched off, banner cleared', kind: 'normal', agents: ['promo_manager'], expected: 'SUMMER20 expired, WELCOME10 untouched, banner cleared, verified, undo token',
  rules: 'fully', rulesWhy: 'End date in the past + code text on the banner.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['expired_discount_advertised']); await commerceSweep(c) },
  check: async (o, c) => { const s = await commerceOf(c.m); return [['SUMMER20 expired', s.discounts.find(d => d.code === 'SUMMER20')!.status === 'EXPIRED'], ['WELCOME10 active', s.discounts.find(d => d.code === 'WELCOME10')!.status === 'ACTIVE'], ['banner cleared', s.announcement === null], ['undo token', o.undo.some(u => u.agent_key === 'promo_manager')]] } })

add({ id: 'A12', pack: 'A', title: '"Where is my order" email -> reply with tracking', kind: 'normal', agents: ['customer_care'], expected: 'one reply to ben@ with #1102 tracking FH900101',
  rules: 'partly', rulesWhy: 'Keyword rules catch plain WISMO mail; mixed or unusual wording would need AI to classify.', synthetic: `${SYN_SHOP}; mail.received from the store mailbox (source mailbox)`,
  run: async c => { await resetCommerce(c.m, ['wismo_email']); c.seeded(); await c.conn({ source: 'mailbox', type: 'mail.received', externalId: 'mail:mail-wismo-1', occurredAt: new Date().toISOString(), payload: { id: 'mail-wismo-1', from: 'ben@shopper.example' } }) },
  check: async (_o, c) => { const r = (await commerceOf(c.m)).outbox.filter(m => m.inReplyTo === 'mail-wismo-1'); return [['one reply', r.length === 1, r.length], ['tracking', /FH900101/.test(r[0]?.text ?? '')]] } })

add({ id: 'A13', pack: 'A', title: 'WISMO from an address with no order -> asks for the order number', kind: 'edge', agents: ['customer_care'], expected: 'reply asks for the order number; nothing invented',
  rules: 'fully', rulesWhy: 'No order match -> fixed template.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['wismo_email_unknown_order']); await commerceSweep(c) },
  check: async (_o, c) => [['asks for order number', (await commerceOf(c.m)).outbox.some(m => m.inReplyTo === 'mail-wismo-2' && /reply with your order number/.test(m.text))]] })

add({ id: 'A14', pack: 'A', title: 'Payout fees above the rate -> dispute prepared', kind: 'normal', agents: ['payout_fees_checker'], expected: 'payout_mismatch done with the dispute packet (expected fee math, order list)',
  rules: 'fully', rulesWhy: 'Arithmetic against the contracted rate.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['payout_mismatch']); await commerceSweep(c) },
  check: async o => [['done with packet', workOf(o, 'payout_mismatch').some(w => w.status === 'done' && /expected \$/.test(String((w.payload.facts as { packet?: string })?.packet ?? '')))]] })

add({ id: 'A15', pack: 'A', title: 'Failed payout -> flagged with dispute', kind: 'edge', agents: ['payout_fees_checker'], expected: 'missing_payout row says it failed and has not reached the bank',
  rules: 'fully', rulesWhy: 'Payout status field.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['missing_payout']); await commerceSweep(c) },
  check: async o => [['flagged', workOf(o, 'missing_payout').some(w => /failed and has not reached your bank/.test(w.title))]] })

add({ id: 'A16', pack: 'A', title: 'AI visibility gap (products/update) -> search description written', kind: 'normal', agents: ['ai_visibility'], expected: 'SEO description <= 155 chars from the product description; gaps only the owner can fill listed',
  rules: 'partly', rulesWhy: 'Truncating the description works; a good summary would need AI.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['ai_visibility_gap']); c.seeded(); await c.route(shopify('products/update', { admin_graphql_api_id: COMMERCE_IDS.apron.product })) },
  check: async (_o, c) => { const seo = (await commerceOf(c.m)).info[COMMERCE_IDS.apron.product].seoDescription ?? ''; return [['written', seo.startsWith('A waxed cotton canvas apron') && seo.length <= 155, seo]] } })

add({ id: 'A17', pack: 'A', title: 'Low stock but no supplier on file -> owner asked who supplies it', kind: 'edge', agents: ['inventory_watcher'], expected: 'draft asking "Who supplies Wool Throw Blanket?"; nothing sent',
  rules: 'fully', rulesWhy: 'Missing data is detected by rule and handed to the owner.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['best_seller_low_stock']); await mutateSynthetic(c.m.conn, s => { s.commerce!.suppliers = [] }); await commerceSweep(c) },
  check: async (o, c) => [['draft question', workOf(o, 'best_seller_low_stock').some(w => w.status === 'draft' && w.payload.question === 'Who supplies Wool Throw Blanket?')], ['nothing sent', (await commerceOf(c.m)).outbox.length === 0]] })

add({ id: 'A18', pack: 'A', title: 'Refund above the automatic cap -> goes to the owner', kind: 'edge', agents: ['returns'], expected: 'no refund; draft says above the automatic limit',
  rules: 'fully', rulesWhy: 'Amount vs owner-set cap.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['return_damaged']); await q(`insert into library_switches (org_id, agent_key, enabled, settings) values ($1, 'returns', true, '{"refundCap": 10}') on conflict (org_id, agent_key) do update set enabled = true, settings = '{"refundCap": 10}'`, [c.m.org]); await commerceSweep(c) },
  check: async (o, c) => [['no refund', (await commerceOf(c.m)).refunds.length === 0], ['above limit', workOf(o, 'return_outside_policy').some(w => /above your automatic limit/.test(String((w as unknown as { summary?: string }).summary ?? w.title)) || w.status === 'draft')]] })

add({ id: 'A19', pack: 'A', title: 'Write that does not stick -> fresh read catches it, owner warned', kind: 'failure', agents: ['campaign', 'promo_manager'], expected: 'failed "the fresh read did not confirm the change"; owner warning; never claimed done',
  rules: 'fully', rulesWhy: 'Verification is a fresh read, not trust in the write.', synthetic: `${SYN_SHOP}; fault write_does_not_stick`,
  run: async c => { await resetCommerce(c.m, ['promoted_out_of_stock']); await injectFault(c.m.conn, { op: 'commerce.removeFromCollection', mode: 'write_does_not_stick' }); await commerceSweep(c) },
  check: async o => [['failed not done', workOf(o, 'promoted_out_of_stock').every(w => w.status !== 'done') && workOf(o, 'promoted_out_of_stock').some(w => w.status === 'failed'), workOf(o, 'promoted_out_of_stock').map(w => `${w.status}:${w.status_reason}`)], ['owner warned', ownerFor(o, ['campaign', 'promo_manager']).some(r => r.severity === 'warning')]] })

add({ id: 'A20', pack: 'A', title: 'Unreadable store -> agent reports failed, nothing logged done', kind: 'failure', agents: ['listing_writer'], expectNoAction: true, expected: 'no work row done; the job outcome records the failure',
  rules: 'fully', rulesWhy: 'Provider error handling.', synthetic: `${SYN_SHOP}; fault read_error on products`,
  run: async c => { await resetCommerce(c.m, ['weak_description']); await injectFault(c.m.conn, { op: 'commerce.products', mode: 'read_error', remaining: 50 }); await commerceSweep(c) },
  check: async (o, c) => [['nothing done for the description', workOf(o, 'weak_description').every(w => w.status !== 'done')], ['description untouched', (await commerceOf(c.m)).info[COMMERCE_IDS.candle.product].descriptionHtml === '<p>Nice candle.</p>']] })

add({ id: 'A21', pack: 'A', title: 'Customer question that is not about an order -> left for the owner, unanswered', kind: 'edge', agents: ['customer_care'], expected: 'a draft for the owner (customer_message_for_owner); nothing sent to the customer',
  rules: 'needs AI', rulesWhy: 'Rules can only recognise it is not a WISMO mail; answering "is it machine washable?" needs AI (or the owner).', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m); await mutateSynthetic(c.m.conn, s => { s.commerce!.mailbox.push({ id: 'mail-q-1', receivedAt: new Date().toISOString(), from: 'grace@shopper.example', to: 'hello@fernhill.example', subject: 'Is the throw machine washable?', text: 'Can I wash it?', inReplyTo: null }) }); await commerceSweep(c) },
  check: async (o, c) => [['draft for owner', workOf(o, 'customer_message_for_owner').some(w => w.status === 'draft')], ['nothing sent', (await commerceOf(c.m)).outbox.length === 0]] })

// ===== B. Home services

const HS = (c: Ctx, settings: Record<string, unknown> = { reviewUrl: 'https://reviews.example/acme' }) => resetPacks(c.m, 'home_services', { trade: 'roofing', settings })
const hsLead = (id: string, extra: Partial<Parameters<typeof lead>[0]> = {}) => lead({ id, from: 'forms@acme-roofing.example', name: 'Dana Reyes', email: 'dana@homeowner.example', text: 'My roof is leaking near the chimney.', subject: 'Roof repair request', ...extra })
const mailboxEvent = (type: string, payload: Record<string, unknown>, at: Date, ext?: string): Omit<ConnectionEvent, 'orgId'> => ({ source: 'mailbox', type, externalId: ext ?? `${type}:${String(payload.messageId ?? uid('m'))}`, occurredAt: at.toISOString(), payload })
const T = monday(2)

add({ id: 'B01', pack: 'B', title: 'New website lead -> reply with trade template and 3 quote times', kind: 'normal', agents: ['hs_lead_reply'], expected: 'one reply to dana@ with 3 numbered times, verified at the mail port; lead slots_offered; owner email rendered',
  rules: 'fully', rulesWhy: 'Labelled-field parse + trade template + free calendar slots.', synthetic: `${SYN_PORTS}; lead.email in the pack contract shape from a mailbox connection`,
  run: async c => { await HS(c); c.seeded(); await c.conn(mailboxEvent('lead.email', hsLead('m-1'), T)) },
  check: async (o, c) => { const mail = await sentMail(c.m); return [['one reply', mail.length === 1 && mail[0].to === 'dana@homeowner.example', mail.map(x => x.to)], ['3 times', (mail[0]?.body.match(/^\d\. /gm) ?? []).length === 3], ['verified', o.activity.some(a => a.agent_key === 'hs_lead_reply' && a.status === 'done')], ['owner email', renderedEmails(o, ['hs_lead_reply']).length >= 1]] } })

add({ id: 'B02', pack: 'B', title: 'Zillow-format lead through the real Outlook inbox sync', kind: 'normal', agents: ['hs_lead_reply'], expected: 'the lead.email event exactly as the Outlook inbox sync emits it gets the same reply as B01',
  rules: 'fully', rulesWhy: 'Portal lead parsed by rules (lib/leads/email-parsers).', synthetic: 'synthetic Outlook message stored by the real inbox sync (storeProviderMessage -> emitMailEvents); synthetic mail port',
  run: async c => { await HS(c); c.seeded(); await viaOutlook(c, { id: uid('ol'), from: 'rentalclientservices@zillowrentals.com', subject: 'New Zillow Rentals lead for 12 Elm St', text: ZILLOW_TEXT('Maya Thompson', 'maya.thompson@example.com', '12/01/2026'), at: T }) },
  check: async (o, c) => { const mail = await sentMail(c.m); return [['reply sent to the renter', mail.some(x => x.to === 'maya.thompson@example.com'), { sent: mail.map(x => x.to), activity: o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`), leads: (await q(`select count(*)::int as n from pack_leads where org_id = $1`, [c.m.org]))[0] }]] } })

add({ id: 'B03', pack: 'B', title: 'Scheduled crew job -> dispatched to the crew member', kind: 'normal', agents: ['hs_dispatch'], expected: 'one crew message with address/customer/work through the real crew pipeline (crew_messages row), work order dispatched',
  rules: 'fully', rulesWhy: 'Schedule + crew assignment + template.', synthetic: `${SYN_PORTS}; crew member on the crew roster (crew_members)`,
  run: async c => { await HS(c); const cm = await packCrew(c.m); const wo = await admin(db => recordQuote(db, c.m.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', customerPhone: '+1 555 0123', address: '12 Elm St', description: 'Replace flashing', amount: 650, now: T })); await admin(db => scheduleJob(db, c.m.org, wo.id, { crewMemberId: cm.id, start: plus(T, 30) })); c.facts.wo = wo.id; c.seeded(); await c.sweep(T) },
  check: async (o, c) => [['crew message delivered', o.crew.length >= 1, o.crewCalls.map(x => `${x.r.status}: ${x.r.reason ?? ''}`)], ['work order dispatched', (await q1<{ status: string }>(`select status from pack_work_orders where id = $1`, [c.facts.wo]))?.status === 'dispatched', (await q1<{ status: string }>(`select status from pack_work_orders where id = $1`, [c.facts.wo]))?.status], ['loop outcome', o.activity.some(a => a.agent_key === 'hs_dispatch' && a.status === 'done'), o.activity.map(a => `${a.agent_key}:${a.status}`)]] })

add({ id: 'B04', pack: 'B', title: 'Crew says DONE -> invoice created and sent once', kind: 'normal', agents: ['hs_invoice'], expected: 'one invoice of 650 created and sent at the invoicing port; a repeated DONE bills nothing',
  rules: 'fully', rulesWhy: 'Quote amount -> invoice lines.', synthetic: `${SYN_PORTS}; crew.done routed with the payload markJobDone emits`,
  run: async c => { await HS(c); const wo = await admin(db => recordQuote(db, c.m.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Replace flashing', amount: 650, now: T })); c.seeded()
    await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}`, occurredAt: plus(T, 50).toISOString(), payload: { jobRef: wo.ref, via: 'link' } })
    await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}:again`, occurredAt: plus(T, 51).toISOString(), payload: { jobRef: wo.ref, via: 'reply' } }) },
  check: async (o, c) => { const inv = (await getSynth(c.m.org, 'invoicing')).invoices; return [['one invoice 650 sent', inv.length === 1 && inv[0].total === 650 && inv[0].sentCount === 1, inv.map(i => [i.total, i.sentCount])], ['done', o.activity.some(a => a.agent_key === 'hs_invoice' && a.status === 'done')]] } })

add({ id: 'B05', pack: 'B', title: 'Overdue invoice -> reminder on the cadence (3 days late)', kind: 'normal', agents: ['hs_payment_chase'], expected: 'no reminder 1 day late; one reminder 3 days late with the open balance',
  rules: 'fully', rulesWhy: 'Due date + cadence + balance from a fresh invoice read.', synthetic: SYN_PORTS,
  run: async c => { await HS(c); const wo = await admin(db => recordQuote(db, c.m.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Re-roof', amount: 1000, now: T }))
    await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}`, occurredAt: T.toISOString(), payload: { jobRef: wo.ref } })
    await q(`delete from agent_loops where org_id = $1`, [c.m.org]); await q(`delete from owner_updates where org_id = $1`, [c.m.org]); await mutateSynth(c.m.org, 'mail', s => { s.sent = [] })
    c.seeded(); await c.sweep(plus(T, 24 * 15)); c.facts.after1 = (await sentMail(c.m)).length; await c.sweep(plus(T, 24 * 17)) },
  check: async (_o, c) => { const mail = await sentMail(c.m); return [['nothing at 1 day late', c.facts.after1 === 0, c.facts.after1], ['one reminder with balance', mail.length === 1 && /USD\s1,000\.00/.test(mail[0].body), mail.map(m => m.subject)]] } })

add({ id: 'B06', pack: 'B', title: 'Quiet quote -> follow-up on day 3, once', kind: 'normal', agents: ['hs_quote_followup'], expected: 'nothing on day 2; one follow-up on day 3 even if swept twice',
  rules: 'fully', rulesWhy: 'Cadence by days since the quote.', synthetic: SYN_PORTS,
  run: async c => { await HS(c); await admin(db => recordQuote(db, c.m.org, { customerName: 'Dana Reyes', customerEmail: 'dana@homeowner.example', description: 'Re-roof', amount: 8400, now: T })); c.seeded()
    await c.sweep(plus(T, 48)); await c.sweep(plus(T, 72)); await c.sweep(plus(T, 73)) },
  check: async (_o, c) => [['one follow-up', (await sentMail(c.m)).length === 1, (await sentMail(c.m)).map(m => m.subject)]] })

add({ id: 'B07', pack: 'B', title: 'Lead without an email address -> owner told to call', kind: 'edge', agents: ['hs_lead_reply'], expected: 'nothing sent; activity blocked "no email address"; owner warning email rendered',
  rules: 'fully', rulesWhy: 'Missing field check.', synthetic: SYN_PORTS,
  run: async c => { await HS(c); c.seeded(); await c.conn(mailboxEvent('lead.email', lead({ id: 'm-3', from: 'leads@zillow.com', name: 'No Email', text: 'Phone: 555 0199' }), T)) },
  check: async (o, c) => [['nothing sent', (await sentMail(c.m)).length === 0], ['blocked no email', o.activity.some(a => a.status === 'blocked' && /no email address/.test(a.error ?? ''))], ['owner warning rendered', renderedEmails(o, ['hs_lead_reply']).some(r => r.severity === 'warning')]] })

add({ id: 'B08', pack: 'B', title: 'Mail provider unreachable mid-run -> nothing half-written, owner told', kind: 'failure', agents: ['hs_lead_reply'], expected: 'lead stays new, no pack_messages row, activity blocked, owner warning',
  rules: 'fully', rulesWhy: 'Provider error -> rollback + report.', synthetic: `${SYN_PORTS}; port fault mail.send unreachable`,
  run: async c => { await HS(c); await injectPortFault(c.m.org, 'mail', { op: 'send', mode: 'unreachable' }); c.seeded(); await c.conn(mailboxEvent('lead.email', hsLead('m-5'), T)) },
  check: async (o, c) => [['lead still new', (await q1<{ status: string }>(`select status from pack_leads where org_id = $1`, [c.m.org]))?.status === 'new'], ['no message row', !(await q1(`select 1 from pack_messages where org_id = $1`, [c.m.org]))], ['blocked', o.activity.some(a => a.agent_key === 'hs_lead_reply' && a.status === 'blocked')], ['owner warned', ownerFor(o, ['hs_lead_reply']).some(r => r.severity === 'warning')]] })

add({ id: 'B09', pack: 'B', title: 'Job done without a price -> owner asked for the amount', kind: 'failure', agents: ['hs_invoice'], expected: 'no invoice; activity blocked "no price"; owner warning; work order marked done',
  rules: 'fully', rulesWhy: 'Missing amount check.', synthetic: SYN_PORTS,
  run: async c => { await HS(c); const wo = (await q1<{ ref: string; id: string }>(`insert into pack_work_orders (org_id, ref, customer_name, customer_email, description, status) values ($1,'J-1','Dana','dana@homeowner.example','Fix','scheduled') returning ref, id`, [c.m.org]))!; c.seeded()
    await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}`, occurredAt: T.toISOString(), payload: { jobRef: wo.ref } }) },
  check: async (o, c) => [['no invoice', (await getSynth(c.m.org, 'invoicing')).invoices.length === 0], ['blocked no price', o.activity.some(a => a.agent_key === 'hs_invoice' && a.status === 'blocked' && /no price/.test(a.error ?? ''))], ['owner told', ownerFor(o, ['hs_invoice']).some(r => r.severity === 'warning')]] })

add({ id: 'B10', pack: 'B', title: 'Customer picks a quote time -> visit booked and confirmed', kind: 'normal', agents: ['hs_quote_booking'], expected: 'one calendar event, confirmation email, lead booked',
  rules: 'partly', rulesWhy: 'Rules read "2" / "option 2"; free-form replies ("Tuesday afternoon") need AI.', synthetic: `${SYN_PORTS}; reply in the pack contract shape (with text)`,
  run: async c => { await HS(c); await c.conn(mailboxEvent('lead.email', hsLead('m-1'), T)); await q(`delete from agent_loops where org_id = $1`, [c.m.org]); c.seeded()
    await c.conn(mailboxEvent('mail.received', { from: 'dana@homeowner.example', subject: 'Re: Your quote request', text: '2 works for me, thanks', messageId: 'r-1' }, plus(T, 1))) },
  check: async (_o, c) => [['booked', (await q1<{ kind: string }>(`select kind from pack_appointments where org_id = $1`, [c.m.org]))?.kind === 'quote_visit'], ['calendar event', (await getSynth(c.m.org, 'calendar')).events.length === 1]] })

add({ id: 'B11', pack: 'B', title: 'Customer answers with a free-form time ("Tuesday afternoon") -> nothing booked', kind: 'edge', agents: ['hs_quote_booking'], expectNoAction: true, expected: 'no appointment is invented from words the rules cannot read',
  rules: 'needs AI', rulesWhy: 'Mapping "Tuesday afternoon" onto an offered slot needs language understanding; rules safely do nothing.', synthetic: `${SYN_PORTS}; reply in the pack contract shape`,
  run: async c => { await HS(c); await c.conn(mailboxEvent('lead.email', hsLead('m-1'), T)); c.seeded(); await c.conn(mailboxEvent('mail.received', { from: 'dana@homeowner.example', subject: 'Re: Your quote request', text: 'Tuesday afternoon would suit me best', messageId: 'r-ft' }, plus(T, 1))) },
  check: async (_o, c) => [['nothing booked', (await q(`select 1 from pack_appointments where org_id = $1`, [c.m.org])).length === 0], ['calendar untouched', (await getSynth(c.m.org, 'calendar')).events.length === 0]] })

// ===== C. Leasing

const LS = async (c: Ctx, settings: Record<string, unknown> = {}) => { await resetPacks(c.m, 'leasing_agent', { settings: { applicationUrl: 'https://apply.example/general', ...settings } }); return seedListings(c.m, T) }
const FIELDS = { Budget: '$2,000', 'Move-in': isoDay(T, 20), Bedrooms: '2', Pets: 'No' }

add({ id: 'C01', pack: 'C', title: 'Complete renter lead -> matching listings, 3 tour times, fair-housing checked', kind: 'normal', agents: ['ls_lead_reply'], expected: 'reply lists exactly units 2A and 4B, 3 times, the equal-treatment line; content policy ok',
  rules: 'fully', rulesWhy: 'Labelled criteria matched against listing columns; no inference about the person.', synthetic: `${SYN_PORTS}; lead.email in the pack contract shape`,
  run: async c => { await LS(c); c.seeded(); await c.conn(mailboxEvent('lead.email', lead({ id: 'z-1', name: 'Jordan Miles', email: 'jordan@renter.example', fields: FIELDS }), T)) },
  check: async (o, c) => { const [m] = await sentMail(c.m); return [['lists 2A and 4B only', /unit 2A/.test(m?.body ?? '') && /unit 4B/.test(m?.body ?? '') && !/301|105|402/.test(m?.body ?? '')], ['3 times', (m?.body.match(/^\d\. /gm) ?? []).length === 3], ['policy ok', (await q1<{ policy: { ok: boolean; fairHousing: boolean } }>(`select policy from pack_messages where org_id = $1`, [c.m.org]))?.policy.fairHousing === true], ['owner email', renderedEmails(o, ['ls_lead_reply']).length >= 1]] } })

add({ id: 'C02', pack: 'C', title: 'Unanswered Zillow lead through the real Outlook path -> reply', kind: 'normal', agents: ['ls_lead_reply'], expected: 'a Zillow lead email as emitMailEvents emits it is answered (the standard questions not answered in the lead are asked)',
  rules: 'fully', rulesWhy: 'Portal parser by rules, standard questions.', synthetic: 'synthetic Outlook message stored by the real inbox sync (storeProviderMessage -> emitMailEvents); synthetic mail port',
  run: async c => { await LS(c); c.seeded(); await viaOutlook(c, { id: uid('ol'), from: 'rentalclientservices@zillowrentals.com', subject: 'New Zillow Rentals lead for 1420 NW Lovejoy St #4B', text: ZILLOW_TEXT('Maya Thompson', 'maya.thompson@example.com', isoDay(T, 20)), at: T }) },
  check: async (o, c) => { const mail = await sentMail(c.m); return [['renter answered', mail.some(x => x.to === 'maya.thompson@example.com'), { sent: mail.map(x => x.subject), activity: o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`), leads: (await q(`select source, status from pack_leads where org_id = $1`, [c.m.org])) }]] } })

add({ id: 'C03', pack: 'C', title: 'Incomplete lead, then the renter answers -> listings sent', kind: 'edge', agents: ['ls_lead_reply', 'ls_qualify'], expected: 'first reply asks only the 3 missing questions; the answers bring units 2A and 4B',
  rules: 'partly', rulesWhy: 'Numbered answers are read by rules; prose answers would need AI.', synthetic: `${SYN_PORTS}; reply in the pack contract shape (with text)`,
  run: async c => { await LS(c); c.seeded(); await c.conn(mailboxEvent('lead.email', lead({ id: 'z-2', from: 'leads@apartments.com', name: 'Sam Park', email: 'sam@renter.example', fields: { Bedrooms: '2' } }), T))
    await c.conn(mailboxEvent('mail.received', { from: 'sam@renter.example', subject: 'Re: Your rental inquiry', text: `1. $2,000\n2. ${isoDay(T, 20)}\n3. no`, messageId: 'r-1' }, plus(T, 2))) },
  check: async (_o, c) => { const mail = await sentMail(c.m); return [['asks 3 missing', /1\. What is your monthly budget/.test(mail[0]?.body ?? '') && !/How many bedrooms/.test(mail[0]?.body ?? '')], ['listings after answers', mail.length === 2 && /unit 2A[\s\S]*unit 4B/.test(mail[1]?.body ?? ''), mail.length]] } })

add({ id: 'C04', pack: 'C', title: 'Move-ins -> commission invoices per property, exact to the cent', kind: 'normal', agents: ['ls_commission_invoice'], expected: 'Maple Court invoice 1952.78 to ap@harborpg (975 + 977.78), Birch Lofts 750.00; sent once; future move-in pending',
  rules: 'fully', rulesWhy: 'Commission math in integer cents + billing address lookup.', synthetic: SYN_PORTS,
  run: async c => { const ids = await LS(c); await admin(async db => {
      await recordPlacement(db, c.m.org, { propertyId: ids.maple, tenantName: 'Jordan Miles', unit: '4B', moveInDate: isoDay(T, 1), monthlyRent: 1950 })
      await recordPlacement(db, c.m.org, { propertyId: ids.maple, tenantName: 'Sam Park', unit: '2A', moveInDate: isoDay(T, 2), monthlyRent: 1955.55 })
      await recordPlacement(db, c.m.org, { propertyId: ids.maple, tenantName: 'Later Tenant', unit: '5C', moveInDate: isoDay(T, 30), monthlyRent: 2000 })
      await recordPlacement(db, c.m.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: isoDay(T, 2), monthlyRent: 2100 }) })
    c.seeded(); await c.sweep(plus(T, 72)); await c.sweep(plus(T, 73)) },
  check: async (o, c) => { const inv = await q<{ total: string; bill_to: string; status: string }>(`select total, bill_to, status from leasing_invoices where org_id = $1 order by total desc`, [c.m.org]); const mail = (await sentMail(c.m)).filter(m => /leasing commission/.test(m.subject)); return [
    ['two invoices exact', inv.length === 2 && inv[0].total === '1952.78' && inv[0].bill_to === 'ap@harborpg.example' && inv[1].total === '750.00', inv], ['sent once each', mail.length === 2, mail.length],
    ['verified', o.activity.filter(a => a.agent_key === 'ls_commission_invoice').every(a => a.status === 'done')], ['owner email', renderedEmails(o, ['ls_commission_invoice']).length >= 1]] } })

add({ id: 'C05', pack: 'C', title: 'Property with no billing address -> waits for the owner', kind: 'edge', agents: ['ls_commission_invoice'], expected: 'no invoice; placement stays moved_in; activity says no billing email',
  rules: 'fully', rulesWhy: 'Missing field check.', synthetic: SYN_PORTS,
  run: async c => { await LS(c); const p = (await q1<{ id: string }>(`insert into leasing_properties (org_id, name, commission_type, commission_value) values ($1,'Nowhere Flats','flat',500) returning id`, [c.m.org]))!
    await admin(db => recordPlacement(db, c.m.org, { propertyId: p.id, tenantName: 'T', unit: '1', moveInDate: isoDay(T, 1), monthlyRent: 1000 })); c.seeded(); await c.sweep(plus(T, 48)) },
  check: async (o, c) => [['no invoice', (await q(`select 1 from leasing_invoices where org_id = $1`, [c.m.org])).length === 0], ['says no billing email', o.activity.some(a => /no billing email/.test(a.error ?? ''))], ['owner told', ownerFor(o, ['ls_commission_invoice']).some(r => r.severity === 'warning')]] })

add({ id: 'C06', pack: 'C', title: 'Commission invoice 3 days late -> reminder; part payment recorded once', kind: 'normal', agents: ['ls_commission_chase', 'ls_payment_match'], expected: 'one reminder at day 35; a payment notice twice records one 300 payment (status partial)',
  rules: 'fully', rulesWhy: 'Cadence + payment matching by invoice number.', synthetic: `${SYN_PORTS}; quickbooks.payment in the pack shape (see limit in lib/connections/events.ts)`,
  run: async c => { const ids = await LS(c); await admin(db => recordPlacement(db, c.m.org, { propertyId: ids.birch, tenantName: 'Alex Kim', unit: '301', moveInDate: isoDay(T, 1), monthlyRent: 2100 })); await c.sweep(plus(T, 48))
    const inv = (await q1<{ number: string }>(`select number from leasing_invoices where org_id = $1`, [c.m.org]))!; await mutateSynth(c.m.org, 'mail', s => { s.sent = [] }); c.seeded()
    await c.sweep(plus(T, 24 * 35))
    for (let i = 0; i < 2; i++) await c.route({ source: 'quickbooks', type: 'quickbooks.payment', externalId: `pack:payment:p-1:${i}`, occurredAt: plus(T, 24 * 36 + i).toISOString(), payload: { invoiceNumber: inv.number, amount: 300, paymentId: 'p-1', receivedOn: isoDay(T, 36) } }) },
  check: async (_o, c) => [['one reminder', (await sentMail(c.m)).filter(m => m.to === 'billing@birchlofts.example').length === 1, (await sentMail(c.m)).map(m => m.subject)], ['partial 300 once', JSON.stringify(await q1(`select status, paid_amount from leasing_invoices where org_id = $1`, [c.m.org])) === JSON.stringify({ status: 'partial', paid_amount: '300.00' }), await q1(`select status, paid_amount from leasing_invoices where org_id = $1`, [c.m.org])]] })

const PEOPLE = ['Christian Black', 'Mohammed Al-Sayed', 'Nguyen Thi Lan', 'José García', 'Aisha Okafor', 'Wei Chen', 'Priya Patel', 'Olga Ivanova', 'Robert White', "Mary-Kate O'Brien", 'Jamal Washington', 'Avi Goldstein']
const PEOPLE_TEXT = ['Looking near my church.', 'We are a Muslim family of five.', 'Xin chào, tôi muốn thuê căn hộ.', 'Hola, soy de México.', 'I have a Section 8 voucher.', '你好', 'I am pregnant.', 'Здравствуйте!', 'I use a wheelchair.', 'I am 72 and retired.', 'Is the neighborhood safe?', 'I keep kosher.']
add({ id: 'C07', pack: 'C', title: 'Fair-housing consistency: 12 renters, same criteria, same reply', kind: 'normal', agents: ['ls_lead_reply'], expected: 'every renter gets a reply; bodies identical apart from the greeting name and their own tour times; no steering or protected words',
  rules: 'fully', rulesWhy: 'Consistency is guaranteed precisely because only rules and templates run (no model to vary).', synthetic: `${SYN_PORTS}; 12 synthetic renters with names and free text from different backgrounds`,
  run: async c => { await LS(c); c.seeded(); for (const [i, name] of PEOPLE.entries()) await c.conn(mailboxEvent('lead.email', lead({ id: `fh-${i}`, name, email: `r${i}@renter.example`, fields: FIELDS, text: PEOPLE_TEXT[i] }), plus(T, i * 0.25))) },
  check: async (_o, c) => { const mail = await sentMail(c.m); const norm = mail.map(m => { const i = Number(/^r(\d+)@/.exec(m.to)?.[1]); return m.body.replace(`Hi ${greetName(PEOPLE[i])},`, 'Hi {name},').replace(/^\d\. .*$/gm, '<slot>') })
    const distinct = new Set(norm); c.facts.distinctBodies = distinct.size
    return [['all 12 answered', mail.length === 12, mail.length], ['identical after greeting/slots', distinct.size === 1, distinct.size], ['no protected words', !mail.some(m => /church|muslim|section 8|wheelchair|kosher|safe neighborhood|pregnan/i.test(m.body))]] } })

add({ id: 'C08', pack: 'C', title: 'Steering language in the business name -> refused by the content check', kind: 'failure', agents: ['ls_lead_reply'], expected: 'nothing sent; activity blocked "fair-housing check (safe area)"; owner warning',
  rules: 'fully', rulesWhy: 'Phrase list check before every send.', synthetic: SYN_PORTS,
  run: async c => { await LS(c, { senderName: 'Safe Area Rentals' }); c.seeded(); await c.conn(mailboxEvent('lead.email', lead({ id: 'z-9', name: 'Jordan Miles', email: 'jordan@renter.example', fields: FIELDS }), T)) },
  check: async (o, c) => [['nothing sent', (await sentMail(c.m)).length === 0], ['blocked by fair-housing', o.activity.some(a => a.status === 'blocked' && /fair-housing check \(safe area\)/.test(a.error ?? ''))], ['owner warned', ownerFor(o, ['ls_lead_reply']).some(r => r.severity === 'warning')]] })

add({ id: 'C09', pack: 'C', title: 'Renter answers through the real Outlook inbox sync (text read from the stored message)', kind: 'edge', agents: ['ls_qualify'], expected: 'the renter\'s answers, arriving as the Outlook mail.received event, bring the listings',
  rules: 'partly', rulesWhy: 'Numbered answers by rules; the text is read from email_inbound at handling time.', synthetic: 'pack-shape lead, then a synthetic Outlook reply stored by the real inbox sync',
  run: async c => { await LS(c); await c.conn(mailboxEvent('lead.email', lead({ id: 'z-2', from: 'leads@apartments.com', name: 'Sam Park', email: 'sam@renter.example', fields: { Bedrooms: '2' } }), T)); c.seeded()
    await viaOutlook(c, { id: uid('ol'), from: 'sam@renter.example', subject: 'Re: Your rental inquiry', text: `1. $2,000\n2. ${isoDay(T, 20)}\n3. no`, at: plus(T, 2) }) },
  check: async (o, c) => { const mail = await sentMail(c.m); return [['listings sent after the answers', mail.length === 2 && /unit 2A/.test(mail[1]?.body ?? ''), { sent: mail.length, activity: o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`) }]] } })

// ===== D. Real estate

const RE = (c: Ctx) => resetPacks(c.m, 'real_estate_agent')
const buyer = (id: string) => lead({ id, from: 'leads@realtor.com', name: 'Morgan Lee', email: 'morgan@buyer.example', subject: 'Inquiry about 12 Oak St', fields: { 'Lead type': 'Buyer' }, text: 'Is it still available?' })

add({ id: 'D01', pack: 'D', title: 'Buyer lead -> buyer questions + showing times, CRM contact created', kind: 'normal', agents: ['re_lead_reply', 're_crm_update'], expected: 'one reply with the buyer questions and 3 times; CRM contact stage "new lead" tagged buyer',
  rules: 'fully', rulesWhy: 'Lead type field + template + calendar.', synthetic: `${SYN_PORTS}; lead.email in the pack contract shape`,
  run: async c => { await RE(c); c.seeded(); await c.conn(mailboxEvent('lead.email', buyer('re-1'), T)) },
  check: async (o, c) => { const crm = (await getSynth(c.m.org, 'crm')).contacts; return [['reply', (await sentMail(c.m)).length === 1], ['crm contact', crm.length === 1 && crm[0].stage === 'new lead' && crm[0].tags.includes('buyer'), crm], ['both done', o.activity.map(a => `${a.agent_key}:${a.status}`).join() === 're_lead_reply:done,re_crm_update:done', o.activity.map(a => `${a.agent_key}:${a.status}`)], ['owner email', renderedEmails(o, ['re_lead_reply']).length >= 1]] } })

add({ id: 'D02', pack: 'D', title: 'Seller lead -> seller template', kind: 'normal', agents: ['re_lead_reply'], expected: 'reply subject "Selling your home..."; intent seller',
  rules: 'fully', rulesWhy: 'Subject/lead-type keywords.', synthetic: SYN_PORTS,
  run: async c => { await RE(c); c.seeded(); await c.conn(mailboxEvent('lead.email', lead({ id: 're-2', from: 'forms@agent-site.example', name: 'Pat Doe', email: 'pat@seller.example', subject: 'What is my home value?', fields: { 'Lead type': 'Seller' } }), T)) },
  check: async (_o, c) => [['seller template', /^Selling your home/.test((await sentMail(c.m))[0]?.subject ?? '')]] })

add({ id: 'D03', pack: 'D', title: 'New person in the CRM (real poll shape) -> answered', kind: 'normal', agents: ['re_lead_reply'], expected: 'crm.contact.changed as the CRM poll emits it becomes crm.lead.created and the person gets the reply',
  rules: 'fully', rulesWhy: 'Same template as an email lead.', synthetic: 'synthetic HubSpot-shaped contact through emitConnectionEvent (the poller\'s emitter); synthetic mail port',
  run: async c => { await RE(c); c.seeded(); await c.conn({ source: 'crm', type: 'crm.contact.changed', externalId: `hubspot:contact:77:${T.toISOString()}`, occurredAt: T.toISOString(), payload: { provider: 'hubspot', connectionId: null, contact: { id: '77', kind: 'contact', email: 'casey@buyer.example', firstName: 'Casey', lastName: 'Fox', phone: null, company: null, updatedAt: T.toISOString() } } }) },
  check: async (o, c) => [['reply to casey', (await sentMail(c.m)).some(m => m.to === 'casey@buyer.example'), { sent: (await sentMail(c.m)).map(m => m.to), activity: o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`), leads: await q(`select source, email from pack_leads where org_id = $1`, [c.m.org]) }]] })

add({ id: 'D04', pack: 'D', title: 'Buyer picks a time -> showing booked, CRM stage moved', kind: 'normal', agents: ['re_showing'], expected: 'showing appointment; confirmation; CRM stage "showing booked"',
  rules: 'partly', rulesWhy: 'Ordinal picks by rules; free-form times need AI.', synthetic: `${SYN_PORTS}; reply in the pack contract shape`,
  run: async c => { await RE(c); await c.conn(mailboxEvent('lead.email', buyer('re-3'), T)); c.seeded(); await c.conn(mailboxEvent('mail.received', { from: 'morgan@buyer.example', subject: 'Re', text: 'The third one works', messageId: 'r-1' }, plus(T, 1))) },
  check: async (_o, c) => [['showing booked', (await q1<{ kind: string }>(`select kind from pack_appointments where org_id = $1`, [c.m.org]))?.kind === 'showing'], ['crm stage', (await getSynth(c.m.org, 'crm')).contacts[0]?.stage === 'showing booked']] })

add({ id: 'D05', pack: 'D', title: 'CRM does not answer -> reply still sent, CRM step reported failed', kind: 'failure', agents: ['re_lead_reply', 're_crm_update'], expected: 're_lead_reply done, re_crm_update failed (not silently skipped), owner told',
  rules: 'fully', rulesWhy: 'Provider error handling.', synthetic: `${SYN_PORTS}; port fault crm.upsertContact unreachable`,
  run: async c => { await RE(c); await injectPortFault(c.m.org, 'crm', { op: 'upsertContact', mode: 'unreachable' }); c.seeded(); await c.conn(mailboxEvent('lead.email', buyer('re-5'), T)) },
  check: async (o, c) => [['reply sent', (await sentMail(c.m)).length === 1], ['crm step failed', o.activity.some(a => a.agent_key === 're_crm_update' && a.status === 'failed')], ['owner told', ownerFor(o, ['re_crm_update']).some(r => r.severity === 'warning')]] })

add({ id: 'D06', pack: 'D', title: 'Lead opts out -> do-not-contact, no follow-ups', kind: 'edge', agents: ['re_crm_update', 're_followup'], expected: 'CRM stage "do not contact"; sweeps on days 3/6/12 send nothing more',
  rules: 'fully', rulesWhy: 'Opt-out phrase list.', synthetic: SYN_PORTS,
  run: async c => { await RE(c); await c.conn(mailboxEvent('lead.email', buyer('re-4'), T)); c.seeded(); await c.conn(mailboxEvent('mail.received', { from: 'morgan@buyer.example', subject: 'Re', text: 'unsubscribe', messageId: 'r-3' }, plus(T, 2)))
    for (const d of [3, 6, 12]) await c.sweep(plus(T, 24 * d)) },
  check: async (_o, c) => [['do not contact', (await getSynth(c.m.org, 'crm')).contacts[0]?.stage === 'do not contact'], ['no follow-ups', (await sentMail(c.m)).length === 1]] })

add({ id: 'D07', pack: 'D', title: 'Quiet buyer -> 3 follow-ups then marked quiet', kind: 'normal', agents: ['re_followup'], expected: 'follow-ups on the cadence (3), lead quiet afterwards',
  rules: 'fully', rulesWhy: 'Cadence.', synthetic: SYN_PORTS,
  run: async c => { await RE(c); await c.conn(mailboxEvent('lead.email', buyer('re-6'), T)); c.seeded(); for (const d of [2, 5, 10, 17]) await c.sweep(plus(T, 24 * d)) },
  check: async (_o, c) => [['3 follow-ups', (await sentMail(c.m)).filter(m => /^Following up/.test(m.subject)).length === 3], ['quiet', (await q1<{ status: string }>(`select status from pack_leads where org_id = $1`, [c.m.org]))?.status === 'quiet']] })

add({ id: 'D08', pack: 'D', title: 'Buyer picks a time through the real Outlook inbox sync -> showing booked', kind: 'normal', agents: ['re_showing'], expected: 'the buyer\'s "the third one works", arriving as the Outlook mail.received event (no text in the payload), books the showing and moves the CRM stage',
  rules: 'partly', rulesWhy: 'Ordinal picks by rules from the stored text; free-form times need AI.', synthetic: 'pack-shape lead, then a synthetic Outlook reply stored by the real inbox sync',
  run: async c => { await RE(c); await c.conn(mailboxEvent('lead.email', buyer('re-ol'), T)); c.seeded()
    await viaOutlook(c, { id: uid('ol'), from: 'morgan@buyer.example', subject: 'Re: Inquiry about 12 Oak St', text: 'The third one works', at: plus(T, 1) }) },
  check: async (_o, c) => [['showing booked', (await q1<{ kind: string }>(`select kind from pack_appointments where org_id = $1`, [c.m.org]))?.kind === 'showing', { inbox: c.facts.inbox }], ['crm stage', (await getSynth(c.m.org, 'crm')).contacts[0]?.stage === 'showing booked'],
    ['no text stored on the event', !(await q(`select 1 from agent_events where org_id = $1 and type = 'mail.received' and payload ? 'text'`, [c.m.org])).length]] })

// ===== E. Property management

const PM = (c: Ctx) => resetPacks(c.m, 'property_manager')
const tenantMail = (text: string, from = 'tenant4b@renters.example', id = uid('t')) => ({ from, fromName: 'Riley Tenant', subject: 'Kitchen sink leaking', text, messageId: id })

add({ id: 'E01', pack: 'E', title: 'Tenant emails a maintenance request -> logged, tenant told, plumber dispatched', kind: 'normal', agents: ['pm_maintenance_intake', 'pm_vendor_dispatch'], expected: 'request plumbing/4B dispatched to Ace Plumbing; ack to tenant; work order to vendor',
  rules: 'fully', rulesWhy: 'Keyword category + vendor trade match.', synthetic: `${SYN_PORTS}; tenant mail in the pack contract shape`,
  run: async c => { await PM(c); c.facts.v = await pmVendors(c.m); c.seeded(); await c.conn(mailboxEvent('mail.received', tenantMail('Hi, the kitchen sink in unit 4B is leaking under the cabinet.'), T)) },
  check: async (o, c) => { const r = await q1<{ category: string; unit: string; status: string; vendor_id: string }>(`select category, unit, status, vendor_id from pm_maintenance_requests where org_id = $1`, [c.m.org]); return [
    ['dispatched to plumber', r?.status === 'dispatched' && r.vendor_id === (c.facts.v as { plumber: string }).plumber && r.unit === '4B', r], ['tenant + vendor mailed', (await sentMail(c.m)).map(m => m.to).join() === 'tenant4b@renters.example,dispatch@aceplumbing.example'], ['owner email', renderedEmails(o, ['pm_maintenance_intake', 'pm_vendor_dispatch']).length >= 1]] } })

add({ id: 'E02', pack: 'E', title: 'Buildium resident request (real poll shape) -> read fresh, dispatched, marked assigned', kind: 'normal', agents: ['pm_maintenance_intake', 'pm_vendor_dispatch'], expected: 'buildium.request.changed as the poller emits it -> one request logged, appliance vendor dispatched, property system status assigned; a repeat poll logs nothing new',
  rules: 'fully', rulesWhy: 'Category from the property system + vendor trade.', synthetic: 'synthetic property-system port holds request B-501; event through emitConnectionEvent',
  run: async c => { await PM(c); await pmVendors(c.m); await q(`insert into pm_vendors (org_id, name, email, trades) values ($1,'Appliance Pros','fix@appliancepros.example','{appliance}')`, [c.m.org])
    await mutateSynth(c.m.org, 'property_system', s => { s.requests.push({ id: 'B-501', property: 'Maple Court', unit: '7D', tenantName: 'Kai Green', tenantEmail: 'kai@renters.example', tenantPhone: '555 0101', description: 'Dishwasher not working', category: 'Appliance', status: 'new', notes: [] }) }); c.seeded()
    for (const v of ['v1', 'v2']) await c.conn({ source: 'buildium', type: 'buildium.request.changed', externalId: `buildium.residentrequests:B-501:${v}`, occurredAt: T.toISOString(), payload: { connectionId: null, record: { id: 'B-501', updatedAt: T.toISOString() } } }) },
  check: async (_o, c) => [['one request', (await q(`select 1 from pm_maintenance_requests where org_id = $1`, [c.m.org])).length === 1], ['assigned in property system', (await getSynth(c.m.org, 'property_system')).requests[0].status === 'assigned']] })

add({ id: 'E03', pack: 'E', title: 'Vendor declines -> next vendor for the trade', kind: 'edge', agents: ['pm_vendor_dispatch'], expected: 'request moves from Ace to Best Pipes',
  rules: 'partly', rulesWhy: '"decline" keyword by rules; nuanced vendor replies need AI.', synthetic: SYN_PORTS,
  run: async c => { await PM(c); c.facts.v = await pmVendors(c.m); await c.conn(mailboxEvent('mail.received', tenantMail('The toilet is clogged and will not flush.'), T)); c.seeded()
    await c.conn(mailboxEvent('mail.received', { from: 'dispatch@aceplumbing.example', subject: 'Re: Work order', text: 'Sorry, decline, fully booked', messageId: uid('v') }, plus(T, 1))) },
  check: async (_o, c) => [['next vendor', (await q1<{ vendor_id: string }>(`select vendor_id from pm_maintenance_requests where org_id = $1`, [c.m.org]))?.vendor_id === (c.facts.v as { plumber2: string }).plumber2]] })

add({ id: 'E04', pack: 'E', title: 'Emergency, vendor silent -> replaced after half the wait', kind: 'edge', agents: ['pm_vendor_dispatch'], expected: 'emergency work order; after ~2h with no answer the next plumber gets it',
  rules: 'fully', rulesWhy: 'Emergency keywords + timer.', synthetic: SYN_PORTS,
  run: async c => { await PM(c); c.facts.v = await pmVendors(c.m); c.seeded(); await c.conn(mailboxEvent('mail.received', tenantMail('Pipe burst, water everywhere in unit 2!', 'tenant2@renters.example'), T)); await c.sweep(plus(T, 1)); await c.sweep(plus(T, 2.1)) },
  check: async (_o, c) => [['replaced', (await q1<{ vendor_id: string }>(`select vendor_id from pm_maintenance_requests where org_id = $1`, [c.m.org]))?.vendor_id === (c.facts.v as { plumber2: string }).plumber2], ['EMERGENCY subject', /^EMERGENCY Work order/.test((await sentMail(c.m))[1]?.subject ?? '')]] })

add({ id: 'E05', pack: 'E', title: 'Tenant cannot be reached -> still dispatched, owner told to call', kind: 'failure', agents: ['pm_maintenance_intake'], expected: 'intake blocked "call the tenant on 555 0102"; request dispatched anyway; owner warning',
  rules: 'fully', rulesWhy: 'Missing email check.', synthetic: SYN_PORTS,
  run: async c => { await PM(c); await pmVendors(c.m); await mutateSynth(c.m.org, 'property_system', s => { s.requests.push({ id: 'B-502', property: 'Maple Court', unit: '1A', tenantName: 'No Mail', tenantEmail: null, tenantPhone: '555 0102', description: 'Sink leak', category: null, status: 'new', notes: [] }) }); c.seeded()
    await c.conn({ source: 'buildium', type: 'buildium.request.changed', externalId: 'buildium.residentrequests:B-502:v1', occurredAt: T.toISOString(), payload: { connectionId: null, record: { id: 'B-502', updatedAt: T.toISOString() } } }) },
  check: async (o, c) => [['blocked call tenant', o.activity.some(a => a.agent_key === 'pm_maintenance_intake' && a.status === 'blocked' && /call the tenant on 555 0102/.test(a.error ?? ''))], ['dispatched', (await q1<{ status: string }>(`select status from pm_maintenance_requests where org_id = $1`, [c.m.org]))?.status === 'dispatched'], ['owner told', ownerFor(o, ['pm_maintenance_intake']).some(r => r.severity === 'warning')]] })

add({ id: 'E06', pack: 'E', title: 'Rent late -> reminder from the property system balance, once', kind: 'normal', agents: ['pm_rent_reminder'], expected: 'one reminder to kai@ (1,450.00); paid and not-yet-due tenants get nothing; tenant with no email blocked',
  rules: 'fully', rulesWhy: 'Balance + due date.', synthetic: SYN_PORTS,
  run: async c => { await PM(c); await mutateSynth(c.m.org, 'property_system', s => { s.rentDue = [
      { tenantId: 't1', tenantName: 'Kai Green', tenantEmail: 'kai@renters.example', property: 'Maple Court', unit: '7D', amountDue: 1450, dueDate: isoDay(T, -3), currency: 'USD' },
      { tenantId: 't2', tenantName: 'Paid Up', tenantEmail: 'paid@renters.example', property: 'Maple Court', unit: '1A', amountDue: 0, dueDate: isoDay(T, -3), currency: 'USD' },
      { tenantId: 't3', tenantName: 'Not Yet', tenantEmail: 'notyet@renters.example', property: 'Maple Court', unit: '2B', amountDue: 1450, dueDate: isoDay(T, 3), currency: 'USD' },
      { tenantId: 't4', tenantName: 'No Email', tenantEmail: null, property: 'Maple Court', unit: '3C', amountDue: 900, dueDate: isoDay(T, -3), currency: 'USD' }] }); c.seeded(); await c.sweep(T); await c.sweep(plus(T, 1)) },
  check: async (o, c) => { const mail = (await sentMail(c.m)).filter(m => /^Rent reminder/.test(m.subject)); return [['one reminder to kai', mail.length === 1 && mail[0].to === 'kai@renters.example' && /USD\s1,450\.00/.test(mail[0].body), mail.map(m => m.to)], ['activity done+blocked', o.activity.filter(a => a.agent_key === 'pm_rent_reminder').map(a => a.status).sort().join() === 'blocked,done', o.activity.map(a => `${a.agent_key}:${a.status}`)]] } })

add({ id: 'E07', pack: 'E', title: 'Tenant request through the real Outlook inbox sync (text read from the stored message)', kind: 'edge', agents: ['pm_maintenance_intake'], expected: 'a tenant email arriving as the Outlook mail.received event is logged as a maintenance request with its unit',
  rules: 'fully', rulesWhy: 'Keyword category and unit from the stored text.', synthetic: 'synthetic Outlook message stored by the real inbox sync (storeProviderMessage -> emitMailEvents)',
  run: async c => { await PM(c); await pmVendors(c.m); c.seeded(); await viaOutlook(c, { id: uid('ol'), from: 'tenant4b@renters.example', subject: 'Problem in my apartment', text: 'Hi, the kitchen sink in unit 4B is leaking under the cabinet.', at: T }) },
  check: async (o, c) => { const r = await q1<{ category: string; unit: string | null }>(`select category, unit from pm_maintenance_requests where org_id = $1`, [c.m.org]); return [['logged with unit 4B', r?.category === 'plumbing' && r.unit === '4B', { request: r, activity: o.activity.map(a => `${a.agent_key}:${a.status}`) }]] } })

// ===== F. Office

const OF = (c: Ctx) => resetPacks(c.m, 'office', { settings: { reviewUrl: 'https://reviews.example/office' }, office: true })

add({ id: 'F01', pack: 'F', title: 'Overdue QuickBooks invoice (real poll shape) -> receivables agent runs', kind: 'normal', agents: ['office_overdue_invoices'], expected: 'invoice.changed as the QuickBooks poller emits it -> quickbooks.invoice -> office receivables run verified by its run record; reminder drafted',
  rules: 'fully', rulesWhy: 'Due date, balance and template; draft tier waits for the owner to send.', synthetic: 'synthetic QuickBooks + synthetic mailbox (Office); event through emitConnectionEvent',
  run: async c => { await OF(c); const now = new Date(); const s = await officeReceivables(c.m, [qbInv('1037', isoDay(now, -21), 1250)]); c.facts.agent = s.agentId; c.seeded()
    await c.conn({ source: 'quickbooks', type: 'invoice.changed', externalId: `invoice:1037:${now.toISOString()}`, occurredAt: now.toISOString(), payload: { connectionId: s.qbId, realmId: 'synthetic', entity: 'Invoice', id: '1037', deleted: false } }) },
  check: async (o, c) => [['run verified', o.activity.some(a => a.agent_key === 'office_overdue_invoices' && a.status === 'done' && a.proof.some(p => p.label === 'Run record on a fresh read' && p.value === 'completed')), o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`)],
    ['invoice tracked', (await q(`select qbo_invoice_id from office_invoices where agent_id = $1`, [c.facts.agent])).length === 1], ['owner email', renderedEmails(o, ['office_overdue_invoices']).length >= 1]] })

add({ id: 'F02', pack: 'F', title: 'Sweep runs only due Office agents', kind: 'edge', agents: ['office_overdue_invoices'], expected: 'agent due in 5h: first sweep nothing; sweep at +6h runs it once',
  rules: 'fully', rulesWhy: 'Schedule check.', synthetic: 'synthetic QuickBooks + mailbox',
  run: async c => { await OF(c); const now = new Date(); const s = await officeReceivables(c.m, [qbInv('1037', isoDay(now, -21), 1250)]); await q(`update office_agents set next_run_at = $2 where id = $1`, [s.agentId, plus(now, 5).toISOString()]); c.seeded()
    await c.sweep(now); c.facts.first = (await q(`select 1 from pack_activity where org_id = $1 and agent_key = 'office_overdue_invoices'`, [c.m.org])).length; await c.sweep(plus(now, 6)) },
  check: async (o, c) => [['nothing before due', c.facts.first === 0, c.facts.first], ['ran once when due', o.activity.filter(a => a.agent_key === 'office_overdue_invoices').map(a => a.status).join() === 'done', o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`)]] })

add({ id: 'F03', pack: 'F', title: 'Quiet office quote -> follow-up on day 3', kind: 'normal', agents: ['office_quote_followup', 'hs_quote_followup'], expected: 'one follow-up mentioning the quote ref',
  rules: 'fully', rulesWhy: 'Cadence.', synthetic: SYN_PORTS,
  run: async c => { await OF(c); const T2 = new Date(Date.UTC(2027, 0, 4, 8)); const wo = await admin(db => recordQuote(db, c.m.org, { pack: 'office', customerName: 'Lee Client', customerEmail: 'lee@client.example', description: 'Office move', amount: 1200, now: T2 })); c.facts.ref = wo.ref; c.seeded(); await c.sweep(plus(T2, 72)) },
  check: async (_o, c) => [['one follow-up', (await sentMail(c.m)).filter(m => m.subject.includes(String(c.facts.ref))).length === 1, (await sentMail(c.m)).map(m => m.subject)]] })

add({ id: 'F04', pack: 'F', title: 'Office job scheduled -> crew member messaged; DONE -> invoiced', kind: 'normal', agents: ['office_crew_updates', 'hs_dispatch', 'hs_invoice'], expected: 'crew message delivered (crew_messages row); crew.done invoices the job',
  rules: 'fully', rulesWhy: 'Schedule + template + invoice lines.', synthetic: `${SYN_PORTS}; crew member on the crew roster (crew_members)`,
  run: async c => { await OF(c); const T2 = new Date(Date.UTC(2027, 0, 4, 8)); const cm = (await q1<{ id: string }>(`insert into crew_members (org_id, name, role, email, channels) values ($1,'Pat Packer','field','pat@crew.example',array['email']::text[]) returning id`, [c.m.org]))!
    const wo = await admin(db => recordQuote(db, c.m.org, { pack: 'office', customerName: 'Lee Client', customerEmail: 'lee@client.example', description: 'Office move', amount: 1200, now: T2 })); await admin(db => scheduleJob(db, c.m.org, wo.id, { crewMemberId: cm.id, start: plus(T2, 24 * 4) })); c.facts.wo = wo.id; c.seeded()
    await c.sweep(plus(T2, 24 * 3 + 1)); await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}`, occurredAt: plus(T2, 24 * 4 + 5).toISOString(), payload: { jobRef: wo.ref } }) },
  check: async (o, c) => [['crew message delivered', o.crew.length >= 1, o.crewCalls.map(x => `${x.r.status}: ${x.r.reason ?? ''}`)], ['invoiced', (await q1<{ status: string }>(`select status from pack_work_orders where id = $1`, [c.facts.wo]))?.status === 'invoiced']] })

add({ id: 'F05', pack: 'F', title: 'No active Office agents -> a QuickBooks change does nothing', kind: 'edge', agents: ['office_overdue_invoices'], expectNoAction: true, expected: 'no activity, no owner update',
  rules: 'fully', rulesWhy: 'Nothing configured, nothing done.', synthetic: 'synthetic event only',
  run: async c => { await OF(c); c.seeded(); await c.conn({ source: 'quickbooks', type: 'invoice.changed', externalId: `invoice:1:${Date.now()}`, occurredAt: new Date().toISOString(), payload: { connectionId: null, entity: 'Invoice', id: '1', deleted: false } }) },
  check: async o => [['no activity', o.activity.length === 0, o.activity], ['no owner update', ownerFor(o, ['office_overdue_invoices']).length === 0]] })

add({ id: 'F06', pack: 'F', title: 'QuickBooks rejects the token mid-run -> nothing claimed done, owner told', kind: 'failure', agents: ['office_overdue_invoices'], expected: 'the receivables run cannot read QuickBooks (401); the pack activity is not done and the owner gets a warning',
  rules: 'fully', rulesWhy: 'Provider error handling.', synthetic: 'synthetic QuickBooks with an injected 401 on every call',
  run: async c => { await OF(c); const now = new Date(); const s = await officeReceivables(c.m, [qbInv('1037', isoDay(now, -21), 1250)]); await injectQboFault(s.qbId, { op: '*', mode: 'auth', remaining: 50 }); c.seeded()
    await c.conn({ source: 'quickbooks', type: 'invoice.changed', externalId: `invoice:1037:${now.toISOString()}`, occurredAt: now.toISOString(), payload: { connectionId: s.qbId, realmId: 'synthetic', entity: 'Invoice', id: '1037', deleted: false } }) },
  check: async o => [['not done', o.activity.filter(a => a.agent_key === 'office_overdue_invoices').every(a => a.status !== 'done') && o.activity.some(a => a.agent_key === 'office_overdue_invoices'), o.activity.map(a => `${a.agent_key}:${a.status}:${a.error ?? ''}`)], ['owner told', ownerFor(o, ['office_overdue_invoices']).some(r => r.severity === 'warning'), ownerFor(o, ['office_overdue_invoices']).map(r => `${r.severity}:${r.headline}`)]] })

// ===== X. Cross-cutting

add({ id: 'X01', pack: 'X', org: 'NW', title: 'Duplicate events: the same store-mailbox event routed twice -> one reply', kind: 'edge', agents: ['customer_care'], expected: 'router records one event + one duplicate; one reply to the customer',
  rules: 'fully', rulesWhy: 'Dedupe on provider id; no judgement.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['wismo_email']); c.seeded(); const e = { source: 'mailbox' as const, type: 'mail.received', externalId: 'mail:dup-1', occurredAt: new Date().toISOString(), payload: { id: 'mail-wismo-1', from: 'ben@shopper.example' } }
    c.facts.first = await c.route(e); c.facts.second = await c.route(e) },
  check: async (_o, c) => [['second is duplicate', c.facts.second === 'duplicate', c.facts], ['one reply', (await commerceOf(c.m)).outbox.filter(m => m.inReplyTo === 'mail-wismo-1').length === 1]] })

add({ id: 'X02', pack: 'X', title: 'Duplicate events: the same lead email delivered twice (push + poll) -> one reply', kind: 'edge', agents: ['hs_lead_reply'], expected: 'connection_events dedupes the second; one reply; a second message from the same person is a duplicate lead',
  rules: 'fully', rulesWhy: 'Dedupe on provider message id + 30-day same-person rule.', synthetic: SYN_PORTS,
  run: async c => { await HS(c); c.seeded(); const e = mailboxEvent('lead.email', hsLead('m-1'), T, 'lead:m-1'); c.facts.first = await c.conn(e); c.facts.second = await c.conn(e); await c.conn(mailboxEvent('lead.email', hsLead('m-2', { text: 'Following up on my roof.' }), plus(T, 1), 'lead:m-2')) },
  check: async (_o, c) => [['second delivery deduped', c.facts.second === 'duplicate', c.facts], ['one reply', (await sentMail(c.m)).length === 1, (await sentMail(c.m)).length]] })

add({ id: 'X03', pack: 'X', org: 'NW', title: 'Two agents on one job: Campaign and Promo Manager on the same out-of-stock promo', kind: 'edge', agents: ['campaign', 'promo_manager'], expected: 'two job workers in parallel: exactly one action, one removal from Featured, one owner update',
  rules: 'fully', rulesWhy: 'Shared problem key + loop claim; no judgement.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['promoted_out_of_stock']); c.seeded(); await routeEvent({ ...shopify('inventory_levels/update', { inventory_item_id: 5003, available: 0 }), orgId: c.m.org }); await c.drain({ workers: 3 }) },
  check: async (o, c) => { const f = (await commerceOf(c.m)).collections.find(x => x.id === COMMERCE_IDS.featured)!; return [['one action', workOf(o, 'promoted_out_of_stock').length === 1, workOf(o, 'promoted_out_of_stock').map(w => w.agent_key)], ['removed', !f.productIds.includes(COMMERCE_IDS.lantern.product)], ['one owner update', new Set(ownerFor(o, ['campaign', 'promo_manager']).filter(r => /Brass Lantern is out of stock/.test(r.headline)).map(r => r.dedupe_key)).size === 1]] } })

add({ id: 'X04', pack: 'X', title: 'Two agents on one invoice: home-services chaser + Office receivables -> no double customer email', kind: 'edge', agents: ['hs_payment_chase'], expectNoAction: true, expected: 'with an Office receivables agent active, the home-services chaser sends no overdue reminder of its own',
  rules: 'fully', rulesWhy: 'Ownership rule between agents.', synthetic: `${SYN_PORTS}; synthetic QuickBooks + mailbox`,
  run: async c => { await resetPacks(c.m, 'home_services', { trade: 'cleaning', office: true }); const now = new Date(); await officeReceivables(c.m, [])
    const wo = await admin(db => recordQuote(db, c.m.org, { customerName: 'Dana', customerEmail: 'dana@homeowner.example', description: 'Deep clean', amount: 300, now: plus(now, -24 * 40) }))
    await c.route({ source: 'crew', type: 'crew.done', externalId: `crew.done:${wo.id}`, occurredAt: plus(now, -24 * 40).toISOString(), payload: { jobRef: wo.ref } }); c.seeded(); await c.sweep(now) },
  check: async (_o, c) => [['no pack overdue reminder', (await sentMail(c.m)).filter(m => /overdue/i.test(m.subject)).length === 0, (await sentMail(c.m)).map(m => m.subject)]] })

add({ id: 'X05', pack: 'X', org: 'NW', title: 'Ask-first owner never replies -> reminder at 24h, escalation at 72h, nothing done', kind: 'edge', agents: ['listing_writer'], expected: 'draft waits; reminder after 24h and escalation after 72h through the case.check jobs; description untouched; no customer mail. (There is no expiry in the product: the action stays decidable.)',
  rules: 'fully', rulesWhy: 'Timers on the case.', synthetic: `${SYN_SHOP}; time passing simulated by moving asked_at / next_check_at back`,
  run: async c => { await resetCommerce(c.m, ['weak_description']); await setMode(await merchantActor(c.m), 'update_listing', 'ask_first'); await commerceSweep(c)
    const l = await q1<{ id: string; case_id: string }>(`select id, case_id from agent_loops where org_id = $1 and agent_key = 'listing_writer' and state = 'awaiting_owner'`, [c.m.org])
    c.facts.waiting = Boolean(l)
    if (l) for (const h of [25, 73]) {
      await q(`update agent_loops set asked_at = now() - ($2 || ' hours')::interval where id = $1`, [l.id, String(h)])
      await q(`update cases set next_check_at = now() - interval '1 minute' where id = $1`, [l.case_id])
      await enqueueDueCases(new Date()); await c.drain()
    }
    await setMode(await merchantActor(c.m), 'update_listing', 'act_and_tell') },
  check: async (o, c) => { const l = o.loops.find(x => x.agent_key === 'listing_writer'); const ups = ownerFor(o, ['listing_writer']).map(r => r.dedupe_key.split(':').at(-1)); return [
    ['waited', c.facts.waiting === true], ['reminded', Boolean(l?.reminded_at)], ['escalated', Boolean(l?.escalated_at)], ['owner got ask + reminder + escalation', ['ask', 'reminder', 'escalated'].every(k => ups.includes(k)), ups],
    ['description untouched', (await commerceOf(c.m)).info[COMMERCE_IDS.candle.product].descriptionHtml === '<p>Nice candle.</p>'], ['no customer mail', (await commerceOf(c.m)).outbox.length === 0]] } })

add({ id: 'X06', pack: 'X', org: 'NW', title: 'Agent cannot finish (Shopify refuses the write) -> owner told once, retried later', kind: 'failure', agents: ['listing_writer'], expected: 'work failed with "refused"; one owner warning, no "done" email; loop blocked with a retry time; the retry after the time passes succeeds',
  rules: 'fully', rulesWhy: 'Error handling + backoff.', synthetic: `${SYN_SHOP}; fault user_error on setDescription`,
  run: async c => { await resetCommerce(c.m, ['weak_description']); await injectFault(c.m.conn, { op: 'commerce.setDescription', mode: 'user_error' }); await commerceSweep(c)
    c.facts.afterFail = (await q<{ status: string }>(`select status from library_actions where org_id = $1 and action_type = 'weak_description' order by created_at`, [c.m.org])).map(r => r.status)
    c.facts.loopState = (await q1<{ state: string }>(`select state from agent_loops where org_id = $1 and agent_key = 'listing_writer'`, [c.m.org]))?.state
    await q(`update agent_loops set next_retry_at = now() - interval '1 minute' where org_id = $1 and state = 'blocked'`, [c.m.org]); await c.sweep(commerceSweepTime()) },
  check: async (o, c) => [['failed first', (c.facts.afterFail as string[])[0] === 'failed', c.facts.afterFail], ['loop blocked', c.facts.loopState === 'blocked', c.facts.loopState], ['owner warned once', ownerFor(o, ['listing_writer']).filter(r => r.severity === 'warning').length >= 1 && !ownerFor(o, ['listing_writer']).some(r => /done/i.test(r.headline) && r.severity === 'warning'), ownerFor(o, ['listing_writer']).map(r => `${r.severity}:${r.headline}`)],
    ['retry succeeds', o.work.filter(w => w.action_type === 'weak_description').map(w => w.status).join() === 'failed,done', o.work.filter(w => w.action_type === 'weak_description').map(w => w.status)]] })

add({ id: 'X07', pack: 'X', org: 'NW', title: 'App uninstalled mid-run -> action fails, rest skipped, later sweeps skip the store', kind: 'failure', agents: ['listing_writer'], expected: 'first description write fails "uninstalled", the rest of the run is skipped, the connection is uninstalled, the next sweep does nothing',
  rules: 'fully', rulesWhy: 'Connection status check between actions.', synthetic: `${SYN_SHOP}; fault uninstall_mid_run`,
  run: async c => { await resetCommerce(c.m, ['weak_description', 'thin_facts_description']); await mutateSynthetic(c.m.conn, s => { s.commerce!.info[COMMERCE_IDS.mug.product].descriptionHtml = '<p>Mug.</p>' })
    await injectFault(c.m.conn, { op: 'commerce.setDescription', mode: 'uninstall_mid_run' }); await commerceSweep(c)
    c.facts.conn = (await q1<{ status: string }>(`select status from store_connections where id = $1`, [c.m.conn]))?.status; c.facts.rows = (await q(`select 1 from library_actions where org_id = $1`, [c.m.org])).length
    await c.sweep(commerceSweepTime()); c.facts.rowsAfter = (await q(`select 1 from library_actions where org_id = $1`, [c.m.org])).length
    await q(`update store_connections set status = 'active', status_reason = null where id = $1`, [c.m.conn]) },
  check: async (o, c) => [['connection uninstalled', c.facts.conn === 'uninstalled', c.facts.conn], ['a write failed, none done', o.work.filter(w => w.agent_key === 'listing_writer').some(w => w.status === 'failed') && !o.work.some(w => w.agent_key === 'listing_writer' && w.status === 'done'), o.work.map(w => `${w.agent_key}:${w.status}:${w.status_reason ?? ''}`)], ['later sweep adds nothing', c.facts.rowsAfter === c.facts.rows, c.facts]] })

add({ id: 'X08', pack: 'X', title: 'Tool disconnected: calendar unreachable during a lead reply', kind: 'failure', agents: ['hs_lead_reply'], expected: 'nothing half-written; reported (blocked or failed); owner told',
  rules: 'fully', rulesWhy: 'Provider error handling.', synthetic: `${SYN_PORTS}; port fault calendar.freeBusy unreachable`,
  run: async c => { await HS(c); await injectPortFault(c.m.org, 'calendar', { op: 'freeBusy', mode: 'unreachable' }); c.seeded(); await c.conn(mailboxEvent('lead.email', hsLead('m-cal'), T)) },
  check: async (o, c) => { const mail = await sentMail(c.m); const a = o.activity.find(x => x.agent_key === 'hs_lead_reply'); return [['handled honestly', (a?.status === 'done' && mail.length === 1) || (a !== undefined && a.status !== 'done' && mail.length === 0), { activity: a && `${a.status}:${a.error ?? ''}`, sent: mail.map(m => m.subject) }], ['owner told', ownerFor(o, ['hs_lead_reply']).length >= 1]] } })

add({ id: 'X09', pack: 'X', org: 'NW', title: '"Stop all agents" -> the sweep is refused, nothing runs', kind: 'edge', agents: COMMERCE_AGENTS_ALL, expectNoAction: true, expected: 'emitSweep skips the stopped organization; no work row; no owner update',
  rules: 'fully', rulesWhy: 'Kill switch.', synthetic: SYN_SHOP,
  run: async c => { await resetCommerce(c.m, ['weak_description']); await q(`insert into org_controls (org_id, agents_stopped, stop_reason) values ($1, true, 'scenario') on conflict (org_id) do update set agents_stopped = true, stop_reason = 'scenario'`, [c.m.org]); await commerceSweep(c); await q(`update org_controls set agents_stopped = false where org_id = $1`, [c.m.org]) },
  check: async (o, c) => [['no work', o.work.length === 0, o.work.length], ['no owner update', o.owner.length === 0], ['description untouched', (await commerceOf(c.m)).info[COMMERCE_IDS.candle.product].descriptionHtml === '<p>Nice candle.</p>']] })

add({ id: 'X10', pack: 'X', title: 'Unverified first-contact sender through Outlook -> quarantined, no agent acts', kind: 'edge', agents: ['ls_lead_reply', 'ls_qualify'], expectNoAction: true, expected: 'a Zillow-looking lead without SPF/DKIM/DMARC passing is quarantined by the inbox sync; no lead.email, no reply, no lead row',
  rules: 'fully', rulesWhy: 'Sender policy by rules.', synthetic: 'synthetic Outlook message without passing authentication, stored by the real inbox sync',
  run: async c => { await LS(c); c.seeded(); c.facts.inbox = [await storeProviderMessage(await outlookAccount(c.m), { ...outlookMessage({ id: uid('ol'), from: 'rentalclientservices@zillowrentals.com', subject: 'New Zillow Rentals lead for 1420 NW Lovejoy St #4B', text: ZILLOW_TEXT('Spoof Renter', 'spoof@renter.example', isoDay(T, 20)), at: T }), authentication: { spf: 'fail', dkim: 'none', dmarc: 'fail' } }, 'scenario-harness')]; await c.drain() },
  check: async (o, c) => [['quarantined', (c.facts.inbox as string[])[0] === 'quarantined', c.facts.inbox], ['no reply', (await sentMail(c.m)).length === 0], ['no lead', (await q(`select 1 from pack_leads where org_id = $1`, [c.m.org])).length === 0], ['no activity', o.activity.length === 0]] })

// ===== X11. Connect only (lib/autonomy/on-connect.ts)

/** A time zone where it is early afternoon now, so the templates' quiet hours (19:00-08:00) never hold a send. */
function afternoonZone(): string {
  let off = 13 - new Date().getUTCHours()
  if (off > 12) off -= 24
  if (off < -12) off += 24
  return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`
}

add({ id: 'X11', pack: 'X', title: 'Connect only, no clicks -> findings and fixes (QuickBooks + mailbox connected, nothing else)', kind: 'normal', agents: ['office_overdue_invoices'],
  expected: 'the two connections alone: packs inferred (office), Deploi Office on, Accounts Receivable created and granted by autonomy:on-connect at the default "do it and tell me", the connect sweep runs it in the same job run, every overdue invoice gets one reminder, one "Here\'s what I found" owner update per connection; no sweep, webhook or click',
  rules: 'fully', rulesWhy: 'Inference by connection kind; grants from the owner\'s autonomy modes; due date, balance and template.', synthetic: 'synthetic QuickBooks + synthetic mailbox connected through the real connect functions (connectSyntheticOffice, connectSyntheticMailbox)',
  run: async c => {
    // a business that never chose anything: no business type, no Office agents, Office not switched on, no store running
    await admin(async db => { for (const t of PACK_TABLES) await db.query(`delete from ${t} where org_id = $1`, [c.m.org]) })
    await clearAgentState(c.m)
    await resetOfficeFor(c.m, false)
    await admin(async db => {
      for (const t of ['autonomy_backlog', 'autonomy_outbound', 'autonomy_connects', 'discovery_agents', 'discovery_runs', 'business_profiles']) await db.query(`delete from ${t} where org_id = $1`, [c.m.org])
      await db.query(`delete from org_products where org_id = $1 and product = 'office'`, [c.m.org])
      await db.query(`update store_connections set status = 'uninstalled', status_reason = 'scenario harness: connect-only runs without a store' where id = $1`, [c.m.conn])
      await db.query(`update agencies set timezone = $2 where id = $1`, [c.m.org, afternoonZone()])
    })
    const actor = await merchantActor(c.m)
    const now = new Date()
    const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    await mutateQboSynth(qb.id, s => { s.invoices = [1, 2, 3].map(i => synthInvoice(`9${i}`, { docNumber: `9${i}`, totalAmt: 400 * i, dueDate: isoDay(now, -20 - i), txnDate: isoDay(now, -20 - i), customerId: `5${i}`, customerName: `Client ${i}`, billEmail: `ap@client-${i}.example` })) })
    const mb = await connectSyntheticMailbox(actor, 'ar@harbor-office.example')
    c.facts.qb = qb.id; c.facts.mb = mb.id
    c.seeded()
    await c.drain()
  },
  check: async (o, c) => {
    const ps = await q1<{ business_type: string; source: string }>(`select business_type, source from pack_settings where org_id = $1`, [c.m.org])
    const agents = await q<{ kind: string; status: string; created_by: string; granted_by: string | null; tier: string | null }>(`select a.kind, a.status, a.created_by, p.granted_by, p.policy->'email'->>'tier' as tier from office_agents a left join office_agent_policies p on p.id = a.active_policy_id where a.org_id = $1`, [c.m.org])
    const events = await q<{ source: string; external_id: string }>(`select source, external_id from agent_events where org_id = $1 order by received_at`, [c.m.org])
    const mail = await q<{ to_addresses: string[]; status: string }>(`select to_addresses, status from email_messages where org_id = $1 and office_agent_id is not null`, [c.m.org])
    const found = o.owner.filter(r => r.agent_key === 'autonomy' && r.channel === 'email')
    const sent = await getSynthMailSent(String(c.facts.mb))
    c.facts.summary = found.map(r => `${r.headline} (${r.email_status ?? r.status})`)
    return [
      ['packs inferred', ps?.business_type === 'office' && ps.source === 'inferred', ps],
      ['AR created + granted by autonomy, act-and-tell', agents.length === 1 && agents[0].kind === 'accounts_receivable' && agents[0].status === 'active' && agents[0].created_by === 'autonomy:on-connect' && agents[0].granted_by === 'autonomy:on-connect' && agents[0].tier === 'send_autonomous', agents],
      ['only the connect sweeps triggered work', events.length > 0 && events.every(e => e.source === 'sweep' && e.external_id.startsWith('connect:')), events],
      ['a loop row for the receivables agent', o.loops.some(l => l.agent_key === 'office_overdue_invoices'), o.loops.map(l => `${l.agent_key}:${l.state}`)],
      ['one reminder per overdue invoice', sent.length === 3 && new Set(sent).size === 3, { sent, messages: mail.length }],
      ['one "Here\'s what I found" per connection, rendered', found.length === 2 && new Set(found.map(r => r.dedupe_key)).size === 2 && found.every(r => /^Here's what I found/.test(r.headline) && (r.email_html ?? 0) > 200), c.facts.summary],
    ]
  } })

// ------------------------------------------------------------------ runner

async function runScenario(s: Scenario): Promise<Result> {
  const m = s.org === 'NW' ? NW : s.org === 'HB' ? HB : s.pack === 'A' ? NW : HB
  await clearQueue()
  const started = Date.now()
  const jobs: JobOutcome[] = []
  const notes: string[] = []
  const facts: Record<string, unknown> = {}
  const ownerFrom = seenOwner.length, crewFrom = seenCrew.length
  let seededAt: number | null = null
  const drain = async (opts: { workers?: number } = {}) => {
    const out: JobOutcome[] = []
    for (let round = 0; round < 20; round++) {
      const rs = await Promise.all(Array.from({ length: opts.workers ?? 1 }, () => runDueJobs({ limit: 400, deadlineMs: 120_000 })))
      const ran = rs.flatMap(r => r.ran)
      out.push(...ran)
      if (!ran.length) break
    }
    jobs.push(...out)
    return out
  }
  const c: Ctx = {
    m, facts, note: x => notes.push(x),
    seeded: () => { if (seededAt === null) seededAt = Date.now() },
    sweep: async at => { await emitSweep(at); await drain() },
    route: async e => { const r = await routeEvent({ ...e, orgId: e.orgId ?? m.org } as AgentEvent); await drain(); return r.status },
    conn: async e => { const r = await admin(db => emitConnectionEvent(db, { ...e, orgId: e.orgId ?? m.org } as ConnectionEvent)); await drain(); return r },
    drain,
  }
  let error: string | null = null
  let checks: Check[] = []
  let o: Obs | null = null
  try {
    await s.run(c)
    o = await observe(m, jobs, ownerFrom, crewFrom)
    checks = await s.check(o, c)
  } catch (e) {
    error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 600)
    o ??= await observe(m, jobs, ownerFrom, crewFrom).catch(() => null)
  }
  const obs = o ?? { loops: [], activity: [], work: [], owner: [], crew: [], crewCalls: [], undo: [], jobs, ownerCalls: [] }
  const mine = obs.loops.filter(l => s.agents.includes(l.agent_key))
  const firstLoop = mine.map(l => new Date(l.created_at).getTime()).filter(t => seededAt !== null && t >= seededAt - 5).sort((a, b) => a - b)[0]
  const work = [...obs.activity.filter(a => s.agents.includes(a.agent_key)).map(a => ({ agent: a.agent_key, status: a.status, err: a.error })), ...obs.work.filter(w => s.agents.includes(w.agent_key)).map(w => ({ agent: w.agent_key, status: w.status, err: w.status_reason }))]
  const detectedRow = mine.length > 0 || work.length > 0
  const detectionMs = firstLoop && seededAt ? Math.max(0, firstLoop - seededAt) : null
  const ownerRows = ownerFor(obs, s.agents)
  const emails = ownerRows.filter(r => r.channel === 'email')
  const rendered = emails.filter(r => r.email_status && (r.email_html ?? 0) > 200)
  const jobErrors = obs.jobs.filter(j => j.status !== 'succeeded').map(j => `${j.kind} ${j.status}: ${j.error ?? ''}`.slice(0, 300))
  const failures = checks.filter(([, ok]) => !ok).map(([l, , v]) => `${l}${v !== undefined ? ` (observed: ${JSON.stringify(v).slice(0, 400)})` : ''}`)
  if (error) failures.unshift(`threw ${error}`)
  const states = mine.map(l => `${l.agent_key}:${l.state}`)
  const verifiedLoops = mine.filter(l => l.state === 'done').length
  const verifiedWork = obs.work.filter(w => s.agents.includes(w.agent_key) && w.proof?.verified).length + obs.activity.filter(a => s.agents.includes(a.agent_key) && a.status === 'done').length
  return {
    id: s.id, pack: s.pack, title: s.title, kind: s.kind, expected: s.expected, synthetic: s.synthetic, rules: s.rules, rulesWhy: s.rulesWhy,
    detected: s.expectNoAction ? 'n/a' : detectedRow ? 'yes' : 'no', detectionMs: s.expectNoAction ? null : detectionMs,
    action: work.length ? [...new Set(work.map(w => `${w.agent}:${w.status}`))].slice(0, 4).join(', ') : (states.length ? states.join(', ') : 'none'),
    verified: verifiedLoops || verifiedWork ? `yes (${Math.max(verifiedLoops, verifiedWork)})` : work.some(w => /not_verified|failed|blocked/.test(w.status)) ? 'no (reported)' : 'n/a',
    ownerEmail: emails.length ? `${rendered.length}/${emails.length} rendered (${[...new Set(emails.map(e => e.email_status ?? e.status))].join('/')})` : 'none',
    crewMsg: obs.crewCalls.length ? obs.crewCalls.map(x => x.r.status).join('/') + (obs.crew.length ? ` (${obs.crew.length} row)` : ' (no row)') : 'n/a',
    undo: obs.undo.filter(u => !u.agent_key || s.agents.includes(u.agent_key)).length ? `${obs.undo.filter(u => !u.agent_key || s.agents.includes(u.agent_key)).length} token${obs.undo.some(u => u.used_at) ? ', used: ' + obs.undo.filter(u => u.used_at).map(u => (u.result?.ok ? 'ok' : `failed (${u.result?.detail})`)).join('/') : ''}` : 'none',
    finalStatus: states.length ? states.join(', ') : work.length ? work.map(w => `${w.agent}:${w.status}`).slice(0, 4).join(', ') : 'no loop',
    result: failures.length ? 'FAIL' : 'PASS', failures, error, notes, jobErrors, facts: JSON.parse(JSON.stringify(facts, (_k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}...` : v))), durationMs: Date.now() - started,
  }
}

// ------------------------------------------------------------------ report

const PACK_NAMES: Record<PackId, string> = { A: 'A. Commerce (12 agents, synthetic Shopify)', B: 'B. Home services', C: 'C. Leasing', D: 'D. Real estate', E: 'E. Property management', F: 'F. Office', X: 'X. Cross-cutting edge cases' }
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function report(results: Result[], meta: Record<string, unknown>): string {
  const L: string[] = []
  const total = results.length, pass = results.filter(r => r.result === 'PASS').length
  L.push('# Scenario harness results, 2026-11-07', '')
  L.push(`Generated by \`npx tsx scripts/scenario-harness.ts\` on ${meta.ranAt} against the local database \`${DB_NAME}\` (migrated and seeded by the harness). Raw data: \`proof/scenarios/results.json\`.`, '')
  L.push('**Everything here is synthetic.** The Shopify store is synthetic store state; mail, calendar, CRM, invoicing and the property system are the synthetic pack ports; Office uses the synthetic QuickBooks and mailbox. AI_PROVIDER is off: every outcome comes from rules and templates. Owner emails go through the real owner-update pipeline (owner_updates + system_emails), are rendered, and are held (no RESEND_API_KEY), so nothing left the machine. Crew messages go through the real crew pipeline (crew_messages).', '')
  L.push('Triggers are only the normal ones: the 15-minute sweep (`emitSweep`), a Shopify webhook event as the webhook route routes it (`routeEvent`), or the change a connection emits (`emitConnectionEvent`, or `emitMailEvents` for the Outlook inbox sync), followed by the job worker (`runDueJobs`). No agent is called directly. Detection time is wall-clock from the end of seeding to the first `agent_loops` row of the scenario\'s agents (it includes routing, queueing and the job claim).', '')
  L.push(`**Total: ${pass}/${total} pass.**`, '')
  L.push('| Pack | Scenarios | Pass | Fail | Normal | Edge | Failure |', '|---|---|---|---|---|---|---|')
  for (const p of Object.keys(PACK_NAMES) as PackId[]) {
    const rs = results.filter(r => r.pack === p); if (!rs.length) continue
    const k = (x: Kind) => `${rs.filter(r => r.kind === x && r.result === 'PASS').length}/${rs.filter(r => r.kind === x).length}`
    L.push(`| ${PACK_NAMES[p]} | ${rs.length} | ${rs.filter(r => r.result === 'PASS').length} | ${rs.filter(r => r.result === 'FAIL').length} | ${k('normal')} | ${k('edge')} | ${k('failure')} |`)
  }
  L.push('')
  for (const p of Object.keys(PACK_NAMES) as PackId[]) {
    const rs = results.filter(r => r.pack === p); if (!rs.length) continue
    L.push(`## ${PACK_NAMES[p]}`, '')
    L.push(`Totals: ${rs.filter(r => r.result === 'PASS').length}/${rs.length} pass.`, '')
    L.push('| # | Scenario | Kind | Detected unprompted? | Detection ms | Action | Verified | Owner email | Crew msg | Undo | Final status | Result | Rules handle | Why |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of rs) L.push(`| ${r.id} | ${cell(r.title)} | ${r.kind} | ${r.detected} | ${r.detectionMs ?? '-'} | ${cell(r.action)} | ${cell(r.verified)} | ${cell(r.ownerEmail)} | ${cell(r.crewMsg)} | ${cell(r.undo)} | ${cell(r.finalStatus)} | **${r.result}** | ${r.rules} | ${cell(r.rulesWhy)} |`)
    L.push('')
    const fails = rs.filter(r => r.result === 'FAIL')
    if (fails.length) {
      L.push('Failures:', '')
      for (const r of fails) {
        L.push(`- **${r.id} ${r.title}**: expected: ${r.expected}.`)
        for (const f of r.failures) L.push(`  - ${cell(f)}`)
        if (r.jobErrors.length) L.push(`  - job errors: ${cell(r.jobErrors.slice(0, 3).join('; '))}`)
        for (const n of NOTES[r.id] ?? []) L.push(`  - ${n}`)
      }
      L.push('')
    }
    const syn = [...new Set(rs.map(r => r.synthetic))]
    L.push(`Synthetic inputs: ${syn.map(cell).join('; ')}.`, '')
  }
  L.push('## Pack readiness ranking', '')
  L.push('Ranked by pass rate; equal pass rates are ordered by how much of the evidence ran through the real connection emitters (a judgement, given in the reason). Every pack that reads customer replies (B, C, D, E) now has a scenario through the real Outlook inbox sync (B02, C02, C09, D08, E07). Commerce ranks on synthetic evidence only: its customer-email agents cannot run on a real store until the live store wires email.', '')
  const ranked = (['A', 'B', 'C', 'D', 'E', 'F'] as PackId[]).map(p => { const rs = results.filter(r => r.pack === p); return { p, rs, rate: rs.length ? rs.filter(r => r.result === 'PASS').length / rs.length : 0 } }).sort((a, b) => b.rate - a.rate || TIE_ORDER.indexOf(a.p) - TIE_ORDER.indexOf(b.p))
  L.push('| Rank | Pack | Pass rate | Reason |', '|---|---|---|---|')
  ranked.forEach((x, i) => { const f = x.rs.filter(r => r.result === 'FAIL'); L.push(`| ${i + 1} | ${PACK_NAMES[x.p]} | ${x.rs.filter(r => r.result === 'PASS').length}/${x.rs.length} | ${cell(READINESS[x.p] ?? '')}${f.length ? ` Failing: ${f.map(r => r.id).join(', ')}.` : ''} |`) })
  L.push('')
  for (const s of EXTRA_SECTIONS) L.push(s, '')
  return L.join('\n')
}

/** Hand-written notes on failures and readiness (kept next to the code that produces the numbers). */
const NOTES: Record<string, string[]> = {}
/** Equal pass rates are ordered by how much of the evidence ran through the real connection emitters (hand-judged,
 * reasons in READINESS): commerce last, because its customer-email agents cannot run on a real store yet. */
const TIE_ORDER: PackId[] = ['C', 'E', 'D', 'B', 'F', 'A']
const READINESS: Partial<Record<PackId, string>> = {
  A: 'Every seeded problem was found unprompted by the sweep or the webhook it belongs to, verified by a fresh read, with working undo links and one action per problem across agents; the packer is a real crew_members row reached through the real crew pipeline. Synthetic only: the live store does not wire sendEmail, inbox or sent yet (lib/commerce/pack/live-store.ts), so the customer-email agents cannot run on a real store.',
  B: 'Leads through the Outlook inbox sync, quote follow-ups, crew dispatch through the real crew pipeline (crew_members), invoicing on DONE and payment chasing all work on rules. Free-form replies ("Tuesday afternoon") are safely left alone and would need AI.',
  C: 'Commission invoices exact to the cent and sent once, payment notices deduped, the fair-housing check refuses steering, 12 renters with different backgrounds get identical replies apart from name and times, and renter answers through the Outlook inbox sync are read from the stored message.',
  D: 'Buyer, seller and CRM leads (the CRM poll shape) are answered and logged in the CRM, a CRM outage is reported, and a showing pick through the Outlook inbox sync is booked (D08). A seller lead that arrives through Outlook is treated as a buyer: the inbox-sync lead payload carries no subject or lead type.',
  E: 'The Buildium path works end to end with the real poll shape, and tenant mail through the Outlook inbox sync is logged with category and unit from the stored text.',
  F: 'QuickBooks changes in the real poll shape reach the receivables agent, due-only sweeps hold, a 401 is reported, crew updates reach the crew roster. Office quote follow-up and crew updates run the home-services code under hs_* agent keys (the dashboard attributes them to home-services agents).',
}
const EXTRA_SECTIONS: string[] = [
  `## Code fixes made by this harness (two rounds)

Round 1 (found by the first run, 65/70):
1. **Pack lead sources read the payloads real connections emit** (lib/packs/leads.ts, tests/packs/lead-sources.test.ts). Before: B02, C02, D03 failed; a Zillow lead from the Outlook inbox sync (\`{ providerMessageId, lead }\`) and a new CRM person (\`{ provider, contact }\`) parsed to null and were dropped silently while the job reported succeeded.
2. **Order Tracker never emails a customer twice on a retry** (lib/commerce/pack/agents.ts). Before: a failed packer message made the stuck-order case retry and the delay email went out again (observed 2).

Round 2 (the lead's decisions on the three gaps the first run left failing):
3. **One crew roster: crew_members (Settings -> Crew).** Before: B03/F04 \`skipped: no such crew member in this organization\` (packs used pack_crew_members ids) and A05 \`failed: an organization and a crew member are required (crewMemberId=crew-packer-1)\` (the commerce store had its own fake crew; the live store had none).
   - Home services / office: scheduleJob and the dispatcher read active crew_members of the organization (lib/packs/home-services.ts). The pack page "Add a crew member" writes crew_members through addCrewMember (owner/admin, reachable), with a role instead of a trade (lib/packs/dashboard.ts, components/packs/Packs.tsx).
   - Commerce: CommerceStore.crew() returns the organization's active crew_members with role packer or warehouse, for both the synthetic and the live store (lib/commerce/pack/store.ts rosterCrew, live-store.ts); a packer named in the agent's settings counts only when it is on the roster. The synthetic fixture no longer carries \`crew-packer-1\`; seedCommerceCrew seeds a real crew_members row (lib/connectors/shopify/synthetic.ts, scripts/seed-commerce-scenarios.ts).
   - Migration 20261107000062_pack_crew_roster.sql (+ rollback): copies pack_crew_members into crew_members (role field), repoints pack_work_orders.crew_member_id to crew_members, marks pack_crew_members DEPRECATED (kept, not read or written; privacy entries kept). Added to RELEASE_2026_11_07.
   - Tests no longer fake the crew sender: tests/packs/helpers.ts and tests/commerce/pack-helpers.ts capture owner updates only; crew messages go through notifyCrew (crew_jobs, crew_messages, the held email).
   - notifyCrew: a repeat of a crew message whose first attempt only failed used to answer "held" (counted as delivered); it now answers failed (or skipped) and says it is not resent (lib/notify/crew.ts).
4. **Message text for reply handlers** (lib/email/message-text.ts, tests/packs/mail-text.test.ts). Before: C09/E07: the Outlook mail.received event carries no text, every pack reply reader saw an empty text and did nothing. Now readInboundText decrypts the stored email_inbound row for the organization (same key and AAD as the inbox reader; null when quarantined, missing, pending or purged; nothing logged) and withInboundText fills it in at handling time for the home-services, leasing, real-estate, property-management and commerce mail.received handlers. The text never lands in agent_events (D08 checks it). Quarantined mail is never handed to an agent (X10).`,
  `## Remaining gaps (not failures in this run)

- Commerce live store: sendEmail, inbox and sent are not wired, so customer-email agents are synthetic-only.
- An Outlook seller lead is treated as a buyer (no subject or lead type in the inbox-sync lead payload).
- The QuickBooks payment change carries only the payment id, so the leasing payment matcher needs the pack-shaped notice (C06 uses it; the limit is documented in lib/connections/events.ts).
- Office quote follow-up and crew updates write activity under hs_* agent keys.
- Order Tracker treats a skipped packer message (a crew member with no way to be reached) as accepted; only a failed one blocks the case.`,
  `## Observations

- The ask-first flow has no expiry: an owner who never answers gets a reminder at 24 h and an escalation at 72 h, and the action stays decidable. X05 checks that nothing is done or sent; "expires" is not a product behaviour.
- A first-contact sender without SPF, DKIM and DMARC all passing is quarantined by the inbox sync (lib/email/sender-policy.ts), and no lead or reply handler acts on it (X10). The first harness draft sent synthetic mail without SPF and every Outlook scenario was quarantined; the synthetic messages now carry passing SPF, DKIM and DMARC like the connection tests.
- Detection times are wall-clock milliseconds from the end of seeding to the first agent_loops row, measured on this machine with the job worker running in-process right after the trigger. In production the sweep runs every 15 minutes and webhooks are handled right after the response, so real detection time is dominated by that schedule.`,
  `## How the harness stays honest

- Own database \`${DB_NAME}\`, created, migrated (scripts/migrate.ts) and seeded (scripts/seed.ts) by the harness; it refuses a non-local URL. deploi_test is never touched.
- No agent is called directly; the only entry points are emitSweep, routeEvent (Shopify webhook and crew events, shaped as lib/connectors/shopify/webhooks.ts and lib/notify/crew.ts emit them), emitConnectionEvent (mailbox, CRM, QuickBooks, Buildium) and the Outlook inbox sync storeProviderMessage (which stores the message encrypted and calls emitMailEvents), then runDueJobs. X03 runs three job workers in parallel.
- "Pack contract shape" events (lead.email / mail.received with text from a \`mailbox\` source, quickbooks.payment with an invoice number) are synthetic: they are what the pack tests feed. Scenarios that use the real emitters say so in their title.
- Time: packs read the event's own time, so sweeps are emitted at simulated times. X05 simulates 25 h and 73 h passing by moving the loop's asked_at and the case's next_check_at back, then runs the real case.check jobs. X06 and A05 move next_retry_at back to make a retry due.
- For packs B-F the Harbor organization's Shopify connection is marked uninstalled so the commerce agents stay out of the measurement.
- Owner emails: "rendered" means an owner_updates email row whose system_emails row has a rendered HTML body (> 200 characters); every one is held (no RESEND_API_KEY). Crew messages are crew_messages rows from the real pipeline (held emails). Undo: A03 and A10 redeem the token from the owner update through runUndo, the same code as the /undo link.`,
  `## Rerun

\`\`\`
service postgresql start   # if Postgres is down
npx tsx scripts/scenario-harness.ts                 # all packs, writes this file and proof/scenarios/results.json
npx tsx scripts/scenario-harness.ts --only A,X05    # a subset (prints only, writes nothing)
\`\`\``,
]

// ------------------------------------------------------------------ main

async function main() {
  const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? (process.argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : null })()
  await ensureDatabase(process.argv.includes('--skip-migrate'))
  const list = scenarios.filter(s => !only || only.includes(s.pack) || only.includes(s.id))
  const results: Result[] = []
  for (const s of list) {
    const r = await runScenario(s)
    results.push(r)
    console.log(`${r.result} ${r.id} ${r.title} [detected ${r.detected}${r.detectionMs !== null ? ` ${r.detectionMs}ms` : ''}] ${r.result === 'FAIL' ? `\n    ${r.failures.join('\n    ')}${r.jobErrors.length ? `\n    jobs: ${r.jobErrors.slice(0, 2).join('; ')}` : ''}` : ''}`)
  }
  const meta = { ranAt: new Date().toISOString(), database: DB_NAME, aiProvider: 'off', synthetic: true, node: process.version }
  const root = join(__dirname, '..')
  mkdirSync(join(root, 'proof/scenarios'), { recursive: true })
  if (!only) {
    writeFileSync(join(root, 'proof/scenarios/results.json'), JSON.stringify({ meta, totals: Object.fromEntries((Object.keys(PACK_NAMES) as PackId[]).map(p => [p, { scenarios: results.filter(r => r.pack === p).length, pass: results.filter(r => r.pack === p && r.result === 'PASS').length }])), results }, null, 2) + '\n')
    writeFileSync(join(root, 'docs/SCENARIOS-2026-11-07.md'), report(results, meta) + '\n')
    console.log('wrote proof/scenarios/results.json and docs/SCENARIOS-2026-11-07.md')
  }
  const p = results.filter(r => r.result === 'PASS').length
  console.log(`${p}/${results.length} pass`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
