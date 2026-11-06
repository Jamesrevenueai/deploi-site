import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { getSynthMail } from '../../lib/email/adapters/synthetic'
import { runOfficeAgent } from '../../lib/office/run'
import { approveOfficeAction, editOfficeAction, rejectOfficeAction } from '../../lib/office/approvals'
import { injectSyntheticInbound, mutateOfficeSynth } from '../../lib/office/synthetic'
import { NW, setupOffice, grantedAgent, widen, actions, leads, lead, t0, addDays, type OfficeSetup, resetOffice, HB, pinClock } from './helpers'

const ready = await prepareDb()
// leave no Office agents, actions or connections behind for other test files
afterAll(async () => { if (ready) { await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })

describe.skipIf(!ready)('Lead Follow-up end to end (synthetic HubSpot and mailbox)', () => {
  let s: OfficeSetup
  const T = t0()
  afterEach(() => { vi.useRealTimers() })
  beforeEach(async () => { pinClock(T); s = await setupOffice(NW, [lead('701', 'ana@acme-studio.example', new Date(T.getTime() - 3600e3))]) })

  it('drafts only: shows the exact personalised email and sends nothing', async () => {
    const agent = await grantedAgent(s, 'lead_followup')
    const r = await runOfficeAgent(agent, { trigger: 'test', now: T })
    expect(r.status).toBe('completed')
    const [a] = await actions(agent)
    expect(a.status).toBe('draft')
    expect(a.kind).toBe('send_email')
    expect(a.payload.to).toBe('ana@acme-studio.example')
    expect(a.payload.subject).toContain('Acme Studio')
    expect(a.payload.body).toMatch(/^Hi Ana,/)
    expect(a.payload.body).toContain('We make ceramic tableware for cafes.')
    expect(await admin(db => db.query('select id from email_messages where office_agent_id = $1', [agent]))).toHaveLength(0)
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
    // a second run proposes nothing new (one action per lead touch)
    await runOfficeAgent(agent, { trigger: 'test', now: new Date(T.getTime() + 60e3) })
    expect(await actions(agent)).toHaveLength(1)
  })

  it('after approval: the exact content is approved; an edit invalidates the approval; approval sends once', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_approved' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    const [a] = await actions(agent)
    expect(a.status).toBe('awaiting_approval')
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
    const edited = await editOfficeAction(s.actor, a.id, { subject: 'Hello Ana', shownHash: a.payload_hash })
    expect(edited.payloadHash).not.toBe(a.payload_hash)
    await expect(approveOfficeAction(s.actor, a.id, a.payload_hash, { now: T })).rejects.toMatchObject({ code: 'hash_mismatch' })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
    const out = await approveOfficeAction(s.actor, a.id, edited.payloadHash, { now: T })
    expect(out.status).toBe('succeeded')
    const sent = (await getSynthMail(s.mailboxId)).sent
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: ['ana@acme-studio.example'], cc: [], subject: 'Hello Ana' })
    // approving again or re-running never sends a second copy
    await expect(approveOfficeAction(s.actor, a.id, edited.payloadHash, { now: T })).rejects.toMatchObject({ code: 'not_pending' })
    await runOfficeAgent(agent, { trigger: 'test', now: new Date(T.getTime() + 60e3) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
    const [l] = await leads(agent)
    expect(l.touches).toBe(1)
    expect(new Date(l.next_touch_at!).getTime() - new Date(l.last_touch_at).getTime()).toBe(3 * 864e5)
    const [done] = await actions(agent)
    expect(done.verified_at).not.toBeNull()
    const audit = await admin(db => db.query<{ event: string; actor: string; detail: Record<string, unknown> }>(`select event, actor, detail from engine_audit where entity_id = $1 order by id`, [a.id]))
    expect(audit.map(x => x.event)).toEqual(expect.arrayContaining(['office.action.awaiting_approval', 'office.action.edited', 'office.action.approved', 'office.action.executing', 'office.action.succeeded']))
    expect(audit.find(x => x.event === 'office.action.approved')!.actor).toBe(`user:${NW.email}`)
  })

  it('declining the first email stops the sequence', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_approved' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    const [a] = await actions(agent)
    await rejectOfficeAction(s.actor, a.id)
    expect((await leads(agent))[0].status).toBe('stopped')
  })

  it('without asking: sends, follows up in the same thread on cadence, and stops when the lead replies', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_autonomous' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    let mail = (await getSynthMail(s.mailboxId)).sent
    expect(mail).toHaveLength(1)
    const first = (await actions(agent))[0]
    expect(first).toMatchObject({ status: 'succeeded', approval_kind: 'standing' })
    expect(first.qualification!.reasons.join(' ')).toMatch(/authorization version 1/)
    // not due yet: nothing more
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 2) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
    // due: the follow-up replies in the first thread
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 3) })
    mail = (await getSynthMail(s.mailboxId)).sent
    expect(mail).toHaveLength(2)
    expect(mail[1].subject).toBe(`Re: ${mail[0].subject}`)
    const msgs = await admin(db => db.query<{ in_reply_to: string | null; internet_message_id: string }>('select in_reply_to, internet_message_id from email_messages where office_agent_id = $1 order by created_at', [agent]))
    expect(msgs[1].in_reply_to).toBe(msgs[0].internet_message_id)
    // the lead replies: the sequence stops; no third email ever
    await injectSyntheticInbound({ accountId: s.mailboxId, from: 'ana@acme-studio.example', subject: 'Re: hi', text: 'Thanks, we are looking at options.', threadMessageId: (await actions(agent))[1].email_message_id })
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 6) })
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 9) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(2)
    expect((await leads(agent))[0]).toMatchObject({ status: 'replied' })
  })

  it('stops at the maximum number of touches, and on a lifecycle change or opt-out in HubSpot', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_autonomous' }, p => { p.leadFollowup.maxTouches = 2 })
    await mutateOfficeSynth(s.hubspotId, st => { st.contacts.push(lead('702', 'ben@bolt.example', new Date(T.getTime() - 3600e3), { firstName: 'Ben' })) })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(2)
    // Ben becomes a customer in HubSpot: no follow-up to him
    await mutateOfficeSynth(s.hubspotId, st => { st.contacts.find(c => c.id === '702')!.lifecycleStage = 'customer' })
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 3) })
    const sent = (await getSynthMail(s.mailboxId)).sent
    expect(sent).toHaveLength(3)
    expect(sent[2].to).toEqual(['ana@acme-studio.example'])
    const ls = await leads(agent)
    expect(ls.find((l) => l.hubspot_contact_id === '702')).toMatchObject({ status: 'stopped' })
    expect(ls.find((l) => l.hubspot_contact_id === '701')).toMatchObject({ status: 'completed', touches: 2 })
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 9) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(3)
  })

  it('an unsubscribe reply stops the sequence', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_autonomous' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    await injectSyntheticInbound({ accountId: s.mailboxId, from: 'ana@acme-studio.example', subject: 'Re', text: 'Please unsubscribe me.', threadMessageId: (await actions(agent))[0].email_message_id })
    await runOfficeAgent(agent, { trigger: 'test', now: addDays(T, 3) })
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
    expect((await leads(agent))[0]).toMatchObject({ status: 'stopped', stop_reason: 'unsubscribed' })
  })

  it('widening to send without asking needs a new grant; the old version keeps running until then', async () => {
    const agent = await grantedAgent(s, 'lead_followup')
    const { editOfficeAgent } = await import('../../lib/office/agents')
    const { policyFor } = await import('./helpers')
    const e = await editOfficeAgent(s.actor, agent, { policy: policyFor('lead_followup', s, { email: 'send_autonomous' }) })
    expect(e.requiresGrant).toBe(true)
    expect(e.expansion.join(' ')).toMatch(/without asking/)
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    expect((await actions(agent))[0].status).toBe('draft')
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
    // narrowing (fewer touches) applies at once
    const n = await widen(s, agent, 'lead_followup', {}, p => { p.leadFollowup.maxTouches = 2 })
    expect(n.requiresGrant).toBe(false)
  })
})
