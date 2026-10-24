import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { transitionEngagement, TransitionError } from '../../lib/website/transition'
import { getEngagement, listEngagements, statusCounts, internalRateCents, refreshTargetDate } from '../../lib/website/queries'
import { websitePriceCents, type Engagement } from '../../lib/website/states'
import { getPricing } from '../../lib/catalog/pricing'

const ready = await prepareDb()
const staff = SESSIONS.staff
const PROSPECT = uuidFrom('prospect:p8') // Grandview Aides LLC: a seeded prospect with no assessment
let id = ''

const row = () => admin(db => db.one<Engagement>('select w.*, w.target_date::text as target_date from website_engagements w where id = $1', [id]))
const move = (to: string, note: string | null = null) => withUser(staff, db => transitionEngagement(db, id, to, staff.uid, note))
const set = (sql: string, params: unknown[] = []) => withUser(staff, db => db.query(`update website_engagements set ${sql} where id = $1`, [id, ...params]))
const expectBlocked = async (to: string, pattern: RegExp) => {
  const err = await move(to).catch(e => e)
  expect(err).toBeInstanceOf(TransitionError)
  expect((err as TransitionError).code).toBe('blocked')
  expect((err as TransitionError).message).toMatch(pattern)
}

describe.skipIf(!ready)('website engagement workflow (no assessment, no credit)', () => {
  beforeAll(async () => {
    await admin(db => db.query('delete from website_engagements where prospect_id = $1', [PROSPECT]))
    const r = await withUser(staff, db => db.one<{ id: string }>(
      `insert into website_engagements (prospect_id, agency_id, website_url, platform, goal, pages, requested_changes, access_status, approval_contact, price_cents)
       values ($1, $2, 'https://grandview-aides.example', 'Wix', 'more inquiries', '["Home","Contact"]', 'clearer CTA', 'unknown', 'Morgan Vance', $3) returning id`,
      [PROSPECT, AGENCY_A, websitePriceCents()]))
    id = r!.id
  })
  afterAll(async () => { await admin(db => db.query('delete from website_engagements where prospect_id = $1', [PROSPECT])) })

  it('stores $500 one-time from pricing and starts in inquiry with no assessment or credit columns', async () => {
    const e = await row()
    expect(e?.price_cents).toBe(50000)
    expect(e?.price_cents).toBe(Math.round(getPricing().website.price * 100))
    expect(e?.status).toBe('inquiry')
    expect(e?.payment_status).toBe('unpaid')
    expect(e?.payment_is_mock).toBe(true)
    const cols = await admin(db => db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name in ('website_engagements','website_labor','website_transitions')"))
    expect(cols.some(c => /assessment|credit/.test(c.column_name))).toBe(false)
    const assessments = await admin(db => db.query('select id from assessments where prospect_id = $1', [PROSPECT]))
    expect(assessments.length).toBe(0)
  })

  it('is staff-only even when agency_id is set: client users of that agency read nothing', async () => {
    const asClient = await withUser(SESSIONS.clientA, db => db.query('select id from website_engagements'))
    expect(asClient.length).toBe(0)
    const asOther = await withUser(SESSIONS.clientB, db => db.query('select id from website_engagements'))
    expect(asOther.length).toBe(0)
    await expect(withUser(SESSIONS.clientA, db => db.query("insert into website_labor (website_engagement_id, hours, kind) values ($1, 1, 'review')", [id]))).rejects.toThrow()
    const labor = await withUser(SESSIONS.clientA, db => db.query('select id from website_labor'))
    expect(labor.length).toBe(0)
    const tr = await withUser(SESSIONS.clientA, db => db.query('select id from website_transitions'))
    expect(tr.length).toBe(0)
    const asStaff = await withUser(staff, db => db.query('select id from website_engagements where id = $1', [id]))
    expect(asStaff.length).toBe(1)
  })

  it('walks every gate: scope → accepted → payment (mock refused) → access → improving → preview → approval → published → completed', async () => {
    await move('scope_confirmed', 'call held')
    expect((await row())?.scope_confirmed_at).toBeTruthy()

    await expectBlocked('accepted', /acceptance evidence/i)
    await set(`acceptance_evidence = '{"accepted_by":"Morgan Vance","method":"email reply"}'::jsonb`)
    await move('accepted')
    expect((await row())?.accepted_at).toBeTruthy()

    // feasibility first, then payment: a mock payment is visible but never satisfies the gate
    await set(`payment_status = 'mock_paid', payment_is_mock = true, paid_at = now()`)
    await expectBlocked('payment_confirmed', /feasibility/i)
    await set(`feasibility = '{"status":"feasible"}'::jsonb`)
    await expectBlocked('payment_confirmed', /mock/i)
    expect((await row())?.payment_status).toBe('mock_paid')
    await set(`payment_status = 'paid', payment_is_mock = false, paid_at = now()`)
    await move('payment_confirmed')

    await expectBlocked('access_received', /access status/i)
    await set(`access_status = 'have_login'`)
    await expectBlocked('access_received', /arrangement/i)
    await set(`access_arrangement = 'Invited as editor on the Wix site'`)
    await move('access_received')
    expect((await row())?.access_received_at).toBeTruthy()

    await expectBlocked('improving', /backup/i)
    await set(`backup_plan = 'Wix site history snapshot before editing'`)
    await move('improving')

    await expectBlocked('preview_ready', /preview URL|staging/i)
    await set(`rollback_note = 'No staging on Wix: direct edit with rollback note'`)
    await move('preview_ready')

    // revision loop: back to improving bumps the round
    await move('improving', 'customer asked for one change')
    expect((await row())?.revision_round).toBe(1)
    await move('preview_ready')

    await expectBlocked('customer_approved', /approval evidence/i)
    await set(`customer_approval_evidence = '{"method":"email","reference":"Re: preview","approved_by":"Morgan Vance","at":"2026-10-21T15:00:00Z"}'::jsonb`)
    await move('customer_approved')
    expect((await row())?.customer_approved_at).toBeTruthy()

    await move('published')
    expect((await row())?.published_at).toBeTruthy()

    await expectBlocked('completed', /verification/i)
    await set(`publication_verification = '{"checked_urls":["https://grandview-aides.example/"]}'::jsonb`)
    await expectBlocked('completed', /handoff/i)
    await set(`handoff_summary = 'Three pages improved; summary emailed.'`)
    await move('completed')
    const e = await row()
    expect(e?.status).toBe('completed')
    expect(e?.publication_verified_at).toBeTruthy()

    const history = await withUser(staff, db => db.query<{ to_status: string }>('select to_status from website_transitions where website_engagement_id = $1 order by at', [id]))
    expect(history.map(h => h.to_status)).toEqual(['scope_confirmed', 'accepted', 'payment_confirmed', 'access_received', 'improving', 'preview_ready', 'improving', 'preview_ready', 'customer_approved', 'published', 'completed'])
    await expect(move('inquiry')).rejects.toThrow()
  })

  it('refuses publication without customer approval evidence (fresh engagement)', async () => {
    const other = await withUser(staff, db => db.one<{ id: string }>(
      `insert into website_engagements (prospect_id, status, pages, requested_changes, customer_approved_at) values ($1, 'customer_approved', '["Home"]', 'x', now()) returning id`, [PROSPECT]))
    const err = await withUser(staff, db => transitionEngagement(db, other!.id, 'published', staff.uid)).catch(e => e)
    expect(err).toBeInstanceOf(TransitionError)
    expect((err as Error).message).toMatch(/refused/i)
    const e = await admin(db => db.one<{ status: string; published_at: string | null }>('select status, published_at from website_engagements where id = $1', [other!.id]))
    expect(e?.status).toBe('customer_approved')
    expect(e?.published_at).toBeNull()
  })

  it('labor rows sum into the budget and the internal rate comes from internal_rates when present', async () => {
    await withUser(staff, db => db.query("insert into website_labor (website_engagement_id, hours, kind, note, logged_by) values ($1, 2.5, 'implementation', 'edits', $2), ($1, 1.75, 'review', null, $2)", [id, staff.uid]))
    const data = await withUser(staff, db => getEngagement(db, id))
    expect(data?.hours).toBe(4.25)
    expect(data?.budget.level).toBe('warn')
    const rate = await withUser(staff, db => internalRateCents(db))
    const exists = await admin(db => db.one<{ r: string | null }>("select to_regclass('public.internal_rates')::text as r"))
    if (exists?.r) { expect(rate).toBeGreaterThan(0); expect(data?.economics.contribution_cents).toBe(50000 - Math.round(4.25 * rate!)) }
    else { expect(rate).toBeNull(); expect(data?.economics.contribution_cents).toBeNull() }
  })

  it('target date is 5 business days after the latest of paid/access/content and lists/counts work', async () => {
    await set(`paid_at = '2026-10-19T12:00:00Z', access_received_at = '2026-10-23T12:00:00Z', content_received_at = '2026-10-20'`)
    const t = await withUser(staff, db => refreshTargetDate(db, id))
    expect(t).toBe('2026-10-30')
    const e = await row()
    expect(String(e?.target_date).slice(0, 10)).toBe('2026-10-30')
    const list = await withUser(staff, db => listEngagements(db, { status: 'completed' }))
    expect(list.some(x => x.id === id)).toBe(true)
    const counts = await withUser(staff, db => statusCounts(db))
    expect(counts.completed).toBeGreaterThanOrEqual(1)
  })
})
