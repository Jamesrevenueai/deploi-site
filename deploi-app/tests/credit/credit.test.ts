import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { creditLabel, creditState } from '../../lib/credit/label'

const ready = await prepareDb()
const PROSPECT = uuidFrom('prospect:buckeye')

/** The same UPDATE the setStage('build_sold') server action runs (lib/sales/actions.ts). */
async function applyOnBuildSold(prospectId: string) {
  await admin(db => db.query(
    `update agencies set
       assessment_credit_applied_at = case when now() < credit_expires_at then now() else assessment_credit_applied_at end,
       credit_expired = case when now() < credit_expires_at then credit_expired else true end
     where id = (select agency_id from prospects where id = $1)
       and assessment_credit_cents > 0 and assessment_credit_applied_at is null and credit_expired = false`, [prospectId]))
}
const readCredit = () => admin(db => db.one<{ assessment_credit_applied_at: string | null; credit_expired: boolean; credit_expires_at: string | null }>(
  'select assessment_credit_applied_at, credit_expired, credit_expires_at from agencies where id = $1', [AGENCY_A]))

describe.skipIf(!ready)('item 6: assessment credit expiry', () => {
  beforeAll(async () => {
    await admin(db => db.query("update agencies set assessment_credit_cents = 150000, assessment_credit_applied_at = null, credit_expired = false where id = $1", [AGENCY_A]))
  })

  it('selling an assessment stamps assessment_sold_at and credit_expires_at = sold + 60 days', async () => {
    // same statements createAssessment runs (lib/assessments/actions.ts)
    await admin(async db => {
      await db.query(`update agencies set assessment_credit_cents = $1, credit_expires_at = now() + interval '60 days', assessment_credit_expires_at = now() + interval '60 days',
         assessment_credit_applied_at = null, credit_expired = false where id = $2`, [150000, AGENCY_A])
      await db.query("update prospects set assessment_sold_at = now() where id = $1", [PROSPECT])
    })
    const g = await readCredit()
    const p = await admin(db => db.one<{ assessment_sold_at: string }>('select assessment_sold_at from prospects where id = $1', [PROSPECT]))
    const diffDays = (new Date(g!.credit_expires_at!).getTime() - new Date(p!.assessment_sold_at).getTime()) / 86400e3
    expect(Math.round(diffDays)).toBe(60)
    expect(g?.credit_expired).toBe(false)
  })

  it('build_sold inside the window applies the credit', async () => {
    await admin(db => db.query("update agencies set credit_expires_at = now() + interval '10 days', assessment_credit_applied_at = null, credit_expired = false where id = $1", [AGENCY_A]))
    await applyOnBuildSold(PROSPECT)
    const g = await readCredit()
    expect(g?.assessment_credit_applied_at).toBeTruthy()
    expect(g?.credit_expired).toBe(false)
    expect(creditState({ assessment_credit_cents: 150000, credit_expires_at: g!.credit_expires_at, assessment_credit_applied_at: g!.assessment_credit_applied_at, credit_expired: g!.credit_expired })).toBe('applied')
  })

  it('build_sold after the window marks the credit expired and never applies it', async () => {
    await admin(db => db.query("update agencies set credit_expires_at = now() - interval '1 day', assessment_credit_applied_at = null, credit_expired = false where id = $1", [AGENCY_A]))
    await applyOnBuildSold(PROSPECT)
    const g = await readCredit()
    expect(g?.assessment_credit_applied_at).toBeNull()
    expect(g?.credit_expired).toBe(true)
    // a second build_sold cannot revive it
    await admin(db => db.query("update agencies set credit_expires_at = now() + interval '30 days' where id = $1", [AGENCY_A]))
    await applyOnBuildSold(PROSPECT)
    const g2 = await readCredit()
    expect(g2?.assessment_credit_applied_at).toBeNull()
    expect(g2?.credit_expired).toBe(true)
  })

  it('card label reads Credit: $X, expires in N days / expired / applied', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    const in12 = new Date('2026-11-01T12:00:00Z').toISOString()
    expect(creditLabel({ assessment_credit_cents: 150000, credit_expires_at: in12 }, now)).toBe('Credit: $1,500, expires in 12 days')
    expect(creditLabel({ assessment_credit_cents: 150000, credit_expires_at: in12, credit_expired: true }, now)).toBe('Credit expired: $1,500')
    expect(creditLabel({ assessment_credit_cents: 150000, credit_expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('Credit expired: $1,500')
    expect(creditLabel({ assessment_credit_cents: 150000, credit_expires_at: in12, assessment_credit_applied_at: now.toISOString() }, now)).toBe('Credit applied: $1,500')
    expect(creditLabel({ assessment_credit_cents: 0, credit_expires_at: null }, now)).toBeNull()
  })
})
