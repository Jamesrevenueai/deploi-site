import './env'
import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, merchantActor, resetMerchant } from './helpers'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES } from '../../lib/connectors/shopify/config'

/** A store installed before write_products moved into the install scopes (read scopes only). */
const LEGACY = REQUIRED_SCOPES.filter(s => s !== 'write_products')
import { mutateSynthetic } from '../../lib/connectors/shopify/synthetic'
import { syncScopes } from '../../lib/connectors/shopify/scopes'
import { loadConnection } from '../../lib/engine/scan'
import { createAgent, editAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { agentDetail } from '../../lib/agents/queries'
import { approveAndExecute } from '../../lib/engine/execute'

const ready = await prepareDb()
const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
const base = { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, schedule: { kind: 'manual' }, approvalMode: 'draft' }

describe.skipIf(!ready)('a read-only install (from before write_products was requested at install) drafts; writing needs the store to grant write_products', () => {
  beforeEach(async () => {
    await resetMerchant(NW)
    // the store installed with the read-only scopes only, and Shopify says so too
    await admin(db => db.query('update store_connections set scopes = $2 where id = $1', [NW.conn, LEGACY]))
    await mutateSynthetic(NW.conn, s => { s.accessScopes = [...LEGACY] })
  })

  it('drafts need no write scope; widening reports the missing scope; a write is blocked until Shopify grants it; then the sync clears it', async () => {
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Read-only watcher', taskText: 'watch overselling', policy: base })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    const r1 = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r1.status).toBe('completed')
    expect(r1.counts.drafted).toBeGreaterThan(0)
    let d = await agentDetail(actor, c.agentId)
    expect(d.policies.find(p => p.status === 'active')!.missing_scopes).toEqual([])
    expect(d.storeScopes).toEqual({ granted: LEGACY, requestable: OPTIONAL_SCOPES })

    // widening to "after my approval" needs Deploi's grant AND the store's write_products
    const e = await editAgent(actor, c.agentId, { policy: { ...base, approvalMode: 'review' } })
    expect(e.requiresGrant).toBe(true)
    expect(e.missingScopes).toEqual(['write_products'])
    d = await agentDetail(actor, c.agentId)
    expect(d.policies.find(p => p.status === 'pending_grant')!.missing_scopes).toEqual(['write_products'])
    await grantPolicy(actor, c.agentId, e.policyId, e.policyHash)
    const r2 = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r2.counts.awaitingApproval).toBeGreaterThan(0)
    const p = (await admin(db => db.one<{ id: string; change_hash: string }>(`select id, change_hash from proposals where agent_id = $1 and status = 'pending_approval' limit 1`, [c.agentId])))!
    const result = await approveAndExecute(actor, p.id, p.change_hash)
    expect(result.status).toBe('blocked')
    const ex = (await admin(db => db.one<{ status: string; status_reason: string | null }>('select status, status_reason from executions where proposal_id = $1', [p.id])))!
    expect(ex.status).toBe('blocked')
    expect(ex.status_reason).toBe('missing permission: write_products')
    expect((await admin(db => db.one<{ n: string }>('select count(*)::text as n from executions where connection_id = $1 and status = $2', [NW.conn, 'verified'])))!.n).toBe('0')

    // the merchant approves the app's updated install scopes on Shopify's screen; Deploi re-reads the granted list from Shopify, never from the browser
    await mutateSynthetic(NW.conn, s => { s.accessScopes = [...LEGACY, 'write_products'] })
    const sync = await admin(async db => syncScopes(db, (await loadConnection(db, NW.conn))!, actor.label))
    expect(sync).toEqual({ granted: [...LEGACY, 'write_products'].sort(), changed: true })
    d = await agentDetail(actor, c.agentId)
    expect(d.policies.find(p => p.status === 'active')!.missing_scopes).toEqual([])
    expect(d.storeScopes!.granted).toContain('write_products')
    const again = await admin(async db => syncScopes(db, (await loadConnection(db, NW.conn))!, actor.label))
    expect(again.changed).toBe(false)
  })
})
