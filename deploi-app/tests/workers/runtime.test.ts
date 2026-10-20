import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { mockSmsOutbox } from '../../lib/adapters/sms'
import { mockOutbox } from '../../lib/adapters/email'
import '../../workers'
import { runWorker, sendProposedAction } from '../../lib/workers/runtime'
import { handleAideReply } from '../../workers/open_shift_fill'

const ready = await prepareDb()

describe.skipIf(!ready)('worker runtime against the seed', () => {
  beforeAll(async () => {
    await admin(db => db.query("update agencies set auto_send = '{}'::jsonb where id = $1", [AGENCY_A]))
    // item 7: these tests cover delivery mechanics, so the seed contacts are consented here
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('update applicants set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('update clients set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('delete from proposed_actions where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('delete from shift_offers where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('delete from retention_checkins where agency_id = $1', [AGENCY_A]))
    // section-7-only state is not covered by the seed upsert; reset it so the run is idempotent
    await admin(db => db.query("update shifts set status = 'open', aide_id = null, filled_at = null where agency_id = $1 and id = any($2::uuid[])", [AGENCY_A, [0,1,2,3,4,5].map(i => uuidFrom(`shift:open:${i}`))]))
    await admin(db => db.query("update applicants set screen_state = 'idle' where agency_id = $1", [AGENCY_A]))
    await admin(db => db.query('update aides set quit_risk = false, quit_risk_reason = null where agency_id = $1', [AGENCY_A]))
  })

  it('authorization_watch flags the seeded 6 low-unit + 4 expiring auths and sends nothing', async () => {
    const s = await runWorker('authorization_watch', AGENCY_A, { dryRun: false })
    expect(s.proposed).toBe(10)
    expect(s.inserted).toBe(10)
    expect(s.sent).toBe(0)
    const again = await runWorker('authorization_watch', AGENCY_A, { dryRun: false })
    expect(again.inserted).toBe(0) // dedupe
    const rows = await admin(db => db.query<{ status: string }>("select status from proposed_actions where worker = 'authorization_watch' and agency_id = $1", [AGENCY_A]))
    expect(rows.every(r => r.status === 'proposed')).toBe(true)
  })

  it('credential_tracking proposes an aide SMS and an admin email per expiry (4 aides in window)', async () => {
    const s = await runWorker('credential_tracking', AGENCY_A, { dryRun: true })
    expect(s.proposed).toBe(8)
    const kinds = await admin(db => db.query<{ kind: string; n: string }>("select kind, count(*)::text as n from proposed_actions where worker = 'credential_tracking' and agency_id = $1 group by kind", [AGENCY_A]))
    expect(Object.fromEntries(kinds.map(k => [k.kind, Number(k.n)]))).toEqual({ sms: 4, email: 4 })
  })

  it('open_shift_fill offers each of the 6 open shifts to up to 5 aides, then a YES fills the shift exactly once', async () => {
    const future = await admin(db => db.query<{ id: string }>("select id from shifts where agency_id = $1 and status = 'open' and starts_at > now() order by starts_at", [AGENCY_A]))
    expect(future.length).toBeGreaterThanOrEqual(1) // seed has 6 open shifts over the next 3 days; the first may already have started
    const s = await runWorker('open_shift_fill', AGENCY_A, { dryRun: true })
    expect(s.proposed).toBe(future.length * 5) // 12 eligible aides, top 5 per shift
    const offers = await admin(db => db.query<{ shift_id: string; aide_id: string }>("select shift_id, aide_id from shift_offers where agency_id = $1", [AGENCY_A]))
    expect(offers.length).toBe(future.length * 5)
    const soonest = future[0]
    const shiftId = soonest!.id
    const aideId = offers.find(o => o.shift_id === shiftId)!.aide_id
    const aide = await admin(db => db.one<{ id: string; agency_id: string; first_name: string; last_name: string }>('select id, agency_id, first_name, last_name from aides where id = $1', [aideId]))
    const r1 = await admin(db => handleAideReply(db, aide!, 'YES', 'America/New_York'))
    expect(r1.filled).toBe(true)
    expect(r1.proposals.some(p => p.to_ref.startsWith('family:'))).toBe(true)
    const shift = await admin(db => db.one<{ status: string; aide_id: string }>('select status, aide_id from shifts where id = $1', [shiftId]))
    expect(shift).toEqual({ status: 'filled', aide_id: aideId })
    const other = offers.find(o => o.shift_id === shiftId && o.aide_id !== aideId)!
    const aide2 = await admin(db => db.one<{ id: string; agency_id: string; first_name: string; last_name: string }>('select id, agency_id, first_name, last_name from aides where id = $1', [other.aide_id]))
    const r2 = await admin(db => handleAideReply(db, aide2!, 'yes', 'America/New_York'))
    expect(r2.filled).toBe(false)
    const still = await admin(db => db.one<{ aide_id: string }>('select aide_id from shifts where id = $1', [shiftId]))
    expect(still?.aide_id).toBe(aideId)
    const superseded = await admin(db => db.query("select id from shift_offers where shift_id = $1 and status = 'superseded'", [shiftId]))
    expect(superseded.length).toBe(4)
  })

  it('referral_response proposes a reply for the one unanswered seeded referral with a capacity decision', async () => {
    const s = await runWorker('referral_response', AGENCY_A, { dryRun: true })
    expect(s.proposed).toBeGreaterThanOrEqual(1)
    const p = await admin(db => db.one<{ payload: Record<string, unknown>; to_ref: string }>("select payload, to_ref from proposed_actions where worker = 'referral_response' and dedupe_key = $1", [`ref:${uuidFrom('ref:0')}:reply`]))
    expect(p?.payload.can_serve).toBe(true)
    expect(p?.to_ref).toBe(`referrer:${uuidFrom('ref:0')}`)
  })

  it('applicant_screening proposes screens for new applicants and an interview for screened ones', async () => {
    const s = await runWorker('applicant_screening', AGENCY_A, { dryRun: true })
    expect(s.proposed).toBe(4)
    const rows = await admin(db => db.query<{ payload: Record<string, unknown> }>("select payload from proposed_actions where worker = 'applicant_screening' and agency_id = $1", [AGENCY_A]))
    expect(rows.filter(r => r.payload.effect === 'applicant_screen_sent').length).toBe(2)
    expect(rows.filter(r => r.payload.effect === 'applicant_interview_booked').length).toBe(2)
  })

  it('approval sends through the adapters and applies the side effect', async () => {
    const before = mockSmsOutbox.length
    const row = await admin(db => db.one<{ id: string; payload: Record<string, unknown> }>("select id, payload from proposed_actions where worker = 'applicant_screening' and payload->>'effect' = 'applicant_screen_sent' and status = 'proposed' limit 1"))
    const ok = await admin(db => sendProposedAction(db, row!.id, { actorId: uuidFrom('user:hello') }))
    expect(ok).toBe(true)
    expect(mockSmsOutbox.length).toBe(before + 1)
    const a = await admin(db => db.one<{ screen_state: string }>('select screen_state from applicants where id = $1', [row!.payload.applicant_id]))
    expect(a?.screen_state).toBe('q1')
    const st = await admin(db => db.one<{ status: string }>('select status from proposed_actions where id = $1', [row!.id]))
    expect(st?.status).toBe('sent')
  })

  it('auto-send ON sends immediately; OFF never does', async () => {
    await admin(db => db.query("delete from proposed_actions where worker = 'credential_tracking' and agency_id = $1", [AGENCY_A]))
    const offBefore = mockOutbox.length + mockSmsOutbox.length
    const off = await runWorker('credential_tracking', AGENCY_A, { dryRun: false })
    expect(off.sent).toBe(0)
    expect(mockOutbox.length + mockSmsOutbox.length).toBe(offBefore)
    await admin(db => db.query("delete from proposed_actions where worker = 'credential_tracking' and agency_id = $1", [AGENCY_A]))
    await admin(db => db.query("update agencies set auto_send = '{\"credential_tracking\": true}'::jsonb where id = $1", [AGENCY_A]))
    const on = await runWorker('credential_tracking', AGENCY_A, { dryRun: false })
    expect(on.sent).toBe(8)
    expect(mockOutbox.length + mockSmsOutbox.length).toBe(offBefore + 8)
    await admin(db => db.query("update agencies set auto_send = '{}'::jsonb where id = $1", [AGENCY_A]))
    // item 7: these tests cover delivery mechanics, so the seed contacts are consented here
    await admin(db => db.query('update aides set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('update applicants set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
    await admin(db => db.query('update clients set sms_consent = true, sms_consent_at = now() where agency_id = $1', [AGENCY_A]))
  })

  it('retention_checkins flags quit risk from declines + a late clock-in', async () => {
    const aideId = uuidFrom('aide:11')
    const shiftId = uuidFrom('shift:sched:0')
    await admin(db => db.query("insert into shift_offers (agency_id, shift_id, aide_id, status, response, responded_at) values ($1,$2,$3,'declined','no', now() - interval '2 days') on conflict (shift_id, aide_id) do update set status='declined', response='no', responded_at = now() - interval '2 days'", [AGENCY_A, shiftId, aideId]))
    await admin(db => db.query("insert into shift_offers (agency_id, shift_id, aide_id, status, response, responded_at) values ($1,$2,$3,'declined','no', now() - interval '4 days') on conflict (shift_id, aide_id) do update set status='declined', response='no', responded_at = now() - interval '4 days'", [AGENCY_A, uuidFrom('shift:sched:1'), aideId]))
    await admin(db => db.query("update visits set actual_start = scheduled_start + interval '25 minutes' where id = $1", [uuidFrom('visit:11')]))
    const s = await runWorker('retention_checkins', AGENCY_A, { dryRun: true })
    const a = await admin(db => db.one<{ quit_risk: boolean }>('select quit_risk from aides where id = $1', [aideId]))
    expect(a?.quit_risk).toBe(true)
    expect(s.proposed).toBeGreaterThanOrEqual(1)
  })
})
