/**
 * Crew (lib/notify/crew.ts): members CRUD with roles (owners and admins manage, everyone reads, staff refused),
 * tenant isolation, notifyCrew (email through the system mailer to a test mailbox, simulated text, today's jobs
 * with changes since the last message), the one-time "Mark done" link (single use, expiry, tampering, a
 * deactivated member, GET changes nothing), "done" replies, and exactly one crew.done event per job.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { notifyCrew } from '../../lib/notify'
import { onEvent, EVENT_JOB, type AgentEvent } from '../../lib/events'
import '../../lib/events/jobs'
import { runDueJobs } from '../../lib/jobs'
/** crew.done is routed as a durable job per handler; run the queued ones. */
const drain = async () => { await runDueJobs({ kinds: [EVENT_JOB], limit: 100 }) }
import {
  addCrewMember, updateCrewMember, setCrewActive, listCrew, upsertCrewJob, crewJobsFor, addJobAsOwner, cancelJobAsOwner, markDoneAsOwner,
  previewCrewLink, completeCrewLink, handleCrewReply, crewToken, sendTodayAsOwner, type CrewMember,
} from '../../lib/notify/crew'
import { POST as donePost } from '../../app/api/crew/done/route'
import { NW, HB, merchantActor, staffActor } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { fakeResend, resetEnv, cleanNotify, sent, storedEmail } from './helpers'

const ready = await prepareDb()
const TEST_MAILBOX = 'crew.sam@notify-test.example'
const events: AgentEvent[] = []
onEvent('crew.done', 'test:invoicer', async (_db, e) => { events.push(e) })

