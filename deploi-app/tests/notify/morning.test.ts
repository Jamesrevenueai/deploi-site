/**
 * The morning report (lib/notify/morning.ts): what the agents did since the last report (owner updates,
 * resolved cases, crew jobs done), the labelled estimates, what is unfinished and why; one report per
 * organization per day (a second run sends nothing), the notify.morning job on the durable queue, the daily
 * cron entry, and held vs sent through the system mailer.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { notifyOwner } from '../../lib/notify'
import { morningFacts, sendMorningReport, enqueueMorningReports } from '../../lib/notify/morning'
import { registeredJobKinds, runDueJobs } from '../../lib/jobs'
import { updateRecipients } from '../../lib/notify/preferences'
import { GET as cron } from '../../app/api/cron/daily-report/route'
import { NW, HB } from '../merchant/helpers'
import { fakeResend, resetEnv, cleanNotify, sent } from './helpers'

const ready = await prepareDb()
const T0 = new Date()

async function seedNight() {
  await notifyOwner({ orgId: NW.org, agentKey: 'refunds', agentName: 'Refund Agent', headline: 'Refunded order #1001', whatHappened: 'Charged twice.', whatIDid: ['Refunded'], proof: [], detailsPath: '/store/work/DC-1', severity: 'info', dedupeKey: `m-${Date.now()}-1` })
  await notifyOwner({ orgId: NW.org, agentKey: 'pricing', agentName: 'Pricing Agent', headline: 'Discount <b>50%</b> needs OK', whatHappened: 'x', whatIDid: [], proof: [], detailsPath: '/store/approvals', severity: 'action', dedupeKey: `m-${Date.now()}-2` })
  await admin(async db => {
    await db.query(`insert into cases (org_id, suite, kind, source_app, dedupe_key, title, problem, status, outcome, closed_at) values
      ($1,'commerce','morning_test','import','morning:resolved','Stuck order 1001','x','resolved',$2,now()),
      ($1,'commerce','morning_test','import','morning:blocked','Supplier missing tracking','x','blocked',null,null),
      ($1,'commerce','morning_test','import','morning:waiting','Refund over limit','x','awaiting_approval',null,null)`, [NW.org, JSON.stringify({ summary: 'ok', verifiedAt: new Date().toISOString() })])
    await db.query(`update cases set status_reason = 'the supplier has not answered in 2 days' where org_id = $1 and dedupe_key = 'morning:blocked'`, [NW.org])
    const m = await db.one<{ id: string }>(`insert into crew_members (org_id, name, role, email) values ($1,'Sam','field','sam@notify-test.example') returning id`, [NW.org])
    await db.query(`insert into crew_jobs (org_id, job_ref, crew_member_id, status, done_at) values ($1,'J-1',$2,'done',now()), ($1,'J-2',$2,'sent',null)`, [NW.org, m!.id])
  })
}

describe.skipIf(!ready)('morning report', () => {
  beforeEach(async () => { await cleanNotify([NW.org, HB.org]); await admin(db => db.query(`delete from cases where kind = 'morning_test'`)); fakeResend(); process.env.RESEND_API_KEY = 're_test_key' })
  afterEach(async () => { resetEnv(); await cleanNotify([NW.org, HB.org]); await admin(db => db.query(`delete from cases where kind = 'morning_test'`)) })

  it('facts: updates, resolved cases, crew done, estimates with the formula, unfinished with why', async () => {
    await seedNight()
    const f = await admin(db => morningFacts(db, NW.org, new Date(Date.now() + 1000)))
    expect(f.did.map(d => d.headline).sort()).toEqual(['Discount <b>50%</b> needs OK', 'Refunded order #1001'])
    // other suites' cases for this organization can also have resolved in the window: count what is there
    expect(f.resolved.map(c => c.title)).toContain('Stuck order 1001')
    expect(f.crew).toEqual({ done: 1, open: 1 })
    const minutes = 1 * 6 + f.resolved.length * 10 + 1 * 3
    expect(f.estimate.minutes).toBe(minutes)
    expect(f.estimate.minutesFormula).toContain(`1 finished update(s) × 6 min + ${f.resolved.length} verified case resolution(s) × 10 min + 1 crew job(s) closed × 3 min = ${minutes} min`)
    expect(f.estimate.usd).toBe(Math.round(minutes / 60 * 30 * 100) / 100)
    const blocked = f.unfinished.find(u => u.title === 'Supplier missing tracking')!
    expect(blocked).toMatchObject({ status: 'blocked', why: 'the supplier has not answered in 2 days' })
    expect(f.unfinished.find(u => u.title === 'Refund over limit')!.why).toBe('waiting for your decision')
    // another organization's night is not in it
    const hb = await admin(db => morningFacts(db, HB.org, new Date(Date.now() + 1000)))
    expect(hb.did).toHaveLength(0)
    expect(hb.unfinished.map(u => u.title)).not.toContain('Supplier missing tracking')
  })

  it('sends one report per organization per day (HTML + text, escaped); a second run sends nothing', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    await seedNight()
    sent.length = 0
    const now = new Date(Date.now() + 1000)
    const r = await sendMorningReport(NW.org, { now })
    expect(r.status).toBe('sent')
    const people = (await admin(db => updateRecipients(db, NW.org))).filter(p => p.prefs.email)
    expect(sent).toHaveLength(people.length)
    expect(sent[0].subject).toMatch(/^\[Deploi\] Morning report: \d+ handled, \d+ waiting$/)
    expect(sent[0].html).toContain('Stuck order 1001')
    expect(sent[0].html).toContain('Discount &lt;b&gt;50%&lt;/b&gt; needs OK')
    expect(sent[0].html).toContain('These savings are estimates, not measurements.')
    expect(sent[0].text).toContain('NOT FINISHED YET, AND WHY')
    expect(sent[0].text).toContain('Supplier missing tracking: blocked, the supplier has not answered in 2 days')
    expect(await sendMorningReport(NW.org, { now })).toMatchObject({ status: 'duplicate' })
    expect(sent).toHaveLength(people.length)
    const row = await admin(db => db.one<{ status: string; sent_to_count: number }>('select status, sent_to_count from morning_reports where id = $1', [r.reportId]))
    expect(row).toEqual({ status: 'sent', sent_to_count: people.length })
  })

  it('held unless EMAIL_LIVE_SENDS allows; the next report covers only what happened since the last one', async () => {
    await seedNight()
    const day1 = new Date(Date.now() + 1000)
    expect((await sendMorningReport(NW.org, { now: day1 })).status).toBe('held')
    expect(sent).toHaveLength(0)
    const day2 = new Date(day1.getTime() + 24 * 3600e3)
    const f = await admin(db => morningFacts(db, NW.org, day2))
    expect(f.did).toHaveLength(0)
    expect(f.resolved.map(c => c.title)).not.toContain('Stuck order 1001')
    expect(f.unfinished.length).toBeGreaterThan(0) // still unfinished: reported again, with why
  })

  it('a job per organization on the durable queue, queued once per day; the cron requires its secret; vercel.json schedules it daily', async () => {
    expect(registeredJobKinds()).toContain('notify.morning')
    const a = await enqueueMorningReports(T0)
    const b = await enqueueMorningReports(T0)
    const nw = a.find((x, i) => x.id && b[i].id === x.id)
    expect(nw).toBeTruthy()
    expect(a.filter(x => x.created).length).toBeGreaterThan(0)
    expect(b.filter(x => x.created)).toHaveLength(0)
    const r = await runDueJobs({ kinds: ['notify.morning'], limit: 50, deadlineMs: 60_000 })
    expect(r.ran.length).toBeGreaterThan(0)
    expect(r.ran.every(o => o.status === 'succeeded')).toBe(true)
    expect(await admin(db => db.one('select 1 from morning_reports where org_id = $1', [NW.org]))).toBeTruthy()
    process.env.CRON_SECRET = 'cron-test-secret-0123'
    try {
      expect((await cron(new Request('http://localhost/api/cron/daily-report'))).status).toBe(401)
      const ok = await cron(new Request('http://localhost/api/cron/daily-report', { headers: { authorization: 'Bearer cron-test-secret-0123' } }))
      expect(ok.status).toBe(200)
    } finally {
      delete process.env.CRON_SECRET
      // the job ran for every business in the test database: remove what it wrote
      await admin(async db => { await db.query(`delete from morning_reports`); await db.query(`delete from system_emails where template = 'morning_report'`); await db.query(`delete from jobs where kind = 'notify.morning'`) })
    }
    const crons = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8')).crons as { path: string; schedule: string }[]
    expect(crons.find(c => c.path === '/api/cron/daily-report')?.schedule).toBe('11 12 * * *')
  })
})
