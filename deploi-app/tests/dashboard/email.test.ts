import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { getMetrics } from '../../lib/dashboard/metrics'
import { buildMorningReport, lines, humanItems } from '../../emails/morning-report'
import { sendMorningReport } from '../../lib/dashboard/send'
import { mockOutbox } from '../../lib/adapters/email'

const ready = await prepareDb()
const clearToday = () => admin(db => db.query("delete from worker_runs where worker = 'morning_report' and agency_id = $1 and started_at >= now() - interval '2 days'", [AGENCY_A]))

describe.skipIf(!ready)('morning report email', () => {
  it('contains the six numbers and the human items as counts and links, in html and text', async () => {
    const m = await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    const mail = await buildMorningReport(m, 'https://app.getdeploi.com')
    expect(mail.subject).toContain('Buckeye Home Care')
    expect(lines(m).length).toBe(6)
    for (const l of lines(m)) { expect(mail.text).toContain(l.label); expect(mail.html).toContain(l.label); expect(mail.html).toContain(`https://app.getdeploi.com${l.href}`) }
    expect(mail.text).toContain('6 open')
    expect(mail.text).toContain('9 open')
    expect(mail.text).toContain('6 of 40 auths')
    expect(mail.text).toContain('2 new')
    expect(mail.text.toLowerCase()).toContain('needs a human today')
    expect(humanItems(m).length).toBe(m.needsHuman.length)
    for (const h of humanItems(m)) { expect(mail.text).toContain(h.title); expect(mail.html).toContain(`https://app.getdeploi.com${h.href}`) }
    expect(mail.html).toContain('hello@getdeploi.com')
  })

  it('carries no names, initials, client identifiers or free text from records', async () => {
    const m = await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    const mail = await buildMorningReport(m, 'https://app.getdeploi.com')
    const people = await admin(db => db.query<{ n: string }>(
      `select first_name as n from aides where agency_id = $1 union select last_name from aides where agency_id = $1
       union select first_name from clients where agency_id = $1 union select last_name from clients where agency_id = $1
       union select first_name from applicants where agency_id = $1 union select last_name from applicants where agency_id = $1
       union select full_name from profiles where agency_id = $1 and full_name is not null
       union select source_name from referrals where agency_id = $1 and source_name is not null`, [AGENCY_A]))
    expect(people.length).toBeGreaterThan(50)
    const hay = (mail.html + '\n' + mail.text).toLowerCase()
    for (const p of people) expect(hay, `email must not contain "${p.n}"`).not.toContain(p.n.toLowerCase())
    // the dashboard's needs-human details (rule names, "Client A.B.", service codes) stay out of the email
    for (const h of m.needsHuman) expect(hay).not.toContain(h.detail.toLowerCase())
    expect(hay).not.toMatch(/client [a-z]\.[a-z]\./)
    for (const e of m.exceptions.openItems) expect(hay).not.toContain(e.id)
    for (const a of m.authorizations.rows) { expect(hay).not.toContain(a.id); expect(hay).not.toContain(a.clientInitials.toLowerCase()) }
  })

  it('sends to every client user of the agency, records a worker run, and skips a duplicate the same day', async () => {
    await clearToday()
    const before = mockOutbox.length
    const r = await withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A))
    expect(r.skipped).toBe(false)
    expect(r.recipients).toBe(1)
    expect(mockOutbox.length - before).toBe(1)
    expect(mockOutbox[mockOutbox.length - 1].to).toBe('admin@buckeyehomecare.example')
    const run = await withUser(SESSIONS.staff, db => db.one<{ worker: string }>("select worker from worker_runs where worker = 'morning_report' and agency_id = $1 order by started_at desc limit 1", [AGENCY_A]))
    expect(run?.worker).toBe('morning_report')
    const again = await withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A))
    expect(again.skipped).toBe(true)
    expect(mockOutbox.length - before).toBe(1)
    // a test send to one address (record: false) still works and records nothing
    const test = await withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A, new Date(), { to: ['hello@getdeploi.com'], record: false }))
    expect(test.skipped).toBe(false)
    expect(mockOutbox.length - before).toBe(2)
    const runs = await admin(db => db.one<{ n: string }>("select count(*)::text as n from worker_runs where worker = 'morning_report' and agency_id = $1 and started_at >= now() - interval '2 days'", [AGENCY_A]))
    expect(Number(runs?.n)).toBe(1)
    await clearToday()
  })

  it('two concurrent senders produce one email', async () => {
    await clearToday()
    const before = mockOutbox.length
    const [a, b] = await Promise.all([
      withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A)),
      withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A)),
    ])
    expect([a.skipped, b.skipped].sort()).toEqual([false, true])
    expect(mockOutbox.length - before).toBe(1)
    await clearToday()
  })
})