const doneLinks = (html: string) => [...html.matchAll(/href="([^"]*\/crew\/done\/[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
const tokenOf = (url: string) => decodeURIComponent(url.split('/crew/done/')[1])
const jobRow = (ref: string, org = NW.org) => admin(db => db.one<{ id: string; status: string; done_via: string | null; last_sent: unknown }>('select id, status, done_via, last_sent from crew_jobs where org_id = $1 and job_ref = $2', [org, ref]))

describe.skipIf(!ready)('crew', () => {
  let ownerA: Awaited<ReturnType<typeof merchantActor>>
  let memberA: Awaited<ReturnType<typeof person>>
  let viewerA: Awaited<ReturnType<typeof person>>
  let sam: CrewMember
  beforeAll(async () => {
    await cleanNotify([NW.org, HB.org])
    ownerA = await merchantActor(NW)
    memberA = await person(NW, 'member', 'crew-member')
    viewerA = await person(NW, 'viewer', 'crew-viewer')
  })
  beforeEach(async () => {
    await drain() // jobs an earlier test queued and did not run

    fakeResend(); process.env.RESEND_API_KEY = 're_test_key'; process.env.EMAIL_LIVE_SENDS = 'allowlist'; process.env.EMAIL_TEST_RECIPIENTS = '@notify-test.example'
    events.length = 0
    sam = await addCrewMember(ownerA, { name: 'Sam Rivera', role: 'field', email: TEST_MAILBOX, phone: '+1 555 555 0142', channels: ['email', 'text'] })
  })
  afterEach(async () => { resetEnv(); await cleanNotify([NW.org, HB.org]) })
  afterAll(async () => { await removePeople(NW) })

  it('owners and admins add, edit, deactivate and reactivate; members and viewers only read; staff cannot change', async () => {
    expect(sam).toMatchObject({ name: 'Sam Rivera', role: 'field', email: TEST_MAILBOX, phone: '+15555550142', channels: ['email', 'text'], active: true })
    const edited = await updateCrewMember(ownerA, sam.id, { role: 'packer', channels: ['email'] })
    expect(edited).toMatchObject({ role: 'packer', channels: ['email'], phone: '+15555550142' })
    expect((await setCrewActive(ownerA, sam.id, false)).active).toBe(false)
    expect((await setCrewActive(ownerA, sam.id, true)).active).toBe(true)
    await expect(addCrewMember(memberA, { name: 'X', role: 'packer', email: 'x@notify-test.example' })).rejects.toThrow(/cannot change organization settings/)
    await expect(updateCrewMember(viewerA, sam.id, { name: 'Y' })).rejects.toThrow(/cannot/)
    await expect(setCrewActive(memberA, sam.id, false)).rejects.toThrow(/cannot/)
    await expect(addCrewMember(await staffActor(), { name: 'S', email: 's@notify-test.example' })).rejects.toThrow(/customer organization/)
    expect((await listCrew(viewerA))).toMatchObject({ canManage: false, members: [expect.objectContaining({ id: sam.id })] })
    expect((await listCrew(ownerA)).canManage).toBe(true)
  })

  it('validation: a name, a known role, a reachable channel, valid email and phone', async () => {
    await expect(addCrewMember(ownerA, { name: '', email: 'a@b.example' })).rejects.toThrow(/name/)
    await expect(addCrewMember(ownerA, { name: 'A', role: 'boss', email: 'a@b.example' })).rejects.toThrow(/role must be/)
    await expect(addCrewMember(ownerA, { name: 'A', channels: ['email'] })).rejects.toThrow(/add an email address/)
    await expect(addCrewMember(ownerA, { name: 'A', channels: ['text'], phone: '12' })).rejects.toThrow(/international form/)
    await expect(addCrewMember(ownerA, { name: 'A', email: 'not-an-email' })).rejects.toThrow(/email address/)
    await expect(updateCrewMember(ownerA, '00000000-0000-4000-8000-000000000000', { name: 'Z' })).rejects.toThrow(/no such crew member/)
  })

  it('tenant isolation: another organization cannot read, edit or message this crew', async () => {
    const hb = await merchantActor(HB)
    expect((await listCrew(hb)).members.map(m => m.id)).not.toContain(sam.id)
    await expect(updateCrewMember(hb, sam.id, { name: 'Hijack' })).rejects.toThrow(/no such crew member/)
    await expect(setCrewActive(hb, sam.id, false)).rejects.toThrow(/no such crew member/)
    expect(await notifyCrew({ orgId: HB.org, crewMemberId: sam.id, jobRef: 'J-X', subject: '', body: 'x', dedupeKey: 'hb-try' })).toMatchObject({ status: 'skipped' })
    expect(await withUser(SESSIONS.harbor, db => db.query('select id from crew_members where id = $1', [sam.id]))).toHaveLength(0)
    expect(await withUser(SESSIONS.northwind, db => db.query('select id from crew_members where id = $1', [sam.id]))).toHaveLength(1)
    await expect(withUser(SESSIONS.northwind, db => db.query(`update crew_members set name = 'x' where id = $1`, [sam.id]))).rejects.toThrow(/permission denied/)
  })

  it('notifyCrew sends today\'s jobs by email (test mailbox) and simulated text; one message per dedupe key; changes since the last message', async () => {
    await admin(db => upsertCrewJob(db, { orgId: NW.org, jobRef: 'J-100', crewMemberId: sam.id, address: '12 Main St, Springfield', details: 'Install the shelf.', sourceAgent: 'scheduler' }))
    const r = await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-101', subject: 'Two jobs today.', body: 'Pick up 3 boxes at the depot.', address: '9 Depot Rd', photos: ['https://cdn.example.test/box.jpg', 'javascript:alert(1)'], dedupeKey: 'crew-msg-1' })
    expect(r.status).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual([TEST_MAILBOX])
    expect(sent[0].subject).toMatch(/^\[Deploi\] Your jobs for .*: 2 open$/)
    expect(sent[0].html).toContain('12 Main St, Springfield')
    expect(sent[0].html).toContain('Pick up 3 boxes at the depot.')
    expect(sent[0].html).toContain('href="https://cdn.example.test/box.jpg"')
    expect(sent[0].html).not.toContain('javascript:')
    expect(doneLinks(sent[0].html)).toHaveLength(2)
    expect((await jobRow('J-100'))!.status).toBe('sent')
    // the stored copy and the crew log never hold a working link
    const msgs = await admin(db => db.query<{ channel: string; status: string; body: string; system_email_id: string | null }>(`select channel, status, body, system_email_id from crew_messages where org_id = $1 and direction = 'out' order by channel`, [NW.org]))
    expect(msgs.map(m => [m.channel, m.status])).toEqual([['email', 'sent'], ['text', 'simulated']])
    expect(msgs.every(m => !m.body.includes('/crew/done/'))).toBe(true)
    expect((await storedEmail(msgs[0].system_email_id!))!.body_html).not.toContain('/crew/done/')
    const text = await admin(db => db.one<{ body: string; audience: string; status: string }>(`select body, audience, status from notify_outbox where org_id = $1`, [NW.org]))
    expect(text).toMatchObject({ audience: 'crew', status: 'simulated' })
    expect(text!.body).toMatch(/^Deploi: Hi Sam Rivera, 2 jobs today/)
    expect(text!.body).toContain('1) J-100 at 12 Main St, Springfield Done: http')
    // the same key again: nothing new
    expect((await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-101', subject: '', body: 'x', dedupeKey: 'crew-msg-1' })).reason).toMatch(/duplicate/)
    expect(sent).toHaveLength(1)
    // a change, then a new message says what changed
    await admin(db => upsertCrewJob(db, { orgId: NW.org, jobRef: 'J-100', address: '14 Main St, Springfield' }))
    await admin(db => upsertCrewJob(db, { orgId: NW.org, jobRef: 'J-102', crewMemberId: sam.id, details: 'Late add' }))
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: '', subject: '', body: '', dedupeKey: 'crew-msg-2' })
    expect(sent[1].html).toContain('Address changed')
    expect(sent[1].html).toContain('New job since my last message')
    expect(sent[1].subject).toMatch(/3 open \(changes inside\)$/)
  })

  it('held unless EMAIL_LIVE_SENDS allows the address: nothing reaches a real person', async () => {
    process.env.EMAIL_LIVE_SENDS = 'off'
    const r = await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-200', subject: '', body: 'x', dedupeKey: 'held-1' })
    expect(r.status).toBe('held')
    expect(sent).toHaveLength(0)
  })

  it('the Mark done link: GET only shows; the first POST marks done and emits one crew.done; then it is used', async () => {
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-300', subject: '', body: 'Deliver the order', dedupeKey: 'link-1' })
    const [url] = doneLinks(sent[0].html)
    const t = tokenOf(url)
    expect(await previewCrewLink(t)).toMatchObject({ state: 'ready', jobRef: 'J-300', crewName: 'Sam Rivera' })
    expect((await jobRow('J-300'))!.status).toBe('sent')
    const form = (tok: string) => new Request('http://localhost/api/crew/done', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' }, body: new URLSearchParams({ t: tok }).toString() })
    const res = await donePost(form(t))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/\/crew\/done\/.+\?r=done$/)
    expect(await jobRow('J-300')).toMatchObject({ status: 'done', done_via: 'link' })
    await drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'crew', type: 'crew.done', orgId: NW.org, payload: expect.objectContaining({ jobRef: 'J-300', via: 'link', crewMemberId: sam.id }) })
    expect(events[0].externalId).toMatch(/^crew\.done:/)
    // single use: again, by link or reply or owner, changes nothing and emits nothing
    expect((await completeCrewLink(t)).state).toBe('used')
    expect((await donePost(form(t))).headers.get('location')).not.toMatch(/r=done/)
    expect((await handleCrewReply({ orgId: NW.org, from: '+15555550142', text: 'DONE J-300', channel: 'text', messageId: 'sms-1' })).ok).toBe(false)
    await expect(markDoneAsOwner(ownerA, (await jobRow('J-300'))!.id)).rejects.toThrow(/already done/)
    await drain()
    expect(events).toHaveLength(1)
    expect(await previewCrewLink(t)).toMatchObject({ state: 'used' })
  })

  it('two clicks at once: exactly one completes, one event', async () => {
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-301', subject: '', body: 'x', dedupeKey: 'race-1' })
    const t = tokenOf(doneLinks(sent[0].html)[0])
    const r = await Promise.all([completeCrewLink(t), completeCrewLink(t), completeCrewLink(t)])
    expect(r.filter(x => x.state === 'ready')).toHaveLength(1)
    await drain()
    expect(events).toHaveLength(1)
  })

  it('tampered, forged, expired links and a deactivated member change nothing', async () => {
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-400', subject: '', body: 'x', dedupeKey: 'tamper-1' })
    const t = tokenOf(doneLinks(sent[0].html)[0])
    const [body, sig] = t.split('.')
    expect((await completeCrewLink(`${body}.${sig.slice(0, -3)}abc`)).state).toBe('invalid')
    const link = await admin(db => db.one<{ id: string }>(`select l.id from crew_job_links l join crew_jobs j on j.id = l.job_id where j.job_ref = 'J-400'`))
    // a validly signed token with a later expiry than the database row: the row's expiry still applies
    const past = new Date(Date.now() - 1000)
    await admin(db => db.query('update crew_job_links set expires_at = $2 where id = $1', [link!.id, past.toISOString()]))
    expect((await completeCrewLink(t)).state).toBe('expired')
    expect((await completeCrewLink(crewToken(link!.id, past)!)).state).toBe('expired')
    const bad = await donePost(new Request('http://localhost/api/crew/done', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'x.y' }) }))
    expect(bad.status).toBe(400)
    await admin(db => db.query('update crew_job_links set expires_at = now() + interval \'1 hour\' where id = $1', [link!.id]))
    await setCrewActive(ownerA, sam.id, false)
    expect((await completeCrewLink(t)).state).toBe('closed')
    expect((await jobRow('J-400'))!.status).toBe('sent')
    await drain()
    expect(events).toHaveLength(0)
  })

  it('links expire after CREW_LINK_TTL_HOURS', async () => {
    process.env.CREW_LINK_TTL_HOURS = '1'
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-401', subject: '', body: 'x', dedupeKey: 'ttl-1' })
    const t = tokenOf(doneLinks(sent[0].html)[0])
    expect((await completeCrewLink(t, new Date(Date.now() + 2 * 3600e3))).state).toBe('expired')
    expect((await completeCrewLink(t)).state).toBe('ready')
  })

  it('a "done" reply from the crew member marks the job and emits once; strangers and duplicates are ignored', async () => {
    await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-500', subject: '', body: 'x', dedupeKey: 'reply-1' })
    expect(await handleCrewReply({ orgId: NW.org, from: '+15555550999', text: 'done', channel: 'text', messageId: 'm0' })).toMatchObject({ ok: false, reason: /not an active crew member/ })
    expect(await handleCrewReply({ orgId: NW.org, from: '+15555550142', text: 'running late', channel: 'text', messageId: 'm1' })).toMatchObject({ ok: false })
    const r = await handleCrewReply({ orgId: NW.org, from: '+1 555 555 0142', text: 'Done', channel: 'text', messageId: 'm2' })
    expect(r).toMatchObject({ ok: true, jobRef: 'J-500', event: true })
    expect(await handleCrewReply({ orgId: NW.org, from: '+15555550142', text: 'Done', channel: 'text', messageId: 'm2' })).toMatchObject({ ok: false, reason: /duplicate/ })
    expect(await jobRow('J-500')).toMatchObject({ status: 'done', done_via: 'reply' })
    await drain()
    expect(events).toHaveLength(1)
    // with two open jobs a bare "done" asks which; "done J-502" by email picks it
    await admin(db => upsertCrewJob(db, { orgId: NW.org, jobRef: 'J-501', crewMemberId: sam.id }))
    await admin(db => upsertCrewJob(db, { orgId: NW.org, jobRef: 'J-502', crewMemberId: sam.id }))
    expect(await handleCrewReply({ orgId: NW.org, from: '+15555550142', text: 'done', channel: 'text', messageId: 'm3' })).toMatchObject({ ok: false, reason: /more than one open job/ })
    expect(await handleCrewReply({ orgId: NW.org, from: TEST_MAILBOX.toUpperCase(), text: 'done J-502\n\n> earlier message', channel: 'email', messageId: 'm4' })).toMatchObject({ ok: true, jobRef: 'J-502' })
    await drain()
    expect(events.map(e => e.payload.jobRef)).toEqual(['J-500', 'J-502'])
  })

  it("owner tools: today's jobs view, add a job, send now, mark done (one event), cancel; members read only", async () => {
    const j = await addJobAsOwner(ownerA, { jobRef: 'J-600', crewMemberId: sam.id, address: '1 Elm St', details: 'Measure the window' })
    expect(j).toMatchObject({ jobRef: 'J-600', status: 'scheduled', sourceAgent: 'owner', crewName: 'Sam Rivera' })
    await addJobAsOwner(ownerA, { jobRef: 'J-601', crewMemberId: sam.id })
    const view = await crewJobsFor(memberA)
    expect(view.canManage).toBe(false)
    expect(view.jobs.map(x => x.jobRef)).toEqual(['J-600', 'J-601'])
    await expect(addJobAsOwner(memberA, { jobRef: 'J-602' })).rejects.toThrow(/cannot/)
    await expect(markDoneAsOwner(viewerA, j.id)).rejects.toThrow(/cannot/)
    expect((await sendTodayAsOwner(ownerA, sam.id)).status).toBe('sent')
    expect(doneLinks(sent[0].html)).toHaveLength(2)
    await markDoneAsOwner(ownerA, j.id)
    await drain()
    expect(events).toHaveLength(1)
    const other = (await crewJobsFor(ownerA)).jobs.find(x => x.jobRef === 'J-601')!
    await cancelJobAsOwner(ownerA, other.id)
    const links = doneLinks(sent[0].html).map(tokenOf)
    expect((await Promise.all(links.map(l => completeCrewLink(l)))).map(x => x.state).sort()).toEqual(['closed', 'used'].sort())
    // the next message shows the cancellation once
    await sendTodayAsOwner(ownerA, sam.id, new Date(Date.now() + 1000))
    expect(sent[1].html).toContain('Cancelled: do not do this job')
    const hb = await merchantActor(HB)
    await expect(cancelJobAsOwner(hb, j.id)).rejects.toThrow(/already done or cancelled, or does not exist/)
    expect((await crewJobsFor(hb)).jobs).toHaveLength(0)
  })

  it('a deactivated member gets no message', async () => {
    await setCrewActive(ownerA, sam.id, false)
    expect(await notifyCrew({ orgId: NW.org, crewMemberId: sam.id, jobRef: 'J-700', subject: '', body: 'x', dedupeKey: 'inactive-1' })).toMatchObject({ status: 'skipped', reason: /deactivated/ })
    expect(sent).toHaveLength(0)
  })
})
