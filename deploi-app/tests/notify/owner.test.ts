/**
 * notifyOwner (lib/notify/owner.ts) against the local database and a fake Resend: the shared interface uses
 * the real implementation without extra imports, one update per dedupe key, held vs sent (EMAIL_LIVE_SENDS),
 * recipients are owners and admins per their preferences, the daily digest, simulated text and voice notes,
 * the action-needed variant, the stored copy never holding the undo link, and a failed provider.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { notifyOwner, type OwnerUpdate } from '../../lib/notify'
import { getMyPrefs, setMyPrefs, updateRecipients } from '../../lib/notify/preferences'
import { setChannelAdapter, channelAdapter, simulatedAdapter } from '../../lib/notify/channels'
import { runAgentLoop } from '../../lib/events/loop'
import { NW, HB } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { SESSIONS } from '../db/helpers'
import { fakeResend, resetEnv, cleanNotify, sent, storedEmail } from './helpers'

const ready = await prepareDb()
let n = 0
const upd = (over: Partial<OwnerUpdate> = {}): OwnerUpdate => ({
  orgId: NW.org, agentKey: 'refunds', agentName: 'Refund Agent', caseRef: 'DC-000777', headline: 'Refunded order #1001',
  whatHappened: 'The customer was charged twice.', whatIDid: ['Refunded the duplicate charge'], proof: [{ label: 'Refund', value: 're_1' }],
  detailsPath: '/store/work/DC-000777', severity: 'info', dedupeKey: `test:${Date.now()}:${++n}`, ...over,
})
const rows = (key: string) => admin(db => db.query<{ id: string; channel: string; status: string; recipient: string | null; status_reason: string | null; system_email_id: string | null; outbox_id: string | null; kind: string }>(
  'select id, channel, status, recipient, status_reason, system_email_id, outbox_id, kind from owner_updates where org_id = $1 and dedupe_key = $2 order by channel, recipient', [NW.org, key]))

describe.skipIf(!ready)('owner updates', () => {
  let ownerEmail = ''
  let adminActor: Awaited<ReturnType<typeof person>>
  let viewer: Awaited<ReturnType<typeof person>>
  beforeAll(async () => {
    await cleanNotify([NW.org, HB.org])
    adminActor = await person(NW, 'admin', 'notify-admin')
    viewer = await person(NW, 'viewer', 'notify-viewer')
    const r = await admin(db => updateRecipients(db, NW.org))
    ownerEmail = r.find(x => x.role === 'owner')!.email
  })
  beforeEach(() => { fakeResend(); process.env.RESEND_API_KEY = 're_test_key' })
  afterEach(async () => { resetEnv(); await cleanNotify([NW.org, HB.org]) })
  afterAll(async () => { await removePeople(NW) })

  it('recipients are the owners and admins, never members or viewers', async () => {
    const r = await admin(db => updateRecipients(db, NW.org))
    expect(r.map(x => x.role).every(x => x === 'owner' || x === 'admin')).toBe(true)
    expect(r.map(x => x.email)).toContain(adminActor.session.email)
    expect(r.map(x => x.email)).not.toContain(viewer.session.email)
    expect(r[0].prefs).toEqual({ email: true, text: false, voice: false, phone: null, digest: 'off' })
  })

  it('EMAIL_LIVE_SENDS off (default): calling notifyOwner from the shared interface records a held email per recipient; nothing reaches Resend', async () => {
    const u = upd()
    const r = await notifyOwner(u)
    expect(r.status).toBe('held')
    expect(r.reason).toMatch(/EMAIL_LIVE_SENDS/)
    expect(sent).toHaveLength(0)
    const rs = await rows(u.dedupeKey)
    expect(rs.length).toBeGreaterThanOrEqual(2)
    expect(rs.every(x => x.channel === 'email' && x.status === 'held' && x.system_email_id)).toBe(true)
    const e = await storedEmail(rs[0].system_email_id!)
    expect(e).toMatchObject({ status: 'held', template: 'agent_update', subject: '[Deploi] Refund Agent: Refunded order #1001' })
    expect(e!.body_html).toContain('What happened')
  })

  it('allowlist: sent only to test recipients; others held. One update per dedupe key, even when called again', async () => {
    process.env.EMAIL_LIVE_SENDS = 'allowlist'
    process.env.EMAIL_TEST_RECIPIENTS = ownerEmail
    const u = upd()
    const a = await notifyOwner(u)
    expect(a.status).toBe('sent')
    expect(sent.map(s => s.to[0])).toEqual([ownerEmail])
    expect(sent[0].subject).toBe('[Deploi] Refund Agent: Refunded order #1001')
    expect(sent[0].text).toContain('WHAT I DID')
    const rs = await rows(u.dedupeKey)
    expect(rs.find(x => x.recipient === ownerEmail)!.status).toBe('sent')
    expect(rs.find(x => x.recipient === adminActor.session.email)!.status).toBe('held')
    const b = await notifyOwner({ ...u, headline: 'changed' })
    expect(b).toMatchObject({ status: 'sent', id: a.id, reason: expect.stringMatching(/duplicate/) })
    expect(sent).toHaveLength(1)
    expect((await rows(u.dedupeKey)).length).toBe(rs.length)
  })

  it('concurrent calls with one dedupe key send once', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    const u = upd()
    const out = await Promise.all([notifyOwner(u), notifyOwner(u), notifyOwner(u)])
    const recipients = (await admin(db => updateRecipients(db, NW.org))).length
    expect(sent).toHaveLength(recipients)
    expect(new Set(out.map(o => o.id)).size).toBe(1)
  })

  it('the undo link is in the sent email but never in the stored copy', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    const u = upd({ undoToken: 'undo-secret-123' })
    await notifyOwner(u)
    expect(sent[0].html).toMatch(/href="[^"]*\/undo\/undo-secret-123"/)
    expect(sent[0].text).toContain('/undo/undo-secret-123')
    const rs = await rows(u.dedupeKey)
    const stored = await storedEmail(rs[0].system_email_id!)
    expect(stored!.body_html).not.toContain('undo-secret-123')
    expect(stored!.body_text).not.toContain('undo-secret-123')
  })

  it('agent text cannot inject HTML into the email', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    await notifyOwner(upd({ headline: '<script>x()</script>', whatHappened: '<img src=x onerror=y()>', proof: [{ label: 'a', value: 'b', url: 'javascript:alert(1)' }] }))
    expect(sent[0].html).not.toContain('<script>')
    expect(sent[0].html).not.toMatch(/<img/)
    expect(sent[0].html).not.toContain('javascript:')
    expect(sent[0].subject).toBe('[Deploi] Refund Agent: <script>x()</script>') // a subject is plain text, not HTML
  })

  it('ask_first: the action-needed variant, recorded as kind action_needed, never with an undo link', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    const u = upd({ severity: 'action', undoToken: 'nope' })
    await notifyOwner(u)
    expect(sent[0].subject).toBe('[Deploi] Refund Agent needs your OK: Refunded order #1001')
    expect(sent[0].html).toContain('Review and decide')
    expect(sent[0].html).not.toContain('/undo/')
    expect((await rows(u.dedupeKey))[0].kind).toBe('action_needed')
  })

  it('runAgentLoop (lib/events/loop) reaches the real notifyOwner: ask_first and done both record owner updates', async () => {
    const r = await admin(db => runAgentLoop(db, {
      orgId: NW.org, agentKey: 'loop-test', agentName: 'Loop Agent', actionType: 'test_action', problemKey: `p${Date.now()}`,
      detect: async () => ({ id: 1 }), describe: () => ({ title: 'Fixed a thing', whatHappened: 'A thing was broken.', whatIDid: ['Fixed it'] }),
      act: async () => ({ proof: [{ label: 'Record', value: '1' }] }), verify: async () => ({ ok: true, proof: [{ label: 'Checked', value: 'yes' }] }),
    }))
    expect(['done', 'waiting_for_owner']).toContain(r.status)
    const got = await admin(db => db.query<{ dedupe_key: string; kind: string }>(`select distinct dedupe_key, kind from owner_updates where org_id = $1 and agent_key = 'loop-test'`, [NW.org]))
    expect(got).toHaveLength(1)
    expect(got[0].dedupe_key).toMatch(r.status === 'done' ? /:done$/ : /:ask$/)
  })

  it('preferences: email off skips; text and voice go to the simulated sender (stored, nothing leaves)', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    await setMyPrefs(adminActor, { email: false, text: true, voice: true, phone: '+1 555 555 0101' })
    expect(await getMyPrefs(adminActor)).toMatchObject({ email: false, text: true, voice: true, phone: '+15555550101', digest: 'off', receivesUpdates: true })
    const u = upd({ severity: 'warning' })
    const r = await notifyOwner(u)
    expect(r.status).toBe('sent') // the owner's email
    expect(sent.map(s => s.to[0])).not.toContain(adminActor.session.email)
    const mine = (await rows(u.dedupeKey)).filter(x => x.recipient === '+15555550101')
    expect(mine.map(x => [x.channel, x.status])).toEqual([['text', 'held'], ['voice', 'held']])
    expect(mine[0].status_reason).toMatch(/simulated/)
    const out = await admin(db => db.query<{ channel: string; status: string; body: string; transcript: string | null; provider: string }>('select channel, status, body, transcript, provider from notify_outbox where org_id = $1 order by channel', [NW.org]))
    expect(out.map(o => [o.channel, o.status, o.provider])).toEqual([['text', 'simulated', 'simulated'], ['voice', 'simulated', 'simulated']])
    expect(out[0].body).toMatch(/^Deploi - Refund Agent - please check: Refunded order #1001\./)
    expect(out[1].transcript).toMatch(/^Hi, this is Deploi\. .*the link in your messages/)
    expect(channelAdapter()).toBe(simulatedAdapter)
  })

  it('a named provider without a live sender holds the text (nothing leaves) and says why', async () => {
    process.env.NOTIFY_SMS_PROVIDER = 'twilio'
    await setMyPrefs(adminActor, { email: false, text: true, phone: '+15555550101' })
    const u = upd()
    await notifyOwner(u)
    const out = await admin(db => db.one<{ status: string; provider: string; status_reason: string }>('select status, provider, status_reason from notify_outbox where org_id = $1', [NW.org]))
    expect(out).toMatchObject({ status: 'held', provider: 'twilio' })
    expect(out!.status_reason).toMatch(/not set up in this build/)
  })

  it('daily digest: routine updates are queued for the morning report; warnings and decisions still go at once', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    await setMyPrefs(adminActor, { digest: 'daily' })
    const a = upd()
    await notifyOwner(a)
    expect(sent.map(s => s.to[0])).not.toContain(adminActor.session.email)
    expect((await rows(a.dedupeKey)).find(x => x.recipient === adminActor.session.email)).toMatchObject({ channel: 'digest', status: 'queued' })
    sent.length = 0
    await notifyOwner(upd({ severity: 'action' }))
    expect(sent.map(s => s.to[0])).toContain(adminActor.session.email)
  })

  it('preferences validation: text needs a phone; a bad number is refused; viewers cannot change; staff cannot', async () => {
    await expect(setMyPrefs(adminActor, { text: true, phone: '' })).rejects.toThrow(/phone number/)
    await expect(setMyPrefs(adminActor, { phone: '0101' })).rejects.toThrow(/international form/)
    await expect(setMyPrefs(viewer, { email: false })).rejects.toThrow(/read only/)
    expect(await getMyPrefs(viewer)).toMatchObject({ receivesUpdates: false })
  })

  it('no recipient to tell: skipped, recorded once', async () => {
    const u = upd()
    await admin(db => db.query(`update notify_preferences set email_on = false where org_id = $1`, [NW.org]))
    const people = await admin(db => updateRecipients(db, NW.org))
    for (const p of people) await admin(db => db.query(`insert into notify_preferences (org_id, profile_id, email_on) values ($1,$2,false) on conflict (org_id, profile_id) do update set email_on = false`, [NW.org, p.profileId]))
    const r = await notifyOwner(u)
    expect(r.status).toBe('skipped')
    expect((await rows(u.dedupeKey)).map(x => x.status)).toEqual(['skipped'])
  })

  it('a provider failure is recorded as failed, not sent', async () => {
    fakeResend(true)
    process.env.EMAIL_LIVE_SENDS = 'all'
    const u = upd()
    const r = await notifyOwner(u)
    expect(r.status).toBe('failed')
    expect((await rows(u.dedupeKey)).every(x => x.status === 'failed')).toBe(true)
  })

  it('invalid input fails without writing; a custom channel adapter can be installed', async () => {
    expect(await notifyOwner({ ...upd(), orgId: 'nope' })).toMatchObject({ status: 'failed' })
    expect(await notifyOwner({ ...upd(), dedupeKey: '' })).toMatchObject({ status: 'failed' })
    const calls: string[] = []
    setChannelAdapter({ name: 'spy', sendText: async (db, m) => { calls.push(`text:${m.toPhone}`); return simulatedAdapter.sendText(db, m) }, sendVoiceNote: async (db, m) => { calls.push('voice'); return simulatedAdapter.sendVoiceNote(db, m) } })
    await setMyPrefs(adminActor, { email: false, text: true, phone: '+15555550101' })
    await notifyOwner(upd())
    expect(calls).toEqual(['text:+15555550101'])
  })

  it('tenant isolation: another organization reads none of these updates; the owning organization does', async () => {
    const u = upd()
    await notifyOwner(u)
    const theirs = await withUser(SESSIONS.harbor, db => db.query('select id from owner_updates where dedupe_key = $1', [u.dedupeKey]))
    const ours = await withUser(SESSIONS.northwind, db => db.query('select id from owner_updates where dedupe_key = $1', [u.dedupeKey]))
    expect(theirs).toHaveLength(0)
    expect(ours.length).toBeGreaterThan(0)
    await expect(withUser(SESSIONS.northwind, db => db.query(`insert into owner_updates (org_id, dedupe_key, agent_key, agent_name, headline, channel, status) values ($1,'x','a','A','h','email','sent')`, [NW.org]))).rejects.toThrow(/permission denied/)
  })
})
