/**
 * Email system, end to end against a fake Resend and synthetic inbound mail (no network):
 * customer inbox threading and read state, a person's reply through the same send path and gates,
 * unsubscribe link + header and one-click suppression, bounce/complaint suppression, inbound loop
 * protection, attachment metadata, the per-organization daily cap, and the organization stop holding sends.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { approveMessage, createAgentMessages, sendMessage } from '../../lib/email/engine'
import { processInbound } from '../../lib/email/inbound'
import { getInboxThread, listInboxThreads, markThread, replyToThread, assignThread } from '../../lib/email/inbox'
import { mayTriggerAgentReply, autoReplyReason } from '../../lib/email/loop'
import { unsubscribeToken, verifyUnsubscribeToken } from '../../lib/email/unsubscribe'
import { stopAllAgents } from '../../lib/agents/lifecycle'
import { GET as unsubGET, POST as unsubPOST } from '../../app/api/webhooks/agent-mail/unsubscribe/route'
import type { ReceivedEmail } from '../../lib/email/adapters/deploi'
import type { Actor } from '../../lib/engine/actor'
import { merchantActor, staffActor, resetMerchant } from '../merchant/helpers'
import { NW, HB, cleanInfra } from './helpers'
import { fakeResend, restoreEmail, chaser, SUPPLIER, DOMAIN, sent } from './email-env'

const ready = await prepareDb()
const tagged = (mailbox: string, token: string) => `${mailbox.split('@')[0]}+t-${token}@${DOMAIN}`
const mail = (id: string, to: string, over: Partial<ReceivedEmail> = {}): ReceivedEmail =>
  ({ id, from: SUPPLIER, to: [to], cc: [], subject: 'Re: Restock request', text: 'Yes, shipping Friday.', messageId: `<${id}@supplier.example>`, inReplyTo: null, references: [], authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachmentCount: 0, receivedAt: new Date().toISOString(), ...over })
const deliver = (id: string, to: string, m: ReceivedEmail) => processInbound({ deliveryId: `d-${id}`, type: 'email.received', data: { email_id: id, to: [to] } }, async () => m)
const msg = (id: string) => admin(db => db.one<{ id: string; status: string; status_reason: string | null; failure_code: string | null; reply_token: string; internet_message_id: string; content_hash: string; provider_message_id: string | null; reply_count: number; next_attempt_at: string | null }>('select * from email_messages where id = $1', [id]))
let seq = 0

/** A chaser with one approved, sent restock request. */
async function sentRequest(actor: Actor, m: typeof NW, subject = 'Restock request') {
  const c = await chaser(actor, m)
  const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `e-${++seq}-${c.agentId}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject, bodyText: 'Please confirm 12 x Linen Throw.', attachments: [] } }] })
  const id = r.created[0].id
  const out = await approveMessage(actor, id, (await msg(id))!.content_hash)
  return { ...c, id, out }
}
async function another(agentId: string, subject = 'Second request') {
  const r = await createAgentMessages({ agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `e-${++seq}-${agentId}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject, bodyText: 'Another one.', attachments: [] } }] })
  return r.created[0].id
}

