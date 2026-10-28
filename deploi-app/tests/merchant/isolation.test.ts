import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin, withUser, withOrgSession } from '../../lib/db'
import { runScan } from '../../lib/engine/scan'
import { storeCredential } from '../../lib/connectors/credentials'
import { NW, HB, merchantActor, resetMerchant } from './helpers'

const ready = await prepareDb()
const TABLES = ['store_connections', 'merchant_rules', 'scans', 'issues', 'proposals', 'approvals', 'executions', 'engine_audit', 'app_subscriptions']

describe.skipIf(!ready)('organization isolation and credential protection', () => {
  beforeAll(async () => {
    await resetMerchant(NW); await resetMerchant(HB)
    await runScan(NW.conn, { trigger: 'test' }); await runScan(HB.conn, { trigger: 'test' })
    await admin(db => storeCredential(db, { connectionId: NW.conn, orgId: NW.org, secret: 'shpat_synthetic_test_token', actor: 'test' }))
  })

  it('a merchant user sees only their own organization in every engine table (profile session and Shopify session)', async () => {
    const hb = await merchantActor(HB)
    if (hb.kind !== 'profile') throw new Error('expected profile actor')
    for (const t of TABLES) {
      const viaProfile = await withUser(hb.session, db => db.one<{ n: string }>(`select count(*)::text as n from ${t} where org_id = $1`, [NW.org]))
      const viaShopify = await withOrgSession(HB.org, 'shopify:test', db => db.one<{ n: string }>(`select count(*)::text as n from ${t} where org_id = $1`, [NW.org]))
      expect(Number(viaProfile!.n), `${t} via profile`).toBe(0)
      expect(Number(viaShopify!.n), `${t} via shopify session`).toBe(0)
    }
    const own = await withOrgSession(NW.org, 'shopify:test', db => db.one<{ n: string }>(`select count(*)::text as n from issues`))
    expect(Number(own!.n)).toBeGreaterThan(0)
  })

  it('user sessions cannot write engine tables directly; the audit trail is append-only even for the service role', async () => {
    const nw = await merchantActor(NW)
    if (nw.kind !== 'profile') throw new Error('expected profile actor')
    await expect(withUser(nw.session, db => db.query(`update proposals set status = 'approved' where connection_id = $1`, [NW.conn]))).rejects.toThrow(/permission denied/)
    await expect(withUser(nw.session, db => db.query(`insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind) select org_id, id, change_hash, 'x', 'profile' from proposals limit 1`))).rejects.toThrow(/permission denied/)
    await expect(withOrgSession(NW.org, 'shopify:test', db => db.query(`update issues set status = 'resolved'`))).rejects.toThrow(/permission denied/)
    await expect(admin(db => db.query(`update engine_audit set actor = 'tampered' where org_id = $1`, [NW.org]))).rejects.toThrow(/permission denied/)
    await expect(admin(db => db.query(`delete from engine_audit where org_id = $1`, [NW.org]))).rejects.toThrow(/permission denied/)
  })

  it('credentials are encrypted at rest and unreadable from any user session', async () => {
    const row = await admin(db => db.one<{ ciphertext: string }>('select ciphertext from store_credentials where connection_id = $1', [NW.conn]))
    expect(row!.ciphertext).not.toContain('shpat_synthetic_test_token')
    const nw = await merchantActor(NW)
    if (nw.kind !== 'profile') throw new Error('expected profile actor')
    await expect(withUser(nw.session, db => db.query('select ciphertext from store_credentials'))).rejects.toThrow(/permission denied/)
    await expect(withOrgSession(NW.org, 'shopify:test', db => db.query('select ciphertext from store_credentials'))).rejects.toThrow(/permission denied/)
    const audit = await admin(db => db.query<{ detail: Record<string, unknown> }>(`select detail from engine_audit where entity_type = 'credential' and connection_id = $1`, [NW.conn]))
    expect(JSON.stringify(audit)).not.toContain('shpat_synthetic_test_token')
  })
})
