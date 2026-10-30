/**
 * Reply threading for agent mailboxes, with synthetic inbound mail (no network):
 *  - the tagged Reply-To token alone threads a reply, even when the reply carries no In-Reply-To or
 *    References (as if the provider dropped our custom headers);
 *  - In-Reply-To alone also threads (a client that replies to the From address instead);
 *  - neither: stored as unthreaded, never attached to a random message;
 *  - a token from another organization's mailbox never threads across organizations.
 * Plus the screens built on it: the approval inbox, mailbox conversations (content hidden from staff
 * and other organizations), and the rendered weekly email (escaped).
 */
import './env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { templatePolicy } from '../../lib/agents/templates'
import { approveMessage, createAgentMessages } from '../../lib/email/engine'
import { processInbound } from '../../lib/email/inbound'
import { agentMailThreads } from '../../lib/email/threads'
import { listInbox } from '../../lib/agents/inbox'
import { runAgent } from '../../lib/agents/run'
import { renderWeeklyHtml } from '../../lib/agents/weekly'
import { setEmailFetch } from '../../lib/email/adapters/http'
import type { ReceivedEmail } from '../../lib/email/adapters/deploi'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB, merchantActor, staffActor, resetMerchant } from './helpers'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'

const ready = await prepareDb()
const DOMAIN = 'agents.deploi.test'
const SUPPLIER = 'orders@supplier.example'

beforeEach(async () => {
  process.env.AGENT_MAIL_DOMAIN = DOMAIN
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.EMAIL_LIVE_SENDS = 'allowlist'
  process.env.EMAIL_TEST_RECIPIENTS = '@supplier.example'
  let n = 0
  setEmailFetch(async (url, init) => {
    if (url.endsWith('/emails') && init.method === 'POST') return new Response(JSON.stringify({ id: `re_${++n}` }), { status: 200 })
    throw new Error(`unexpected HTTP call in test: ${init.method} ${url}`)
  })
  if (ready) { await resetMerchant(NW); await resetMerchant(HB) }
})
afterEach(() => { setEmailFetch(null); for (const k of ['AGENT_MAIL_DOMAIN', 'RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS']) delete process.env[k] })

