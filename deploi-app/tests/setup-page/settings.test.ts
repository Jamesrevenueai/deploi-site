import './env'
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { withUser, admin } from '../../lib/db'
import { upsertSetting, getSettings, settingString } from '../../lib/setup/settings'
import { gatherReadiness } from '../../lib/setup/gather'

const ready = await prepareDb()

describe.skipIf(!ready)('settings + readiness on the database', () => {
  it('upserts a setting twice, audits it, and the readiness picks it up', async () => {
    await withUser(SESSIONS.staff, async db => {
      await upsertSetting(db, 'booking_url', { url: 'https://cal.com/one' }, SESSIONS.staff.uid)
      await upsertSetting(db, 'booking_url', { url: 'https://cal.com/two' }, SESSIONS.staff.uid)
      const s = await getSettings(db)
      expect(settingString(s.booking_url, 'url')).toBe('https://cal.com/two')
      const r = await gatherReadiness(db)
      expect(r.total).toBe(7)
      expect(r.checks.find(c => c.key === 'booking_url')?.ok).toBe(true)
      expect(r.checks.find(c => c.key === 'resend')?.ok).toBe(false)
    })
    const n = await admin(db => db.one<{ n: string }>("select count(*)::text as n from audit_events where table_name = 'settings' and row_id = 'booking_url'"))
    expect(Number(n?.n)).toBeGreaterThanOrEqual(2)
  })
  it('clients cannot read settings', async () => {
    const rows = await withUser(SESSIONS.clientA, db => db.query('select key from settings'))
    expect(rows.length).toBe(0)
  })
})
