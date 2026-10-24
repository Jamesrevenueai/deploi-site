import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, AGENCY_A, AGENCY_B, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { createEngagement, getEngagement } from '../../lib/engagements/queries'
import { transitionEngagement } from '../../lib/engagements/transition'
import { completeItem, ensureChecklist, listChecklist, DEFAULT_ITEMS, uncompleteItem } from '../../lib/onboarding/checklist'
import { engagementReadiness } from '../../lib/onboarding/facts'
import { testInputSource } from '../../lib/onboarding/input-test'
import { upsertPilot, computePeriod, getPilot, recordDecision } from '../../lib/pilots/queries'
import { mockOutbox } from '../../lib/adapters/email'

const ready = await prepareDb()
const STAFF = SESSIONS.staff.uid
const CREATOR = uuidFrom('user:gates-test')
const acceptance = { method: 'signed_pdf' as const, reference: 'proposal-signed.pdf', accepted_by: 'Owner (synthetic)', accepted_at: new Date().toISOString() }
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d }

describe.skipIf(!ready)('launch gates (server-side)', () => {
  let id = ''
  beforeAll(async () => {
    await admin(db => db.query('delete from engagements where created_by = $1', [CREATOR]))
    await admin(db => db.query('update agencies set baa_signed_at = coalesce(baa_signed_at, now()) where id = $1', [AGENCY_A]))
    id = await admin(db => createEngagement(db, { agencyId: AGENCY_A, serviceKey: 'referral_response', createdBy: CREATOR }))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'proposed', actorId: STAFF }))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'accepted', actorId: STAFF, acceptance }))
    await admin(async db => { await ensureChecklist(db, id, AGENCY_A); await completeItem(db, { engagementId: id, key: 'data_access', actorId: STAFF }) })
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'building', actorId: STAFF }))
  })
  afterAll(async () => { await admin(db => db.query('delete from engagements where created_by = $1', [CREATOR])) })

  it('creates the default checklist once (idempotent) with who/when fields empty', async () => {
    await admin(db => ensureChecklist(db, id, AGENCY_A))
    const items = await admin(db => listChecklist(db, id))
    expect(items.length).toBe(DEFAULT_ITEMS.length)
    expect(items.filter(i => i.completed_at).map(i => i.key)).toEqual(['data_access'])
    expect(items.find(i => i.key === 'data_access')?.completed_by).toBe(STAFF)
  })
  it('a simulated input test (mocked adapter) is recorded but does not satisfy the testing gate', async () => {
    delete process.env.RESEND_API_KEY
    const before = mockOutbox.length
    const e = await admin(db => getEngagement(db, id))
    const r = await admin(db => testInputSource(db, { engagementId: id, inputMethod: e!.input_method, actorId: STAFF, actorEmail: 'hello@getdeploi.com' }))
    expect(r.mocked).toBe(true)
    expect(r.recorded).toBe(true)
    expect(mockOutbox.length).toBe(before + 1)
    const item = (await admin(db => listChecklist(db, id))).find(i => i.key === 'input_source_tested')!
    expect(item.completed_at).toBeTruthy()
    expect(item.evidence).toMatchObject({ simulated: true, mocked: true })
    const { readiness } = await admin(db => engagementReadiness(db, id, AGENCY_A))
    expect(readiness.items.find(i => i.key === 'input_source_tested')!.satisfied).toBe(false)
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'testing', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed', unmet: ['Input source tested (live, not simulated)'] })
    expect((await admin(db => getEngagement(db, id)))!.status).toBe('building')
  })
  it('the presence of a provider key alone does not flip the gate', async () => {
    process.env.RESEND_API_KEY = 're_present_but_unverified'
    try {
      await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'testing', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed' })
    } finally { delete process.env.RESEND_API_KEY }
  })
  it('live evidence satisfies the testing gate', async () => {
    await admin(db => completeItem(db, { engagementId: id, key: 'input_source_tested', actorId: STAFF, note: 'forwarded referral reached the alias', evidence: { method: 'forwarded_email', simulated: false, reference: 'inbox-test-1' } }))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'testing', actorId: STAFF }))
    expect((await admin(db => getEngagement(db, id)))!.status).toBe('testing')
  })
  it('the transition to pilot is refused while a required item is missing or the pilot is undefined', async () => {
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'pilot', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed' })
    // complete everything except pilot approval, define a pilot with baseline
    for (const d of DEFAULT_ITEMS) if (!['pilot_approval_recorded', 'input_source_tested', 'data_access'].includes(d.key)) await admin(db => completeItem(db, { engagementId: id, key: d.key, actorId: STAFF }))
    await admin(db => upsertPilot(db, { engagementId: id, agencyId: AGENCY_A, serviceKey: 'referral_response', startsOn: ymd(daysAgo(0)), endsOn: ymd(daysAgo(-30)), scope: 's', sampleDescription: null, baselineStart: ymd(daysAgo(40)), baselineEnd: ymd(daysAgo(1)), primaryMetricKey: 'referral_response_time', qualityGuardrails: [], dataSources: [], reviewOwner: 'Deploi Staff' }))
    const pilot = (await admin(db => getPilot(db, id)))!
    const base = await admin(db => computePeriod(db, pilot, 'baseline', STAFF))
    expect(base.length).toBeGreaterThan(0)
    let err: unknown
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'pilot', actorId: STAFF })).catch(e => { err = e })
    expect(err).toMatchObject({ code: 'gate_failed', unmet: ['Pilot approval recorded'] })
    expect((await admin(db => getEngagement(db, id)))!.status).toBe('testing')
    await admin(db => completeItem(db, { engagementId: id, key: 'pilot_approval_recorded', actorId: STAFF, note: 'approved on the call' }))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'pilot', actorId: STAFF }))
    expect((await admin(db => getEngagement(db, id)))!.status).toBe('pilot')
  })
  it('pilot requires a pilot row with dates and a primary metric (a missing metric is refused)', async () => {
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'testing', actorId: STAFF, note: 'back to testing for the check' }))
    await admin(db => db.query('update pilots set primary_metric_key = null where engagement_id = $1', [id]))
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'pilot', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed', unmet: ['Pilot primary metric'] })
    await admin(db => db.query("update pilots set primary_metric_key = 'referral_response_time' where engagement_id = $1", [id]))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'pilot', actorId: STAFF }))
  })
  it('active requires a pilot decision of Continue or Expand', async () => {
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'active', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed' })
    const pilot = (await admin(db => getPilot(db, id)))!
    await admin(db => recordDecision(db, { pilotId: pilot.id, decision: 'revise', note: 'tighten the templates', actorId: STAFF }))
    await expect(admin(db => transitionEngagement(db, { engagementId: id, to: 'active', actorId: STAFF }))).rejects.toMatchObject({ code: 'gate_failed' })
    await admin(db => recordDecision(db, { pilotId: pilot.id, decision: 'continue', note: 'response time halved', actorId: STAFF }))
    await admin(db => transitionEngagement(db, { engagementId: id, to: 'active', actorId: STAFF }))
    expect((await admin(db => getEngagement(db, id)))!.status).toBe('active')
    await admin(db => uncompleteItem(db, { engagementId: id, key: 'training_completed' }))
  })
  it('RLS: client B cannot read agency A onboarding items', async () => {
    const b = await withUser(SESSIONS.clientB, db => db.query('select id from onboarding_items where agency_id = $1', [AGENCY_A]))
    expect(b.length).toBe(0)
    const own = await withUser(SESSIONS.clientB, db => db.query('select id from onboarding_items where agency_id = $1', [AGENCY_B]))
    expect(own.length).toBe(0)
    const a = await withUser(SESSIONS.clientA, db => db.query('select id from onboarding_items where engagement_id = $1', [id]))
    expect(a.length).toBe(DEFAULT_ITEMS.length)
  })
})
