import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { mockSmsOutbox } from '../../lib/adapters/sms'
import { mockOutbox } from '../../lib/adapters/email'
import { withJobLock } from '../../lib/jobs/lock'
import '../../workers'
import { runWorker, runAllNightly, approveAction, executeAction, insertProposal, drainDueActions, markUnknownDeliveries, recordDeliveryCallback, OUTSIDE_WINDOW, NO_RECIPIENT } from '../../lib/workers/runtime'
import { isRealOutcome, countReal, simulatedSummary, simulatedReportLine } from '../../lib/workers/outcomes'
import { webhookSecretGuard, SECRET_NOT_CONFIGURED } from '../../lib/workers/webhook-guard'
import { classifyInbound, isOptOut, isUrgent, phoneToken } from '../../lib/workers/inbound'
import { contactWindow, inContactWindow, nextWindowStart, localDateKey } from '../../lib/workers/window'
import { expiresAtFor } from '../../lib/workers/expiry'
import { suppressApplicantFollowups } from '../../lib/workers/suppress'
import { handleCheckinReply } from '../../workers/retention_checkins'

const ready = await prepareDb()
const STAFF = uuidFrom('user:hello')
const today = new Date().toISOString().slice(0, 10)
const IN_WINDOW = new Date(`${today}T15:00:00Z`)   // 11:00 EDT / 10:00 EST, inside 07:00–20:00
const AT_NIGHT = new Date(`${today}T03:00:00Z`)    // 23:00 EDT / 22:00 EST, outside
const AGENCY = { id: AGENCY_A, name: 'Buckeye Home Care' }

const aide = (i: number) => uuidFrom(`aide:${i}`)
const sms = (i: number, key: string, extra: Record<string, unknown> = {}) => ({ kind: 'sms' as const, to_ref: `aide:${aide(i)}`, body: `test ${key}`, payload: { to_label: 'Aide', ...extra }, dedupe_key: `exec-test:${key}` })

const row = (id: string) => admin(db => db.one<{ status: string; simulated: boolean; delivery_status: string | null; attempt_count: number; idempotency_key: string | null; hold_reason: string | null; send_after: Date | null; suppressed_reason: string | null; failure_reason: string | null }>(
  'select status, simulated, delivery_status, attempt_count, idempotency_key, hold_reason, send_after, suppressed_reason, failure_reason from proposed_actions where id = $1', [id]))