/** A granted Supplier Chaser (after-approval email) with one restock request sent through the fake Resend. */
async function chaserWithSentRequest(actor: Actor, m: typeof NW) {
  const raw = templatePolicy('supplier_chaser', { connectionId: m.conn, timezone: 'UTC', supplierAddress: SUPPLIER })
  const c = await createAgent(actor, { name: 'Chaser', taskText: '', policy: { ...raw, email: { ...(raw.email as Record<string, unknown>), permission: 'send_approved' } }, mailbox: true })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  const created = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `t-${c.agentId}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock request', bodyText: 'Please confirm 12 x Linen Throw.', attachments: [] } }] })
  const msg = (await admin(db => db.one<{ id: string; content_hash: string; reply_token: string; internet_message_id: string }>('select id, content_hash, reply_token, internet_message_id from email_messages where id = $1', [created.created[0].id])))!
  await approveMessage(actor, msg.id, msg.content_hash)
  return { agentId: c.agentId, mailbox: c.mailbox!.address, msg }
}
const tagged = (mailbox: string, token: string) => `${mailbox.split('@')[0]}+t-${token}@${DOMAIN}`
const mail = (id: string, to: string, over: Partial<ReceivedEmail> = {}): ReceivedEmail =>
  ({ id, from: SUPPLIER, to: [to], cc: [], subject: 'Re: Restock request', text: 'Yes, shipping Friday.', messageId: `<${id}@supplier.example>`, inReplyTo: null, references: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachmentCount: 0, receivedAt: new Date().toISOString(), ...over })
const deliver = (id: string, to: string, m: ReceivedEmail) => processInbound({ deliveryId: `d-${id}`, type: 'email.received', data: { email_id: id, to: [to] } }, async () => m)

describe.skipIf(!ready)('reply threading with synthetic inbound mail', () => {
  it('the tagged Reply-To token alone threads the reply (no In-Reply-To, no References)', async () => {
    const { mailbox, msg } = await chaserWithSentRequest(await merchantActor(NW), NW)
    const to = tagged(mailbox, msg.reply_token)
    const r = await deliver(`tok-${msg.id}`, to, mail(`tok-${msg.id}`, to, { inReplyTo: null, references: [] }))
    expect(r).toMatchObject({ outcome: 'stored', items: [{ classification: 'reply', status: 'accepted', threadMessageId: msg.id }] })
  })

  it('In-Reply-To alone also threads (a reply sent to the plain address)', async () => {
    const { mailbox, msg } = await chaserWithSentRequest(await merchantActor(NW), NW)
    const r = await deliver(`hdr-${msg.id}`, mailbox, mail(`hdr-${msg.id}`, mailbox, { inReplyTo: msg.internet_message_id }))
    expect(r).toMatchObject({ outcome: 'stored', items: [{ classification: 'reply', threadMessageId: msg.id }] })
  })

  it('with neither, the mail is kept unthreaded and never attached to a guessed message', async () => {
    const { mailbox, msg } = await chaserWithSentRequest(await merchantActor(NW), NW)
    const r = await deliver(`none-${msg.id}`, mailbox, mail(`none-${msg.id}`, mailbox))
    expect(r).toMatchObject({ outcome: 'stored', items: [{ classification: 'other', threadMessageId: null }] })
    const row = await admin(db => db.one<{ reply_count: number }>('select reply_count from email_messages where id = $1', [msg.id]))
    expect(row!.reply_count).toBe(0)
  })

  it('a token from another organization never threads across organizations', async () => {
    const a = await chaserWithSentRequest(await merchantActor(NW), NW)
    const b = await chaserWithSentRequest(await merchantActor(HB), HB)
    // HB's mailbox address with NW's token: the token belongs to another mailbox, so no thread
    const forged = tagged(b.mailbox, a.msg.reply_token)
    const r = await deliver(`x-${a.msg.id}`, forged, mail(`x-${a.msg.id}`, forged))
    expect(r).toMatchObject({ outcome: 'stored', items: [{ threadMessageId: null }] })
  })
})

describe.skipIf(!ready)('screens: approval inbox, mailbox conversations, weekly email', () => {
  it('the inbox lists approvable changes and drafts separately, for the owning organization only', async () => {
    const actor = await merchantActor(NW)
    const base = { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
    const drafter = await createAgent(actor, { name: 'Drafter', taskText: '', policy: base })
    await grantPolicy(actor, drafter.agentId, drafter.policyId, drafter.policyHash)
    await runAgent(drafter.agentId, { trigger: 'test', actor: actor.label })
    const inbox = await listInbox(actor)
    expect(inbox.changes.length).toBe(5)
    expect(inbox.changes.every(c => c.kind === 'draft')).toBe(true)
    expect((await listInbox(await merchantActor(HB))).changes).toEqual([])
  })

  it('mailbox conversations show the sent message, the threaded reply and quarantined mail; staff and other orgs see no content', async () => {
    const actor = await merchantActor(NW)
    const { agentId, mailbox, msg } = await chaserWithSentRequest(actor, NW)
    const to = tagged(mailbox, msg.reply_token)
    await deliver(`r-${msg.id}`, to, mail(`r-${msg.id}`, to))
    await deliver(`q-${msg.id}`, mailbox, mail(`q-${msg.id}`, mailbox, { from: 'promo@unknown.example', subject: 'Win a prize', text: 'Click here' }))
    const t = await agentMailThreads(actor, agentId)
    expect(t.threads[0]).toMatchObject({ id: msg.id, status: 'accepted', subject: 'Restock request' })
    expect(t.threads[0].replies[0]).toMatchObject({ classification: 'reply', text: 'Yes, shipping Friday.' })
    expect(t.other[0]).toMatchObject({ status: 'quarantined', from_address: 'promo@unknown.example' })
    const staff = await agentMailThreads(await staffActor(), agentId)
    expect(staff.threads[0].body).toBeNull()
    expect(staff.threads[0].replies[0].text).toBeNull()
    await expect(agentMailThreads(await merchantActor(HB), agentId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the rendered weekly email escapes every value and labels the estimate', () => {
    const html = renderWeeklyHtml({ orgName: '<script>x</script>', weekStart: '2026-10-26', weekEnd: '2026-11-01', attention: [{ kind: 'emails', count: 1, label: 'email(s) <b>waiting</b>' }],
      agents: [{ agentId: 'a', name: 'Bad <img src=x onerror=alert(1)>', status: 'active', runs: 1, verified: 2, drafted: 0, failed: 0, emailsAccepted: 0, emailsDrafted: 0, tasksDone: 0 }],
      estimate: { minutes: 6, formula: '2 verified change(s) × 3 min', label: 'Estimate' } }, 'https://app.example')
    expect(html).not.toContain('<script>x</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toMatch(/Estimated time saved: about 6 minutes/)
    expect(html).toContain('This is an estimate, not a measurement')
  })
})
