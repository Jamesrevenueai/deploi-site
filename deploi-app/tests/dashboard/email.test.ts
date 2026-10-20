import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, AGENCY_A } from '../db/helpers'
import { withUser } from '../../lib/db'
import { getMetrics } from '../../lib/dashboard/metrics'
import { buildMorningReport, lines } from '../../emails/morning-report'
import { sendMorningReport } from '../../lib/dashboard/send'
import { mockOutbox } from '../../lib/adapters/email'

const ready = await prepareDb()

describe.skipIf(!ready)('morning report email', () => {
  it('contains the six numbers and the three human items in html and text', async () => {
    const m = await withUser(SESSIONS.clientA, db => getMetrics(db, AGENCY_A))
    const mail = await buildMorningReport(m, 'https://app.getdeploi.com')
    expect(mail.subject).toContain('Buckeye Home Care')
    expect(lines(m).length).toBe(6)
    for (const l of lines(m)) { expect(mail.text).toContain(l.label); expect(mail.html).toContain(l.label) }
    expect(mail.text).toContain('6 open')
    expect(mail.text).toContain('9 open')
    expect(mail.text).toContain('6 of 40 auths')
    expect(mail.text).toContain('2 new')
    expect(mail.text.toLowerCase()).toContain('needs a human today')
    for (const h of m.needsHuman) expect(mail.text).toContain(h.title)
    expect(mail.html).toContain('hello@getdeploi.com')
  })

  it('sends to every client user of the agency and records a worker run', async () => {
    const before = mockOutbox.length
    const r = await withUser(SESSIONS.staff, db => sendMorningReport(db, AGENCY_A))
    expect(r.recipients).toBe(1)
    expect(mockOutbox.length - before).toBe(1)
    expect(mockOutbox[mockOutbox.length - 1].to).toBe('admin@buckeyehomecare.example')
    const run = await withUser(SESSIONS.staff, db => db.one<{ worker: string }>("select worker from worker_runs where worker = 'morning_report' and agency_id = $1 order by started_at desc limit 1", [AGENCY_A]))
    expect(run?.worker).toBe('morning_report')
  })
})
