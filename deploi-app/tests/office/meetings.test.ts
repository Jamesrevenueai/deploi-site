import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { getSynthMail } from '../../lib/email/adapters/synthetic'
import { runOfficeAgent } from '../../lib/office/run'
import { executeOfficeAction, reconcileOfficeActions } from '../../lib/office/actions'
import { approveOfficeAction } from '../../lib/office/approvals'
import { getOfficeSynth, injectOfficeFault, injectSyntheticInbound, mutateOfficeSynth } from '../../lib/office/synthetic'
import { eventIdFor } from '../../lib/office/calendar'
import { NW, setupOffice, grantedAgent, actions, lead, t0, type OfficeSetup, type TestMeeting, type TestLead, resetOffice, HB } from './helpers'

const ready = await prepareDb()
// leave no Office agents, actions or connections behind for other test files
afterAll(async () => { if (ready) { await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })
const ANA = 'ana@acme-studio.example'

async function leadReplyAsksToMeet(s: OfficeSetup, T: Date) {
  const leadAgent = await grantedAgent(s, 'lead_followup', { email: 'send_autonomous' }, undefined, 'Leads')
  await runOfficeAgent(leadAgent, { trigger: 'test', now: T })
  const first = (await actions(leadAgent))[0]
  await injectSyntheticInbound({ accountId: s.mailboxId, from: ANA, subject: 'Re: hello', text: 'Sounds good. Could we schedule a call next week?\n\nOn Tue, Sam wrote:\n> option 1', threadMessageId: first.email_message_id })
  return leadAgent
}

describe.skipIf(!ready)('Meeting Scheduler, booking and CRM Updater (synthetic providers)', () => {
  let s: OfficeSetup
  const T = t0()
  beforeEach(async () => { s = await setupOffice(NW, [lead('701', ANA, new Date(T.getTime() - 3600e3))]) })

  it('proposes 3 free slots, books the chosen one once, confirms, and the CRM updater logs it and applies the rule', async () => {
    const leadAgent = await leadReplyAsksToMeet(s, T)
    // an existing commitment early tomorrow: proposals keep the buffer around it
    const busyStart = new Date(T.getTime() + 19 * 3600e3), busyEnd = new Date(busyStart.getTime() + 3600e3)
    await mutateOfficeSynth(s.calendarId, st => { st.busy = [{ start: busyStart.toISOString(), end: busyEnd.toISOString() }] })
    const sched = await grantedAgent(s, 'meeting_scheduler', { email: 'send_autonomous', calendar: 'send_autonomous' }, undefined, 'Scheduler')
    await runOfficeAgent(leadAgent, { trigger: 'test', now: new Date(T.getTime() + 60e3) })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 120e3) })
    const m = (await admin(db => db.query<TestMeeting>('select * from office_meetings where agent_id = $1', [sched])))[0]
    expect(m).toMatchObject({ contact_email: ANA, status: 'proposed', hubspot_contact_id: '701' })
    const slots = m.proposed_slots as { start: string; end: string; label: string }[]
    expect(slots).toHaveLength(3)
    for (const sl of slots) {
      const st = new Date(sl.start), en = new Date(sl.end)
      expect(en.getTime() - st.getTime()).toBe(30 * 60e3)
      expect(st.getUTCHours()).toBeGreaterThanOrEqual(9)
      expect(en.getUTCHours() * 60 + en.getUTCMinutes()).toBeLessThanOrEqual(17 * 60)
      expect([1, 2, 3, 4, 5]).toContain(((st.getUTCDay() + 6) % 7) + 1)
      expect(st.getTime() - T.getTime()).toBeGreaterThanOrEqual(12 * 3600e3)
      expect(st.getTime() >= busyEnd.getTime() + 15 * 60e3 || en.getTime() <= busyStart.getTime() - 15 * 60e3).toBe(true)
    }
    expect(new Set(slots.map(x => x.start.slice(0, 10))).size).toBe(3)
    let sent = (await getSynthMail(s.mailboxId)).sent
    expect(sent).toHaveLength(2)
    const proposal = (await actions(sched))[0]
    expect(proposal.payload.body).toContain(`1. ${slots[0].label}`)
    // the lead's reply stopped the follow-ups
    expect((await admin(db => db.one<TestLead>('select status from office_leads where agent_id = $1', [leadAgent])))!.status).toBe('replied')

    await injectSyntheticInbound({ accountId: s.mailboxId, from: ANA, subject: 'Re: times', text: 'Option 2 works for me.', threadMessageId: proposal.email_message_id })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 180e3) })
    const cal = await getOfficeSynth(s.calendarId)
    expect(cal.events).toHaveLength(1)
    expect(cal.events[0]).toMatchObject({ start: slots[1].start, end: slots[1].end, attendees: [ANA], status: 'confirmed', meetLink: null })
    const booked = (await admin(db => db.one<TestMeeting>('select * from office_meetings where id = $1', [m.id])))!
    expect(booked).toMatchObject({ status: 'booked', calendar_event_id: cal.events[0].id })
    sent = (await getSynthMail(s.mailboxId)).sent
    expect(sent).toHaveLength(3)
    expect(sent[2].to).toEqual([ANA])
    // a repeated reply or run never books twice
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 240e3) })
    expect((await getOfficeSynth(s.calendarId)).events).toHaveLength(1)

    const crm = await grantedAgent(s, 'crm_updater', { crm: 'send_autonomous' }, p => { p.crmUpdater.rules = [{ on: 'meeting_booked', lifecycleStage: 'opportunity' }] }, 'CRM')
    const cr = await runOfficeAgent(crm, { trigger: 'test', now: new Date(T.getTime() + 300e3) })
    expect(cr).toMatchObject({ status: 'completed' })
    const hs = await getOfficeSynth(s.hubspotId)
    expect(hs.notes.length).toBe(4) // first email, proposal, booking, confirmation
    expect(hs.notes.every(n => n.contactId === '701' && /Ref deploi[0-9a-f]{20}/.test(n.body))).toBe(true)
    expect(hs.contacts[0].lifecycleStage).toBe('opportunity')
    // logging is once per action
    await runOfficeAgent(crm, { trigger: 'test', now: new Date(T.getTime() + 360e3) })
    expect((await getOfficeSynth(s.hubspotId)).notes.length).toBe(4)
  })

  it('booking is idempotent: a lost answer is reconciled by reading the event, never booked twice', async () => {
    await leadReplyAsksToMeet(s, T)
    const sched = await grantedAgent(s, 'meeting_scheduler', { email: 'send_autonomous', calendar: 'send_approved' })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 60e3) })
    const proposal = (await actions(sched))[0]
    await injectSyntheticInbound({ accountId: s.mailboxId, from: ANA, subject: 'Re', text: '3', threadMessageId: proposal.email_message_id })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 120e3) })
    const ev = (await actions(sched)).find((a) => a.kind === 'create_event')!
    expect(ev.status).toBe('awaiting_approval')
    expect(ev.payload.eventId).toBe(eventIdFor(`${NW.org}:meeting:${ev.meeting_id}:event`))
    await injectOfficeFault(s.calendarId, { op: 'insertEvent', mode: 'timeout_after_write' })
    const out = await approveOfficeAction(s.actor, ev.id, ev.payload_hash)
    expect(out.status).toBe('unknown')
    expect((await getOfficeSynth(s.calendarId)).events).toHaveLength(1)
    // a retry of the same action while unknown is refused (it is not queued)
    expect((await executeOfficeAction(ev.id)).status).toBe('unknown')
    const rec = await reconcileOfficeActions({ orgId: NW.org })
    expect(rec.find(r => r.actionId === ev.id)?.status).toBe('succeeded')
    expect((await getOfficeSynth(s.calendarId)).events).toHaveLength(1)
    // even forcing the action to run again finds the existing event by its deterministic id
    const before = (await admin(db => db.one<{ attempts: number }>('select attempts from office_actions where id = $1', [ev.id])))!.attempts
    await admin(db => db.query(`update office_actions set status = 'queued' where id = $1`, [ev.id]))
    const [a, b] = await Promise.all([executeOfficeAction(ev.id), executeOfficeAction(ev.id)])
    expect([a.status, b.status]).toContain('succeeded')
    // only one of the two concurrent calls claimed the action
    expect((await admin(db => db.one<{ attempts: number }>('select attempts from office_actions where id = $1', [ev.id])))!.attempts).toBe(before + 1)
    expect((await getOfficeSynth(s.calendarId)).events).toHaveLength(1)
  })

  it('a time that is no longer free is not booked', async () => {
    await leadReplyAsksToMeet(s, T)
    const sched = await grantedAgent(s, 'meeting_scheduler', { email: 'send_autonomous', calendar: 'send_autonomous' })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 60e3) })
    const proposal = (await actions(sched))[0]
    const m = (await admin(db => db.one<TestMeeting>('select * from office_meetings where agent_id = $1', [sched])))!
    await mutateOfficeSynth(s.calendarId, st => { st.busy.push({ start: m.proposed_slots[0].start, end: m.proposed_slots[0].end }) })
    await injectSyntheticInbound({ accountId: s.mailboxId, from: ANA, subject: 'Re', text: 'The first one please', threadMessageId: proposal.email_message_id })
    await runOfficeAgent(sched, { trigger: 'test', now: new Date(T.getTime() + 120e3) })
    expect((await getOfficeSynth(s.calendarId)).events).toHaveLength(0)
    expect((await admin(db => db.one<TestMeeting>('select status from office_meetings where id = $1', [m.id])))!.status).toBe('failed')
  })
})
