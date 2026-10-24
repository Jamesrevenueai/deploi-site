import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, AGENCY_A, AGENCY_B, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { createEngagement, getEngagement, listTransitions, updateProposal } from '../../lib/engagements/queries'
import { transitionEngagement, availableTransitions } from '../../lib/engagements/transition'
import { applyEngagementCredit, CreditError } from '../../lib/engagements/credit'
import { issueCredit, recordCreditPayment } from '../../lib/credit/ledger'
import { completeItem, ensureChecklist } from '../../lib/onboarding/checklist'

const ready = await prepareDb()
const STAFF = SESSIONS.staff.uid
const acceptance = { method: 'email' as const, reference: 'msg-accept-1', accepted_by: 'Dana (synthetic)', accepted_at: new Date().toISOString() }

describe.skipIf(!ready)('engagement workflow', () => {
  let id = ''
  beforeAll(async () => {
    await admin(db => db.query("delete from engagements where agency_id = $1 and created_by = $2 and service_key in ('open_shift_fill','applicant_screening')", [AGENCY_A, uuidFrom('user:workflow-test')]))
    await admin(db => db.query("delete from assessment_credits where agency_id = $1 and note = 'engage-test'", [AGENCY_A]))
    id = await admin(db => createEngagement(db, { agencyId: AGENCY_A, prospectId: uuidFrom('prospect:buckeye'), serviceKey: 'open_shift_fill', createdBy: uuidFrom('user:workflow-test') }))
  })
  afterAll(async () => {
    await admin(db => db.query('delete from engagements where created_by = $1', [uuidFrom('user:workflow-test')]))
    await admin(db => db.query("delete from assessment_credits where agency_id = $1 and note = 'engage-test'", [AGENCY_A]))
  })

  it('creates a draft prefilled from the catalog and logs the creation transition', async () => {
    const e = await admin(db => getEngagement(db, id))
    expect(e?.status).toBe('draft')
    expect(e?.setup_fee_cents).toBe(300000)
    expect(e?.exclusions).toContain('No changes inside the agency scheduler')
    expect(e?.included_volume).toBe(120)
    const t = await admin(db => listTransitions(db, id))
    expect(t.map(x => x.to_status)).toEqual(['draft'])
  })
  it('refuses a standalone service', async () => {
    await expect(admin(db => createEngagement(db, { agencyId: AGENCY_A, serviceKey: 'website_improvement', createdBy: null }))).rejects.toMatchObject({ code: 'standalone_service' })
  })
  it('refuses illegal transitions (draft -> building) and unknown statuses', async () => {
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'building', actorId: STAFF }))).rejects.toMatchObject({ code: 'illegal_transition' })
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'live', actorId: STAFF }))).rejects.toMatchObject({ code: 'invalid_status' })
  })
  it('draft -> proposed, then accepted requires acceptance evidence; a status change alone is refused by the lib and by the database', async () => {
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'proposed', actorId: STAFF, note: 'sent' }))
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'accepted', actorId: STAFF }))).rejects.toMatchObject({ code: 'acceptance_evidence_required' })
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'accepted', actorId: STAFF, acceptance: { ...acceptance, accepted_by: '' } }))).rejects.toMatchObject({ code: 'acceptance_evidence_required' })
    // even a direct SQL status change cannot prove acceptance
    await expect(admin(db => db.query("update engagements set status = 'accepted' where id = $1", [id]))).rejects.toThrow(/acceptance evidence is required/)
    let e = await admin(db => getEngagement(db, id))
    expect(e?.status).toBe('proposed')
    expect(e?.acceptance_evidence).toBeNull()
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'accepted', actorId: STAFF, acceptance }))
    e = await admin(db => getEngagement(db, id))
    expect(e?.status).toBe('accepted')
    expect(e?.acceptance_evidence).toMatchObject({ method: 'email', reference: 'msg-accept-1', recorded_by: STAFF })
    const t = await admin(db => listTransitions(db, id))
    expect(t[0]).toMatchObject({ from_status: 'proposed', to_status: 'accepted', actor_id: STAFF })
    expect(t[0].evidence).toMatchObject({ method: 'email' })
  })
  it('locks commercial fields after acceptance but keeps contacts editable', async () => {
    const r = await admin(db => updateProposal(db, id, { setup_fee_cents: 1, agency_contact: 'New contact' }))
    expect(r.locked).toBe(true)
    const e = await admin(db => getEngagement(db, id))
    expect(e?.setup_fee_cents).toBe(300000)
    expect(e?.agency_contact).toBe('New contact')
  })
  it('accepted -> building is gated on agreements + data access (server-side)', async () => {
    await admin(db => db.query('update agencies set baa_signed_at = null where id = $1', [AGENCY_A]))
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'building', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed' })
    const avail = await admin(db => availableTransitions(db, { id, agency_id: AGENCY_A, status: 'accepted' }))
    expect(avail.find(a => a.to === 'building')?.unmet.length).toBeGreaterThan(0)
    await admin(db => db.query('update agencies set baa_signed_at = now() where id = $1', [AGENCY_A]))
    await admin(async db => { await ensureChecklist(db, id, AGENCY_A); await completeItem(db, { engagementId: id, key: 'data_access', actorId: STAFF, note: 'export authorized in writing' }) })
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'building', actorId: STAFF }))
    const e = await admin(db => getEngagement(db, id))
    expect(e?.status).toBe('building')
    const t = await admin(db => listTransitions(db, id))
    expect(t[0].evidence).toMatchObject({ gate: 'building' })
  })
  it('applies an assessment credit through the ledger and mirrors it; errors surface as CreditError codes', async () => {
    const creditId = await admin(db => issueCredit(db, { agencyId: AGENCY_A, assessmentId: null, feeCents: 200000, termDays: 60, createdBy: null, note: 'engage-test' }))
    await expect(admin(db => applyEngagementCredit(db, { engagementId: id, creditId, amountCents: 100000, actorId: STAFF }))).rejects.toMatchObject({ code: 'not_paid' })
    await admin(db => recordCreditPayment(db, creditId, { isMock: false }))
    await expect(admin(db => applyEngagementCredit(db, { engagementId: id, creditId, amountCents: 999999, actorId: STAFF }))).rejects.toMatchObject({ code: 'over_remaining' })
    const r = await admin(db => applyEngagementCredit(db, { engagementId: id, creditId, amountCents: 150000, actorId: STAFF }))
    expect(r.creditAppliedCents).toBe(150000)
    expect(r.remainingCents).toBe(50000)
    const e = await admin(db => getEngagement(db, id))
    expect(e?.credit_applied_cents).toBe(150000)
    await expect(admin(db => applyEngagementCredit(db, { engagementId: id, creditId, amountCents: 1000, actorId: STAFF }))).rejects.toBeInstanceOf(CreditError)
    // a credit from another agency can never be applied here
    const other = await admin(db => issueCredit(db, { agencyId: AGENCY_B, assessmentId: null, feeCents: 1000, termDays: 60, createdBy: null, note: 'engage-test' }))
    await admin(db => recordCreditPayment(db, other, { isMock: false }))
    await expect(admin(db => applyEngagementCredit(db, { engagementId: id, creditId: other, amountCents: 1000, actorId: STAFF }))).rejects.toMatchObject({ code: 'ineligible_service' })
    await admin(db => db.query('delete from assessment_credits where id = $1', [other]))
  })
  it('RLS: client B cannot read agency A engagements or transitions; client A reads its own; only staff writes', async () => {
    const b = await withUser(SESSIONS.clientB, db => db.query('select id from engagements where agency_id = $1', [AGENCY_A]))
    expect(b.length).toBe(0)
    const bt = await withUser(SESSIONS.clientB, db => db.query('select id from engagement_transitions where engagement_id = $1', [id]))
    expect(bt.length).toBe(0)
    const a = await withUser(SESSIONS.clientA, db => db.query<{ agency_id: string }>('select agency_id from engagements'))
    expect(a.length).toBeGreaterThan(0)
    expect(a.every(r => r.agency_id === AGENCY_A)).toBe(true)
    await expect(withUser(SESSIONS.clientA, db => db.query("update engagements set monthly_fee_cents = 0 where id = $1 returning id", [id]))).rejects.toThrow(/row-level security/)
    expect((await admin(db => getEngagement(db, id)))!.monthly_fee_cents).toBe(50000)
    const s = await withUser(SESSIONS.staff, db => db.query('select id from engagements where id = $1', [id]))
    expect(s.length).toBe(1)
  })
})