describe.skipIf(!ready)('phase 11: action execution', () => {
  beforeAll(async () => {
    await admin(db => db.query("update agencies set auto_send = '{}'::jsonb where id = $1", [AGENCY_A]))
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now(), sms_opt_out_at = null where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query("delete from proposed_actions where dedupe_key like 'exec-test:%' or agency_id = $1", [AGENCY_A]))
    await admin(db => db.query('delete from retention_checkins where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query("delete from job_runs where job_key like 'exec-test:%'"))
  })

  it('human approval is the default: a run writes proposals and sends nothing; auto_send is {} on the seed', async () => {
    const s = await runWorker('credential_tracking', AGENCY_A, { dryRun: false, now: IN_WINDOW })
    expect(s.proposed).toBeGreaterThan(0)
    expect(s.sent).toBe(0)
    const auto = await admin(db => db.one<{ auto_send: Record<string, boolean> }>('select auto_send from agencies where id = $1', [AGENCY_A]))
    expect(auto?.auto_send).toEqual({})
    const statuses = await admin(db => db.query<{ status: string }>("select distinct status from proposed_actions where worker = 'credential_tracking' and agency_id = $1", [AGENCY_A]))
    expect(statuses.map(r => r.status)).toEqual(['proposed'])
  })

  it('approve only records the decision; execute sends; a mock send is delivered + simulated and excluded by isRealOutcome', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', sms(0, 'approve-exec'), IN_WINDOW)))!
    const before = mockSmsOutbox.length
    const approved = await admin(db => approveAction(db, id, { actorId: STAFF }))
    expect(approved?.status).toBe('approved')
    expect(mockSmsOutbox.length).toBe(before) // approval sent nothing
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(r).toMatchObject({ ok: true, status: 'delivered', simulated: true })
    expect(mockSmsOutbox.length).toBe(before + 1)
    const a = await row(id)
    expect(a).toMatchObject({ status: 'delivered', simulated: true, delivery_status: 'delivered', attempt_count: 1 })
    expect(isRealOutcome(a)).toBe(false)
    expect(isRealOutcome({ simulated: false })).toBe(true)
    expect(countReal([{ simulated: true }, { simulated: false }, null])).toBe(1)
    const sum = await admin(db => simulatedSummary(db, AGENCY_A))
    expect(sum.simulated).toBeGreaterThanOrEqual(1)
    expect(sum.real).toBe(sum.delivered - sum.simulated)
    expect(simulatedReportLine(sum)).toMatch(/simulated send/)
  })

  it('retried execution is idempotent: attempted/delivered rows are a no-op and the outbox length does not change', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', sms(1, 'retry'), IN_WINDOW)))!
    await admin(db => approveAction(db, id, { actorId: STAFF }))
    const first = await admin(db => executeAction(db, id, { actorId: STAFF, idempotencyKey: `${id}:attempt:1`, now: IN_WINDOW }))
    expect(first.ok).toBe(true)
    const len = mockSmsOutbox.length
    const again = await admin(db => executeAction(db, id, { actorId: STAFF, idempotencyKey: `${id}:attempt:1`, now: IN_WINDOW }))
    expect(again).toMatchObject({ ok: true, noop: true })
    const third = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(third.noop).toBe(true)
    expect(mockSmsOutbox.length).toBe(len)
    expect((await row(id))?.attempt_count).toBe(1)
  })

  it('a failed action (no reachable recipient) can be retried under a new attempt scope', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'open_shift_fill', { kind: 'sms', to_ref: `family:${uuidFrom('client:39')}`, body: 'x', payload: {}, dedupe_key: 'exec-test:norecip' }, IN_WINDOW)))!
    await admin(db => db.query('update clients set family_phone = null, sms_consent = true where id = $1', [uuidFrom('client:39')]))
    await admin(db => approveAction(db, id, { actorId: STAFF }))
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(r).toMatchObject({ ok: false, status: 'failed', reason: NO_RECIPIENT })
    await admin(db => db.query("update clients set family_phone = '+16145559999' where id = $1", [uuidFrom('client:39')]))
    const retry = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(retry).toMatchObject({ ok: true, status: 'delivered', simulated: true })
    expect((await row(id))?.attempt_count).toBe(2)
    await admin(db => db.query('update clients set family_phone = null, sms_consent = false where id = $1', [uuidFrom('client:39')]))
  })

  it('an expired action is refused and marked expired, never sent', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'open_shift_fill', { ...sms(2, 'expired'), expires_at: new Date(IN_WINDOW.getTime() - 60_000) }, IN_WINDOW)))!
    await admin(db => approveAction(db, id, { actorId: STAFF }))
    const before = mockSmsOutbox.length
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(r.status).toBe('expired')
    expect(mockSmsOutbox.length).toBe(before)
    expect((await row(id))?.status).toBe('expired')
    // shift offers expire at shift start; referral replies after 72h; tasks never; default off
    const starts = new Date('2026-12-01T13:00:00Z')
    expect(expiresAtFor({ kind: 'sms', payload: { effect: 'shift_offer_sent', shift_starts_at: starts.toISOString() } }, IN_WINDOW)?.toISOString()).toBe(starts.toISOString())
    expect(expiresAtFor({ kind: 'email', payload: { effect: 'referral_replied' } }, IN_WINDOW)?.getTime()).toBe(IN_WINDOW.getTime() + 72 * 3_600_000)
    expect(expiresAtFor({ kind: 'task', payload: {} }, IN_WINDOW)).toBeNull()
    expect(expiresAtFor({ kind: 'sms', payload: {} }, IN_WINDOW)).toBeNull()
  })

  it('SMS outside the agency contact window is queued with send_after at the next window start, then drained when due', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', sms(3, 'night'), AT_NIGHT)))!
    await admin(db => approveAction(db, id, { actorId: STAFF }))
    const before = mockSmsOutbox.length
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: AT_NIGHT }))
    expect(r).toMatchObject({ ok: false, deferred: true, status: 'queued', reason: OUTSIDE_WINDOW })
    expect(mockSmsOutbox.length).toBe(before)
    const q = await row(id)
    expect(q?.status).toBe('queued')
    const w = contactWindow({ hours: { start: '07:00', end: '20:00' } })
    expect(inContactWindow(AT_NIGHT, 'America/New_York', w)).toBe(false)
    expect(inContactWindow(IN_WINDOW, 'America/New_York', w)).toBe(true)
    expect(q!.send_after!.getTime()).toBe(nextWindowStart(AT_NIGHT, 'America/New_York', w).getTime())
    expect(q!.send_after!.getTime()).toBeGreaterThan(AT_NIGHT.getTime())
    // not due yet: nothing happens; due: it goes
    const early = await admin(db => drainDueActions(db, AT_NIGHT))
    expect(early.executed).toBe(0)
    const later = await admin(db => drainDueActions(db, new Date(q!.send_after!.getTime() + 60_000)))
    expect(later.executed).toBeGreaterThanOrEqual(1)
    expect((await row(id))?.status).toBe('delivered')
    expect(mockSmsOutbox.length).toBe(before + 1)
    expect(contactWindow({})).toEqual({ start: '08:00', end: '20:00' })
    expect(localDateKey(new Date('2026-10-21T03:00:00Z'), 'America/New_York')).toBe('2026-10-20')
  })

  it('duplicate cron run is skipped by the job lock and creates no second batch of proposals', async () => {
    await admin(db => db.query("delete from proposed_actions where worker = 'authorization_watch' and agency_id = $1", [AGENCY_A]))
    const period = localDateKey(new Date(), 'America/New_York')
    const key = `exec-test:cron:workers:${AGENCY_A}`
    const run = () => runAllNightly(AGENCY_A, { dryRun: false, now: IN_WINDOW })
    const first = await admin(db => withJobLock(db, key, period, run))
    expect(first.skipped).toBe(false)
    const n1 = await admin(db => db.one<{ n: string }>("select count(*)::text as n from proposed_actions where worker = 'authorization_watch' and agency_id = $1", [AGENCY_A]))
    const mailBefore = mockOutbox.length + mockSmsOutbox.length
    const second = await admin(db => withJobLock(db, key, period, run))
    expect(second.skipped).toBe(true)
    const n2 = await admin(db => db.one<{ n: string }>("select count(*)::text as n from proposed_actions where worker = 'authorization_watch' and agency_id = $1", [AGENCY_A]))
    expect(n2?.n).toBe(n1?.n)
    expect(mockOutbox.length + mockSmsOutbox.length).toBe(mailBefore)
  })

  it('provider acceptance is not delivery: callbacks move attempted -> delivered / failed, silence -> unknown', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', sms(4, 'callback'), IN_WINDOW)))!
    // simulate a real adapter result recorded by executeAction's non-mock branch
    await admin(db => db.query("update proposed_actions set status = 'attempted', delivery_status = 'provider_accepted', attempted_at = now() - interval '3 hours', attempt_count = 1, provider_message_id = 'SM-test-1', idempotency_key = $2 where id = $1", [id, `${id}:attempt:1`]))
    expect(await admin(db => markUnknownDeliveries(db, new Date(), 120))).toBeGreaterThanOrEqual(1)
    expect((await row(id))?.status).toBe('unknown')
    expect(await admin(db => recordDeliveryCallback(db, 'SM-test-1', 'delivered'))).toBe(true)
    expect((await row(id))).toMatchObject({ status: 'delivered', delivery_status: 'delivered', simulated: false })
    expect(await admin(db => recordDeliveryCallback(db, 'SM-test-1', 'failed', '30007'))).toBe(false) // already delivered: nothing to change
    const id2 = (await admin(db => insertProposal(db, AGENCY, 'credential_tracking', sms(5, 'callback-fail'), IN_WINDOW)))!
    await admin(db => db.query("update proposed_actions set status = 'attempted', delivery_status = 'provider_accepted', attempted_at = now(), attempt_count = 1, provider_message_id = 'SM-test-2' where id = $1", [id2]))
    expect(await admin(db => recordDeliveryCallback(db, 'SM-test-2', 'undelivered', '30003 unreachable'))).toBe(true)
    expect((await row(id2))).toMatchObject({ status: 'failed', delivery_status: 'failed', failure_reason: '30003 unreachable' })
  })

  it('webhook guard: production without a secret is 503 "webhook secret not configured"; with a secret it verifies; dev without one accepts unsigned', () => {
    expect(webhookSecretGuard('twilio', '', true)).toEqual({ ok: false, status: 503, error: SECRET_NOT_CONFIGURED })
    expect(webhookSecretGuard('twilio', undefined, true)).toMatchObject({ ok: false, status: 503 })
    expect(webhookSecretGuard('twilio', 'tok', true)).toEqual({ ok: true, verify: true })
    expect(webhookSecretGuard('twilio', 'tok', false)).toEqual({ ok: true, verify: true })
    expect(webhookSecretGuard('twilio', '', false)).toEqual({ ok: true, verify: false })
  })

  it('inbound classification: opt-out words, urgent keywords, phone token never carries the number', () => {
    for (const w of ['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'end', 'QUIT!']) expect(isOptOut(w)).toBe(true)
    expect(isOptOut('stop texting me please')).toBe(false)
    expect(isUrgent('My mom had a fall and is in the hospital')).toBe(true)
    expect(isUrgent('call 911')).toBe(true)
    expect(isUrgent('chest pain since noon')).toBe(true)
    expect(isUrgent('Yes I can take the shift')).toBe(false)
    expect(isUrgent('I fell behind on paperwork', ['hospital'])).toBe(false)
    expect(classifyInbound('STOP')).toBe('opt_out')
    expect(classifyInbound('emergency')).toBe('urgent')
    expect(classifyInbound('yes')).toBe('normal')
    expect(phoneToken('+1 (614) 555-0100')).toBe(phoneToken('16145550100'))
    expect(phoneToken('+16145550100')).not.toContain('614')
  })

  it('replies stop follow-ups: an applicant reply suppresses earlier pending screening texts; an answered check-in suppresses its follow-ups and files a task', async () => {
    const applicantId = uuidFrom('applicant:0')
    const old = (await admin(db => insertProposal(db, AGENCY, 'applicant_screening', { kind: 'sms', to_ref: `applicant:${applicantId}`, body: 'Q1', payload: { applicant_id: applicantId }, dedupe_key: 'exec-test:app-q1' })))!
    await new Promise(r => setTimeout(r, 20))
    const n = await admin(db => suppressApplicantFollowups(db, AGENCY_A, applicantId, new Date()))
    expect(n).toBeGreaterThanOrEqual(1)
    expect((await row(old))).toMatchObject({ status: 'suppressed', suppressed_reason: 'applicant_replied' })
    // hired/rejected via any code path: the trigger retires pending follow-ups
    const pend = (await admin(db => insertProposal(db, AGENCY, 'applicant_screening', { kind: 'sms', to_ref: `applicant:${applicantId}`, body: 'Q2', payload: { applicant_id: applicantId }, dedupe_key: 'exec-test:app-q2' })))!
    await admin(db => db.query("update applicants set status = 'hired' where id = $1", [applicantId]))
    expect((await row(pend))).toMatchObject({ status: 'suppressed', suppressed_reason: 'applicant_hired' })
    await admin(db => db.query("update applicants set status = 'new' where id = $1", [applicantId]))
    // retention: a sent 30-day check-in answered by the aide
    const aideRow = (await admin(db => db.one<{ id: string; agency_id: string; first_name: string; last_name: string }>('select id, agency_id, first_name, last_name from aides where id = $1', [aide(6)])))!
    const checkin = (await admin(db => db.one<{ id: string }>("insert into retention_checkins (agency_id, aide_id, day, due_on, status) values ($1,$2,30,current_date,'sent') on conflict (aide_id, day) do update set status = 'sent', answered_at = null returning id", [AGENCY_A, aide(6)])))!
    const follow = (await admin(db => insertProposal(db, AGENCY, 'retention_checkins', { kind: 'sms', to_ref: `aide:${aide(6)}`, body: 'nudge', payload: { checkin_id: checkin.id, aide_id: aide(6) }, dedupe_key: 'exec-test:retention-nudge' })))!
    const r = await admin(db => handleCheckinReply(db, aideRow, 'Schedules are fine, pay question though'))
    expect(r.handled).toBe(true)
    expect(r.proposals[0]).toMatchObject({ kind: 'task', to_ref: 'admin' })
    expect((await row(follow))).toMatchObject({ status: 'suppressed', suppressed_reason: 'checkin_answered' })
    const c = await admin(db => db.one<{ status: string; answered_at: Date | null }>('select status, answered_at from retention_checkins where id = $1', [checkin.id]))
    expect(c?.status).toBe('answered'); expect(c?.answered_at).not.toBeNull()
  })

  it('referral answered by a person retires the drafted first reply; declined retires everything pending', async () => {
    const ref = uuidFrom('ref:0')
    await admin(db => db.query("update referrals set first_response_at = null, status = 'new' where id = $1", [ref]))
    const draft = (await admin(db => insertProposal(db, AGENCY, 'referral_response', { kind: 'email', to_ref: `referrer:${ref}`, body: 'draft', payload: { effect: 'referral_replied', referral_id: ref }, dedupe_key: 'exec-test:ref-reply' })))!
    const d7 = (await admin(db => insertProposal(db, AGENCY, 'referral_response', { kind: 'email', to_ref: `referrer:${ref}`, body: '7d', payload: { referral_id: ref, day: 7 }, dedupe_key: 'exec-test:ref-d7' })))!
    await admin(db => db.query("update referrals set first_response_at = now(), responded_by = 'owner', status = 'responded' where id = $1", [ref]))
    expect((await row(draft))).toMatchObject({ status: 'suppressed', suppressed_reason: 'referral_answered' })
    expect((await row(d7))?.status).toBe('proposed') // follow-ups still make sense after a human reply
    await admin(db => db.query("update referrals set status = 'declined' where id = $1", [ref]))
    expect((await row(d7))).toMatchObject({ status: 'suppressed', suppressed_reason: 'referral_declined' })
    await admin(db => db.query("update referrals set first_response_at = null, responded_by = null, status = 'new' where id = $1", [ref]))
  })

  it('a task is handed over on execution (delivered, not simulated) and never touches an adapter', async () => {
    const id = (await admin(db => insertProposal(db, AGENCY, 'inbound_triage', { kind: 'task', to_ref: 'admin', body: 'call back', payload: { to_label: 'Admin' }, dedupe_key: 'exec-test:task' })))!
    const before = mockSmsOutbox.length + mockOutbox.length
    await admin(db => approveAction(db, id, { actorId: STAFF }))
    const r = await admin(db => executeAction(db, id, { actorId: STAFF, now: IN_WINDOW }))
    expect(r).toMatchObject({ ok: true, status: 'delivered', simulated: false })
    expect(mockSmsOutbox.length + mockOutbox.length).toBe(before)
  })
})
