/**
 * Synthetic demo data for the agent platform screenshots. Local database only (refuses anything but a
 * localhost DATABASE_URL), synthetic Northwind store, no network: Resend is replaced by an in-process
 * fake and inbound mail is handed to processInbound directly.
 *   npx tsx --env-file=.env.local scripts/seed-platform-demo.ts
 * Afterwards, remove the demo agents and their work (the standard seed's agents are kept), then re-run `scripts/seed.ts`:
 *   npx tsx --env-file=.env.local scripts/seed-platform-demo.ts --remove
 */
import { admin } from '../lib/db'
import { uuidFrom } from '../lib/ids'
import '../lib/connectors'
import { setSyntheticState } from '../lib/connectors/shopify/synthetic'
import { northwindState } from '../lib/connectors/shopify/demo-store'
import { createAgent, grantPolicy } from '../lib/agents/lifecycle'
import { templatePolicy, templateByKey } from '../lib/agents/templates'
import { runAgent } from '../lib/agents/run'
import { assignTask, runTask } from '../lib/agents/tasks'
import { approveMessage } from '../lib/email/engine'
import { processInbound } from '../lib/email/inbound'
import { setEmailFetch } from '../lib/email/adapters/http'
import type { ReceivedEmail } from '../lib/email/adapters/deploi'
import type { Actor } from '../lib/engine/actor'
import type { Session } from '../lib/session'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) { console.error('refusing: DATABASE_URL is not a local database'); process.exit(1) }

const ORG = uuidFrom('merchant:northwind'), CONN = uuidFrom('connection:northwind'), OWNER = 'owner@northwind-goods.example'
const SUPPLIER = 'orders@northwind-supplier.example'
const DOMAIN = process.env.AGENT_MAIL_DOMAIN ?? 'agents.getdeploi.test'
const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString()

// fake Resend: accepts sends, nothing leaves the machine
process.env.EMAIL_LIVE_SENDS = 'allowlist'
process.env.EMAIL_TEST_RECIPIENTS = '@northwind-supplier.example'
process.env.RESEND_API_KEY ||= 're_demo_fake'
let sent = 0
setEmailFetch(async (u, init) => {
  if (u.endsWith('/emails') && init.method === 'POST') return new Response(JSON.stringify({ id: `re_demo_${++sent}` }), { status: 200 })
  throw new Error(`demo seed: unexpected HTTP call ${init.method} ${u}`)
})

/** Remove every Northwind agent not created by the standard seed, with its work; the seed's own agents stay. */
async function remove() {
  await admin(async db => {
    const ids = (await db.query<{ id: string }>(`select id from agents where connection_id = $1 and created_by not like 'seed:%'`, [CONN])).map(r => r.id)
    if (!ids.length) return
    await db.query('delete from email_inbound where agent_id = any($1::uuid[])', [ids])
    await db.query(`delete from inbound_webhook_events where provider = 'resend' and delivery_id like 'demo-%'`)
    await db.query('delete from email_messages where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from email_accounts where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from agent_tasks where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from agent_runs where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from executions where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from approvals where proposal_id in (select id from proposals where agent_id = any($1::uuid[]))', [ids])
    await db.query('delete from proposals where agent_id = any($1::uuid[])', [ids])
    await db.query('update issues set agent_id = null where agent_id = any($1::uuid[])', [ids])
    await db.query('update agents set active_policy_id = null where id = any($1::uuid[])', [ids])
    await db.query('delete from agent_policies where agent_id = any($1::uuid[])', [ids])
    await db.query('delete from agents where id = any($1::uuid[])', [ids])
    console.log(JSON.stringify({ removed: ids.length }))
  })
}

