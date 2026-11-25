/**
 * Reliability campaign: budget enforcement under concurrency.
 *   - the monthly action allowance at its limit: concurrent sends for the last slot, only one goes out; the
 *     others are held for approval with the reason (never dropped);
 *   - the AI budget under concurrent calls: the gateway's per-organization lock and worst-case reservation keep
 *     the month's spend within the budget whatever runs at once; refused calls cost nothing;
 *   - (an AI budget used up mid-run falling back to the rules is in tests/ops/ai-assist.test.ts)
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, merchantActor, resetMerchant } from '../merchant/helpers'
import { cleanInfra } from '../infra/helpers'
import { fakeResend, restoreEmail, chaser, SUPPLIER, sent } from '../infra/email-env'
import { approveMessage, createAgentMessages } from '../../lib/email/engine'
import { actionsUsed } from '../../lib/plans/allowance'
import { setLimit, restoreLimits } from '../plans/limits'
import { aiComplete } from '../../lib/ai/gateway'
import { setFakeProvider } from '../../lib/ai/providers'
import { setBudgetOverride } from '../../lib/ai/budgets'

const ready = await prepareDb()
const ENV: Record<string, string> = {
  BILLING_MODE: 'test', STRIPE_PRICE_STARTER_MONTHLY: 'price_RelStarter', STRIPE_PRICE_GROWTH_MONTHLY: 'price_RelGrowth', STRIPE_PRICE_PRO_MONTHLY: 'price_RelPro',
  AI_PROVIDER: 'fake', AI_MODEL_ROUTINE: 'routine-test', AI_MODEL_COMPLEX: 'complex-test', AI_PRICES: JSON.stringify({ 'routine-test': { input: 100, output: 100 }, 'complex-test': { input: 100, output: 100 } }),
}
const saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]))
const restore = () => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }

beforeEach(async () => {
  restore(); fakeResend()
  if (ready) {
    await cleanInfra(); await resetMerchant(NW); await restoreLimits()
    await admin(async db => {
      await db.query(`update agencies set plan_tier = 'starter', plan_key = null where id = $1`, [NW.org])
      await db.query('delete from ai_usage where org_id = $1', [NW.org])
      await db.query('delete from ai_budget_overrides where org_id = $1', [NW.org])
    })
  }
})
afterEach(async () => { restore(); restoreEmail(); setFakeProvider(null); if (ready) await restoreLimits() })
afterAll(async () => { if (ready) { await admin(db => db.query('delete from ai_usage where org_id = $1', [NW.org])); await admin(db => db.query('delete from ai_budget_overrides where org_id = $1', [NW.org])); await resetMerchant(NW) } })

describe.skipIf(!ready)('budgets under concurrency', () => {
  it('the monthly allowance at its last slot: of five sends approved at once, exactly one goes out; the rest are held with the reason', async () => {
    const owner = await merchantActor(NW)
    const c = await chaser(owner, NW)
    const drafts = Array.from({ length: 5 }, (_, k) => ({ taskKey: 'supplier_reorder' as const, dedupeKey: `budget-${k}-${randomUUID()}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: `Restock ${k}`, bodyText: `Please confirm ${k}.`, attachments: [] } }))
    const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts })
    const ids = r.created.map(x => x.id)
    for (const [k, v] of Object.entries(ENV)) if (k.startsWith('BILLING') || k.startsWith('STRIPE')) process.env[k] = v
    const used = await admin(db => actionsUsed(db, NW.org))
    await setLimit('starter', 'monthlyActions', used + 1)
    const hashes = await admin(db => db.query<{ id: string; content_hash: string }>('select id, content_hash from email_messages where id = any($1)', [ids]))
    const out = await Promise.all(hashes.map(h => approveMessage(owner, h.id, h.content_hash).catch(e => ({ status: 'error', reason: (e as Error).message }))))
    expect(out.filter(o => o.status === 'accepted')).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(await admin(db => actionsUsed(db, NW.org))).toBe(used + 1)
    const rest = await admin(db => db.query<{ status: string; status_reason: string | null }>(`select status, status_reason from email_messages where id = any($1) and status <> 'accepted'`, [ids]))
    expect(rest).toHaveLength(4)
    for (const m of rest) {
      expect(m.status).toBe('awaiting_approval')
      expect(m.status_reason).toMatch(/allowance of \d+ actions is used/)
    }
  })

  it('AI budget: twenty calls at once never spend past the month\'s budget; the refused ones cost nothing', async () => {
    for (const [k, v] of Object.entries(ENV)) if (k.startsWith('AI_')) process.env[k] = v
    setFakeProvider(async () => { await new Promise(r => setTimeout(r, 20)); return { text: 'ok', inputTokens: null, outputTokens: 10 } })
    await admin(db => setBudgetOverride(db, NW.org, '', 0.2, 'staff:test'))
    const out = await Promise.all(Array.from({ length: 20 }, (_, k) => aiComplete({ orgId: NW.org, agentRef: `test:budget-${k % 4}`, purpose: 'test.budget', tier: 'routine', input: 'x'.repeat(400), maxOutputTokens: 100 })))
    const ok = out.filter(o => o.ok).length, refused = out.filter(o => !o.ok && /^budget_/.test(o.code)).length
    expect(ok, JSON.stringify(out.slice(0, 2))).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    expect(ok + refused).toBe(20)
    const spend = await admin(db => db.one<{ s: string; refused_cost: string }>(`select coalesce(sum(cost_usd) filter (where outcome <> 'refused'), 0)::text as s, coalesce(sum(cost_usd) filter (where outcome = 'refused'), 0)::text as refused_cost from ai_usage where org_id = $1`, [NW.org]))
    expect(Number(spend!.s)).toBeLessThanOrEqual(0.2)
    expect(Number(spend!.refused_cost)).toBe(0)
  })
})