beforeEach(async () => { fakeResend(); process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'; if (ready) { await cleanInfra(); await resetMerchant(NW); await resetMerchant(HB) } })
afterEach(restoreEmail)
afterAll(async () => { if (ready) await cleanInfra() })

describe.skipIf(!ready)('customer inbox', () => {
  it('threads inbound and outbound in order, tracks read state, and stays inside the organization', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const s = await sentRequest(nw, NW)
    expect(s.out.status).toBe('accepted')
    const m = (await msg(s.id))!
    await deliver(`r1-${s.id}`, tagged(s.mailbox, m.reply_token), mail(`r1-${s.id}`, tagged(s.mailbox, m.reply_token)))
    let threads = await listInboxThreads(nw)
    expect(threads).toHaveLength(1)
    const key = `m:${s.id}`
    expect(threads[0]).toMatchObject({ key, unread: true, inboundCount: 1, outboundCount: 1, mailbox: s.mailbox, subject: 'Restock request' })
    // a person replies; the supplier answers that reply: all one conversation
    const rep = await replyToThread(nw, key, { bodyText: 'Thanks, Friday works.', idempotencyKey: 'reply-key-0001' })
    expect(rep.status).toBe('accepted')
    const h = (await msg(rep.messageId))!
    await deliver(`r2-${s.id}`, tagged(s.mailbox, h.reply_token), mail(`r2-${s.id}`, tagged(s.mailbox, h.reply_token), { text: 'Confirmed.', receivedAt: new Date().toISOString() }))
    const { items, thread } = await getInboxThread(nw, key)
    expect(items.map(i => [i.direction, i.byPerson ? 'person' : 'agent'])).toEqual([['outbound', 'agent'], ['inbound', 'agent'], ['outbound', 'person'], ['inbound', 'agent']])
    expect(items[2]).toMatchObject({ subject: 'Re: Restock request', body: 'Thanks, Friday works.', byPerson: nw.label })
    expect(items[3].body).toBe('Confirmed.')
    expect(thread.unread).toBe(true)
    await markThread(nw, key, true)
    threads = await listInboxThreads(nw)
    expect(threads[0].unread).toBe(false)
    expect(await listInboxThreads(nw, { filter: 'unread' })).toEqual([])
    await assignThread(nw, key, s.agentId)
    expect((await listInboxThreads(nw, { filter: 'assigned' }))[0]).toMatchObject({ assignedAgentId: s.agentId })
    // other organizations and staff
    expect(await listInboxThreads(hb)).toEqual([])
    await expect(getInboxThread(hb, key)).rejects.toMatchObject({ code: 'not_found' })
    await expect(replyToThread(hb, key, { bodyText: 'x', idempotencyKey: 'reply-key-0002' })).rejects.toMatchObject({ code: 'not_found' })
    const staff = await getInboxThread(await staffActor(), key)
    expect(staff.items.every(i => i.body === null && i.subject === null)).toBe(true)
    // mail that matches no thread is its own conversation
    await deliver(`fw-${s.id}`, s.mailbox, mail(`fw-${s.id}`, s.mailbox, { from: NW.email, subject: 'Fwd: price list', text: 'see below' }))
    expect((await listInboxThreads(nw)).map(t => t.key[0]).sort()).toEqual(['i', 'm'])
  })

  it('a person\'s reply goes through the same gates: allowed recipients, idempotency, quarantine, no unsubscribe link', async () => {
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    const m = (await msg(s.id))!
    await deliver(`g1-${s.id}`, tagged(s.mailbox, m.reply_token), mail(`g1-${s.id}`, tagged(s.mailbox, m.reply_token)))
    const key = `m:${s.id}`
    sent.length = 0
    const a = await replyToThread(nw, key, { bodyText: 'Great.', idempotencyKey: 'same-key-0001' })
    const b = await replyToThread(nw, key, { bodyText: 'Great.', idempotencyKey: 'same-key-0001' })
    expect(a.status).toBe('accepted')
    expect(b).toMatchObject({ messageId: a.messageId, duplicate: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].body.to).toEqual([SUPPLIER])
    expect(String(sent[0].body.reply_to)).toMatch(/\+t-[0-9a-f]+@agents\.deploi\.test$/)
    expect((sent[0].body.headers as Record<string, string>)['List-Unsubscribe']).toBeUndefined()
    await expect(replyToThread(nw, key, { bodyText: '', idempotencyKey: 'same-key-0002' })).rejects.toMatchObject({ code: 'invalid_input' })
    // a member forwarded mail in: replying to them is outside the agent mailbox's allowed recipients
    await deliver(`fw2-${s.id}`, s.mailbox, mail(`fw2-${s.id}`, s.mailbox, { from: NW.email, subject: 'Fwd: hello' }))
    const fwd = (await listInboxThreads(nw)).find(t => t.key.startsWith('i:'))!
    await expect(replyToThread(nw, fwd.key, { bodyText: 'ok', idempotencyKey: 'fwd-key-0001' })).rejects.toThrow(/allowed recipients/)
    // a stranger is quarantined and never answered
    await deliver(`q-${s.id}`, s.mailbox, mail(`q-${s.id}`, s.mailbox, { from: 'stranger@spam.example', subject: 'Win' }))
    const q = (await listInboxThreads(nw)).find(t => t.quarantined)!
    await expect(replyToThread(nw, q.key, { bodyText: 'no', idempotencyKey: 'q-key-00001' })).rejects.toThrow(/quarantined/)
    // the drafts-only gate: an agent whose email permission is drafts cannot send, even a person's reply
    await admin(db => db.query(`update agent_policies set policy = jsonb_set(policy, '{email,permission}', '"draft"') where agent_id = $1 and status = 'active'`, [s.agentId]))
    await expect(replyToThread(nw, key, { bodyText: 'again', idempotencyKey: 'draft-key-001' })).rejects.toThrow(/only create drafts/)
  })
})

describe.skipIf(!ready)('suppression, unsubscribe, loop protection, caps', () => {
  it('agent mail carries a signed one-click unsubscribe; following it suppresses the address and blocks later sends', async () => {
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    const headers = sent[0].body.headers as Record<string, string>
    expect(headers['List-Unsubscribe']).toMatch(/^<http.*\/api\/webhooks\/agent-mail\/unsubscribe\?t=.+>$/)
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(String(sent[0].body.text)).toMatch(/To stop receiving these emails from this sender: http/)
    const url = headers['List-Unsubscribe'].slice(1, -1)
    // opening the link (a scanner, a preview) changes nothing
    expect((await unsubGET(new Request(url))).status).toBe(200)
    expect(await admin(db => db.query('select 1 from email_suppressions where org_id = $1', [NW.org]))).toHaveLength(0)
    // a forged or altered token is refused
    const t = new URL(url).searchParams.get('t')!
    expect(verifyUnsubscribeToken(t)).toMatchObject({ orgId: NW.org, address: SUPPLIER, messageId: s.id })
    expect(verifyUnsubscribeToken(t.slice(0, -2) + 'xx')).toBeNull()
    expect((await unsubPOST(new Request(url.replace(/t=[^&]+/, `t=${encodeURIComponent(unsubscribeToken({ orgId: HB.org, address: SUPPLIER, messageId: s.id })!)}`), { method: 'POST' }))).status).toBe(400)
    // one-click POST (RFC 8058)
    const r = await unsubPOST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }))
    expect(r.status).toBe(200)
    expect(await admin(db => db.query<{ reason: string }>('select reason from email_suppressions where org_id = $1 and address = $2', [NW.org, SUPPLIER]))).toEqual([{ reason: 'unsubscribed' }])
    // nothing more goes to that address, from any of the organization's senders; Harbor is unaffected
    const next = await another(s.agentId)
    expect(await approveMessage(nw, next, (await msg(next))!.content_hash)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/unsubscribed earlier/) })
    expect((await msg(next))!.failure_code).toBe('suppressed')
    const hb = await merchantActor(HB)
    expect((await sentRequest(hb, HB)).out.status).toBe('accepted')
  })

  it('a bounce or complaint marks the message and suppresses the recipient', async () => {
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    const pid = (await msg(s.id))!.provider_message_id!
    await processInbound({ deliveryId: `b-${s.id}`, type: 'email.bounced', data: { email_id: pid, to: [SUPPLIER], bounce: { message: 'mailbox does not exist' } } })
    expect(await msg(s.id)).toMatchObject({ status: 'failed', failure_code: 'bounced' })
    expect(await admin(db => db.query<{ reason: string }>('select reason from email_suppressions where org_id = $1', [NW.org]))).toEqual([{ reason: 'bounced' }])
    const next = await another(s.agentId)
    expect((await approveMessage(nw, next, (await msg(next))!.content_hash)).status).toBe('failed')
    // a complaint about a message to someone else can only suppress that message's own recipients
    await processInbound({ deliveryId: `c-${s.id}`, type: 'email.complained', data: { email_id: pid, to: ['victim@elsewhere.example'] } })
    expect((await admin(db => db.query<{ address: string }>('select address from email_suppressions where org_id = $1', [NW.org]))).map(r => r.address)).toEqual([SUPPLIER])
  })

  it('auto-replies are stored and flagged, never count as a reply, and attachments are kept as metadata only', async () => {
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    const to = tagged(s.mailbox, (await msg(s.id))!.reply_token)
    const r = await deliver(`ooo-${s.id}`, to, mail(`ooo-${s.id}`, to, { subject: 'Out of office', headers: { 'auto-submitted': 'auto-replied' },
      attachments: [{ filename: 'invoice.pdf\u0007.exe', contentType: 'application/pdf', size: 1234 }] }))
    expect(r).toMatchObject({ outcome: 'stored', items: [{ classification: 'reply', status: 'accepted', autoReply: true }] })
    expect((await msg(s.id))!.reply_count).toBe(0)
    const row = (await admin(db => db.one<{ auto_reply: boolean; auto_reply_reason: string; attachments: unknown[]; attachment_count: number; status: string }>('select * from email_inbound where provider_email_id = $1', [`ooo-${s.id}`])))!
    expect(row).toMatchObject({ auto_reply: true, auto_reply_reason: 'Auto-Submitted: auto-replied', attachment_count: 1 })
    expect(row.attachments).toEqual([{ filename: 'invoice.pdf .exe', contentType: 'application/pdf', size: 1234 }])
    expect(mayTriggerAgentReply(row)).toBe(false)
    // a real reply still counts
    await deliver(`real-${s.id}`, to, mail(`real-${s.id}`, to))
    expect((await msg(s.id))!.reply_count).toBe(1)
    expect(autoReplyReason({ subject: 'Hi', headers: { 'auto-submitted': 'no' } }, 'a@b.example', DOMAIN)).toBeNull()
    expect(autoReplyReason({ subject: 'Hi', headers: { precedence: 'bulk' } }, 'a@b.example', DOMAIN)).toBe('Precedence: bulk')
    expect(autoReplyReason({ subject: 'Hi' }, 'MAILER-DAEMON@b.example', DOMAIN)).toBe('sent by an automatic address')
    expect(autoReplyReason({ subject: 'Hi' }, `other.ab12cd@${DOMAIN}`, DOMAIN)).toBe('sent by a Deploi agent mailbox')
    expect(autoReplyReason({ subject: 'Automatic reply: away' }, 'a@b.example', DOMAIN)).toBe('automatic reply (subject)')
  })

  it('the per-organization daily cap holds further sends until tomorrow; nothing is sent', async () => {
    process.env.EMAIL_ORG_DAILY_CAP = '1'
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    expect(s.out.status).toBe('accepted')
    const next = await another(s.agentId)
    const r = await approveMessage(nw, next, (await msg(next))!.content_hash)
    expect(r.status).toBe('queued')
    const row = (await msg(next))!
    expect(row.status_reason).toMatch(/daily limit of 1 emails is reached/)
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now())
    expect(sent).toHaveLength(1)
    // Harbor has its own cap
    expect((await sentRequest(await merchantActor(HB), HB)).out.status).toBe('accepted')
  })

  it('the organization stop holds every send and refuses replies', async () => {
    const nw = await merchantActor(NW)
    const s = await sentRequest(nw, NW)
    const next = await another(s.agentId)
    await admin(db => db.query(`update email_messages set status = 'queued', approval_kind = 'individual', approved_hash = content_hash, approved_by = 'test', approved_at = now() where id = $1`, [next]))
    await admin(db => db.query(`insert into org_controls (org_id, agents_stopped, stop_reason, stopped_by, stopped_at) values ($1, true, 'drill', 'test', now())`, [NW.org]))
    const before = sent.length
    expect(await sendMessage(next, { actor: 'test' })).toMatchObject({ status: 'queued', reason: expect.stringMatching(/^held: all agents/) })
    expect(sent.length).toBe(before)
    await expect(replyToThread(nw, `m:${s.id}`, { bodyText: 'x', idempotencyKey: 'stop-key-0001' })).rejects.toThrow(/stopped/)
    await admin(db => db.query('delete from org_controls where org_id = $1', [NW.org]))
    // the real switch also pauses the agent, which cancels its queued mail
    await stopAllAgents(nw, 'drill')
    expect((await msg(next))!.status).toBe('cancelled')
  })
})