async function main() {
  const uid = (await admin(db => db.one<{ id: string }>('select id from profiles where lower(email) = $1', [OWNER])))!.id
  const session: Session = { uid, email: OWNER, role: 'client', agencyId: ORG, orgType: 'merchant' }
  const actor: Actor = { kind: 'profile', session, orgId: ORG, label: `user:${OWNER}` }

  // start clean: synthetic store back to its seeded state, earlier agents and their work removed
  await admin(async db => {
    await db.query('delete from email_inbound where org_id = $1', [ORG]).catch(() => undefined)
    await db.query(`delete from inbound_webhook_events where provider = 'resend' and delivery_id like 'demo-%'`)
    await db.query('delete from email_messages where org_id = $1', [ORG])
    await db.query('delete from email_accounts where org_id = $1', [ORG])
    await db.query('delete from agent_tasks where org_id = $1', [ORG]).catch(() => undefined)
    await db.query('delete from agent_runs where agent_id in (select id from agents where connection_id = $1)', [CONN])
    await db.query('delete from executions where connection_id = $1', [CONN])
    await db.query('delete from approvals where proposal_id in (select id from proposals where connection_id = $1)', [CONN])
    await db.query('delete from proposals where connection_id = $1', [CONN])
    await db.query('delete from issues where connection_id = $1', [CONN])
    await db.query('delete from scans where connection_id = $1', [CONN])
    await db.query('update agents set active_policy_id = null where connection_id = $1', [CONN])
    await db.query('delete from agents where connection_id = $1', [CONN])
  })
  await setSyntheticState(CONN, northwindState())

  const make = async (name: string, policy: Record<string, unknown>, opts: { mailbox?: boolean; templateKey?: string; task?: string } = {}) => {
    const c = await createAgent(actor, { name, taskText: opts.task ?? '', policy, mailbox: opts.mailbox, templateKey: opts.templateKey ?? null })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    return c
  }
  const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: ['preorder', 'pre-order', 'backorder', 'made-to-order'], flagInStockVariants: true } } }

  // 1. Stock Guardian: makes changes on its own, home products only, for 6 months
  const guardian = await make('Stock Guardian', { connectionId: CONN, productScope: { mode: 'tags', tags: ['home'] }, ...STOCK, approvalMode: 'autonomous', validUntil: inDays(180), limits: { maxChangesPerRun: 10, maxChangesPerDay: 20 } },
    { task: 'Stop home products selling when they are out of stock. Fix it without asking, for the next six months.' })
  await runAgent(guardian.agentId, { trigger: 'manual', actor: actor.label })

  // 1b. Stock Reviewer: asks before each change, napkins and storage jars only
  const reviewer = await make('Stock Reviewer', { connectionId: CONN, productScope: { mode: 'products', productIds: ['gid://shopify/Product/1009', 'gid://shopify/Product/1010'] }, ...STOCK, approvalMode: 'review' },
    { task: 'Check the napkins and storage jars for overselling. Ask me before changing anything.' })
  await runAgent(reviewer.agentId, { trigger: 'manual', actor: actor.label })

  // 2. Inventory Watcher from its template: drafts only, with its own address
  const watcher = await make('Inventory Watcher', templatePolicy('inventory_watcher', { connectionId: CONN, timezone: 'America/New_York', notify: OWNER }), { mailbox: true, templateKey: 'inventory_watcher', task: templateByKey('inventory_watcher')!.job })
  await runAgent(watcher.agentId, { trigger: 'manual', actor: actor.label })

  // 3. Supplier Chaser from its template, widened to "send after I approve"
  const raw = templatePolicy('supplier_chaser', { connectionId: CONN, timezone: 'America/New_York', supplierAddress: SUPPLIER })
  const chaser = await make('Supplier Chaser', { ...raw, email: { ...(raw.email as Record<string, unknown>), permission: 'send_approved' } }, { mailbox: true, templateKey: 'supplier_chaser', task: templateByKey('supplier_chaser')!.job })
  await runAgent(chaser.agentId, { trigger: 'manual', actor: actor.label })
  const msgs = await admin(db => db.query<{ id: string; content_hash: string; reply_token: string; internet_message_id: string }>(
    `select id, content_hash, reply_token, internet_message_id from email_messages where account_id = $1 and status = 'awaiting_approval' order by created_at`, [chaser.mailbox!.id]))
  // the merchant approved the first request; the others still wait in the approval inbox
  if (msgs[0]) {
    await approveMessage(actor, msgs[0].id, msgs[0].content_hash)
    const local = chaser.mailbox!.address.split('@')[0]
    const tagged = `${local}+t-${msgs[0].reply_token}@${DOMAIN}`
    const mail = (id: string, to: string, over: Partial<ReceivedEmail>): ReceivedEmail => ({ id, from: SUPPLIER, to: [to], cc: [], subject: 'Re: Restock request', text: '', messageId: `<${id}@northwind-supplier.example>`, inReplyTo: null, references: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachmentCount: 0, receivedAt: new Date().toISOString(), ...over })
    const deliver = (id: string, to: string, m: ReceivedEmail) => processInbound({ deliveryId: `demo-${id}`, type: 'email.received', data: { email_id: id, to: [to] } }, async () => m)
    await deliver('demo-reply-1', tagged, mail('demo-reply-1', tagged, { inReplyTo: msgs[0].internet_message_id, text: 'Hi,\n\nThanks for the order. We can ship 24 units on Friday; tracking to follow.\n\nBest,\nDana\nNorthwind Supplier Co.' }))
    await deliver('demo-promo-1', chaser.mailbox!.address, mail('demo-promo-1', chaser.mailbox!.address, { from: 'deals@bulk-promo.example', subject: 'You have won a $500 gift card', text: 'Click here to claim your prize and confirm your bank details.', authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } }))
  }

  // 3b. Store Health Checker from its template, widened to "send after I approve": its report waits in the inbox
  const hraw = templatePolicy('store_health_checker', { connectionId: CONN, timezone: 'America/New_York', notify: OWNER })
  const health = await make('Store Health Checker', { ...hraw, email: { ...(hraw.email as Record<string, unknown>), permission: 'send_approved' } }, { mailbox: true, templateKey: 'store_health_checker', task: templateByKey('store_health_checker')!.job })
  await runAgent(health.agentId, { trigger: 'manual', actor: actor.label })

  // 3c. Competitor & Trend Watcher on synthetic competitor stores (.example, never contacted): the first run
  // records a starting point per store, the second reports changes; an email summary is drafted, never sent
  const traw = templatePolicy('competitor_watcher', { connectionId: CONN, timezone: 'America/New_York', notify: OWNER, competitor: {
    stores: ['https://linen-and-loom.example', 'https://harbor-home.example', 'https://oak-and-ember.example', 'https://plain-boutique.example', 'https://private-label.example'],
    keywords: [], cadence: 'daily', emailSummary: true } })
  const trend = await make('Competitor & Trend Watcher', traw, { mailbox: true, templateKey: 'competitor_watcher', task: templateByKey('competitor_watcher')!.job })
  // the starting point yesterday morning, the comparison this morning (synthetic stores; the times are the only thing set)
  await runAgent(trend.agentId, { trigger: 'manual', actor: actor.label, now: new Date(Date.now() - 26 * 3600e3) })
  await runAgent(trend.agentId, { trigger: 'schedule', actor: 'system:scheduler', now: new Date(Date.now() - 2 * 3600e3) })
  const tc = await assignTask(actor, trend.agentId, 'Check my competitors now')
  if (tc.status === 'queued') await runTask(tc.id, { actor: actor.label })
  await assignTask(actor, trend.agentId, "Estimate my competitors' sales and revenue")

  // 4. tasks on the Stock Guardian: one inside the rules (runs), one that needs approval, one refused
  const t1 = await assignTask(actor, guardian.agentId, 'Check overselling now on products tagged home.')
  if (t1.status === 'queued') await runTask(t1.id, { actor: actor.label })
  await assignTask(actor, guardian.agentId, 'Fix prices automatically on all products')
  await assignTask(actor, guardian.agentId, 'Delete the products that have not sold this year')

  const counts = await admin(db => db.one<Record<string, number>>(`select
    (select count(*)::int from agents where org_id = $1 and status <> 'deleted') as agents,
    (select count(*)::int from proposals where connection_id = $2 and status = 'pending_approval') as pending,
    (select count(*)::int from executions where connection_id = $2) as executions,
    (select count(*)::int from email_messages where org_id = $1) as emails,
    (select count(*)::int from email_inbound where org_id = $1) as inbound,
    (select count(*)::int from agent_tasks where org_id = $1) as tasks,
    (select count(*)::int from competitor_findings where org_id = $1) as competitor_findings`, [ORG, CONN]))
  console.log(JSON.stringify({ ...counts, fakeSends: sent, guardian: guardian.agentId, watcher: watcher.agentId, chaser: chaser.agentId, reviewer: reviewer.agentId, trend: trend.agentId }))
}

(process.argv.includes('--remove') ? remove() : main()).then(() => process.exit(0), e => { console.error(e); process.exit(1) })
