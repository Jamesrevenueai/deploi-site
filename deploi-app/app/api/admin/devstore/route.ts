/**
 * Development-store harness. Lets the operator drive a real installed dev store server-side (migrate the
 * scratch database, read counts, create and run template agents, approve a change, create a TEST billing
 * charge, read audit and mail state) when the operator cannot sit in front of the embedded app.
 *
 * It is unreachable in production (lib/auth-guard.ts#isProductionDeployment) and otherwise answers only
 * when DEVSTORE_ADMIN_TOKEN is set (32+ chars) and the request carries it in `x-devstore-token`. Everything
 * it does runs through the same engine entry points the merchant UI uses, as a `shopify_user` actor of the
 * store's organization, so the authorization model is exercised, not bypassed: agents still start at drafts
 * only, writes still need a granted version and the store's own scopes, and every action is audited.
 */
import { NextResponse } from 'next/server'
import type { ShopifyVariantRecord } from '@/lib/connectors/shopify/types'
import { timingSafeEqual } from 'node:crypto'
import { admin } from '@/lib/db'
import { isProductionDeployment } from '@/lib/auth-guard'
import { log } from '@/lib/log'
import { withActor, type Actor } from '@/lib/engine/actor'
import { loadConnection, runScan } from '@/lib/engine/scan'
import { getConnector } from '@/lib/engine/registry'
import { approveAndExecute } from '@/lib/engine/execute'
import { getAccess } from '@/lib/engine/access'
import { createAgent, editAgent, grantPolicy } from '@/lib/agents/lifecycle'
import { runAgent } from '@/lib/agents/run'
import { assignTask, runTask } from '@/lib/agents/tasks'
import { agentDetail, listAgents } from '@/lib/agents/queries'
import { templatePolicy, templateByKey } from '@/lib/agents/templates'
import { weeklyFacts, weekStartOf, sendWeeklySummary } from '@/lib/agents/weekly'
import { listMessages } from '@/lib/email/queries'
import { shopifyGraphql } from '@/lib/connectors/shopify/client'
import { M_CREATE_SUBSCRIPTION, Q_ACTIVE_SUBSCRIPTIONS } from '@/lib/connectors/shopify/queries'
import { recordSubscription } from '@/lib/connectors/shopify/billing'
import { syncScopes } from '@/lib/connectors/shopify/scopes'
import { shopifyConfig } from '@/lib/connectors/shopify/config'
import { migrate } from '../../../../scripts/migrate'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_SHOP = 'james-jwtftl1e.myshopify.com'

function authorized(req: Request): boolean {
  if (isProductionDeployment()) return false
  const expected = (process.env.DEVSTORE_ADMIN_TOKEN ?? '').trim()
  const given = (req.headers.get('x-devstore-token') ?? '').trim()
  if (expected.length < 32 || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

async function connFor(shop: string) {
  const row = await admin(db => db.one<{ id: string; org_id: string; status: string; scopes: string[]; installed_at: string | null; uninstalled_at: string | null; display_name: string | null; is_synthetic: boolean }>(
    `select id, org_id, status, scopes, installed_at, uninstalled_at, display_name, is_synthetic from store_connections where platform = 'shopify' and external_id = $1`, [shop]))
  return row
}

const actorFor = (orgId: string, shop: string): Actor => ({ kind: 'shopify_user', orgId, shop, userId: 'devstore-harness', label: `shopify:${shop}:user:devstore-harness` })

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const action = String(body.action ?? '')
  const shop = String(body.shop ?? DEFAULT_SHOP).toLowerCase()
  log.info('devstore.harness', { action, shop })
  try {
    if (action === 'migrate') {
      const lines: string[] = []
      const orig = console.log
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); orig(...a) }
      try { await migrate() } finally { console.log = orig }
      return NextResponse.json({ ok: true, lines })
    }
    if (action === 'env') {
      return NextResponse.json({ ok: true, vercelEnv: process.env.VERCEL_ENV ?? null, shopifyConfigured: shopifyConfig.configured, scopes: shopifyConfig.scopes, optionalScopes: shopifyConfig.optionalScopes, appUrl: shopifyConfig.appUrl, database: (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//<credentials>@').slice(0, 120) })
    }
    const conn = await connFor(shop)
    if (action === 'status') {
      const data = await admin(async db => {
        const credentials = conn ? Number((await db.one<{ n: string }>('select count(*)::text as n from store_credentials where connection_id = $1', [conn.id]))?.n ?? 0) : 0
        const access = conn ? await getAccess(db, { id: conn.id, platform: 'shopify', external_id: shop, is_synthetic: conn.is_synthetic } as Parameters<typeof getAccess>[1]).catch(e => ({ error: (e as Error).message })) : null
        const agents = conn ? await db.query<{ name: string; status: string }>('select name, status from agents where connection_id = $1 order by created_at', [conn.id]) : []
        const receipts = await db.query<{ topic: string; status: string; note: string | null; received_at: string }>(`select topic, status, note, received_at from webhook_receipts where connection_id = $1 or (connection_id is null and platform = 'shopify') order by received_at desc limit 20`, [conn?.id ?? null])
        const executions = conn ? await db.query<{ status: string; n: string }>('select status, count(*)::text as n from executions where connection_id = $1 group by status', [conn.id]) : []
        const subscriptions = conn ? await db.query<{ provider: string; plan_key: string; status: string; is_test: boolean }>('select provider, plan_key, status, is_test from app_subscriptions where connection_id = $1 order by created_at desc', [conn.id]) : []
        const audit = conn ? await db.query<{ event: string; actor: string; at: string }>('select event, actor, at from engine_audit where connection_id = $1 order by at desc limit 25', [conn.id]) : []
        return { credentials, access, agents, receipts, executions, subscriptions, audit }
      })
      return NextResponse.json({ ok: true, connection: conn, ...data })
    }
    if (!conn) return NextResponse.json({ ok: false, error: 'not_installed', message: `no connection for ${shop}; install the app first` }, { status: 409 })
    const actor = actorFor(conn.org_id, shop)
    switch (action) {
      case 'products': {
        const row = await admin(db => loadConnection(db, conn.id))
        if (!row) throw new Error('connection not loadable')
        const connector = getConnector('shopify')
        const out: { product: string; variant: string; sku: string | null; available: number | null; policy: string; status: string }[] = []
        for await (const page of connector.listResources(row)) for (const r of page as ShopifyVariantRecord[]) out.push({ product: r.productTitle, variant: r.variantTitle, sku: r.sku, available: r.totalAvailable, policy: r.inventoryPolicy, status: r.productStatus })
        const products = new Set(out.map(o => o.product))
        return NextResponse.json({ ok: true, products: products.size, variants: out.length, lowStock: out.filter(o => o.available !== null && o.available < 5).length, sample: out.slice(0, 40) })
      }
      case 'scan': return NextResponse.json({ ok: true, ...(await runScan(conn.id, { trigger: 'manual', actor: actor.label })) })
      case 'agents': return NextResponse.json({ ok: true, agents: await listAgents(actor, conn.id) })
      case 'agent': return NextResponse.json({ ok: true, ...(await agentDetail(actor, String(body.agentId ?? ''))) })
      case 'template': {
        const t = templateByKey(String(body.template ?? ''))
        if (!t) return NextResponse.json({ ok: false, error: 'unknown template' }, { status: 400 })
        const tz = await admin(db => db.one<{ timezone: string | null }>('select timezone from store_connections where id = $1', [conn.id]))
        const policy = templatePolicy(t.key, { connectionId: conn.id, timezone: tz?.timezone || 'UTC', notify: typeof body.notify === 'string' ? body.notify : null, supplierAddress: typeof body.supplierAddress === 'string' ? body.supplierAddress : null })
        const c = await createAgent(actor, { name: typeof body.name === 'string' && body.name ? body.name : t.name, taskText: t.job, policy, mailbox: t.mailbox && Boolean(policy.email), templateKey: t.key })
        const g = body.grant === false ? null : await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
        return NextResponse.json({ ok: true, ...c, granted: g })
      }
      case 'grant': {
        const d = await agentDetail(actor, String(body.agentId ?? ''))
        const pending = (d.policies as unknown as { id: string; status: string; policy_hash: string; version: number }[]).find(p => p.status === 'pending_grant')
        if (!pending) return NextResponse.json({ ok: false, error: 'nothing pending' }, { status: 409 })
        return NextResponse.json({ ok: true, ...(await grantPolicy(actor, String(body.agentId), pending.id, pending.policy_hash)) })
      }
      case 'widen': {
        const d = await agentDetail(actor, String(body.agentId ?? ''))
        const active = (d.policies as unknown as { status: string; policy: Record<string, unknown> }[]).find(p => p.status === 'active')
        if (!active) return NextResponse.json({ ok: false, error: 'no active version' }, { status: 409 })
        return NextResponse.json({ ok: true, ...(await editAgent(actor, String(body.agentId), { policy: { ...active.policy, approvalMode: String(body.approvalMode ?? 'review') } })) })
      }
      case 'run': return NextResponse.json({ ok: true, ...(await runAgent(String(body.agentId ?? ''), { trigger: 'manual', actor: actor.label })) })
      case 'task': {
        const t = await assignTask(actor, String(body.agentId ?? ''), String(body.text ?? ''))
        return NextResponse.json({ ok: true, task: t.status === 'queued' ? await runTask(t.id, { actor: actor.label }) : t })
      }
      case 'approve': return NextResponse.json({ ok: true, ...(await approveAndExecute(actor, String(body.proposalId ?? ''), String(body.changeHash ?? ''))) })
      case 'mail': return NextResponse.json({ ok: true, messages: await listMessages(actor, { agentId: typeof body.agentId === 'string' ? body.agentId : null }) })
      case 'scopes-sync': {
        const row = await admin(db => loadConnection(db, conn.id))
        if (!row) throw new Error('connection not loadable')
        return NextResponse.json({ ok: true, ...(await admin(db => syncScopes(db, row, actor.label))) })
      }
      case 'weekly': {
        const facts = await admin(db => weeklyFacts(db, conn.org_id, weekStartOf(new Date())))
        const sent = body.send === true ? await sendWeeklySummary(conn.org_id, { actor: actor.label }) : null
        return NextResponse.json({ ok: true, facts, sent })
      }
      case 'billing-test': {
        // a TEST charge (test: true): never bills anyone; the merchant approves it on Shopify's own confirmation page
        const row = await admin(db => loadConnection(db, conn.id))
        if (!row) throw new Error('connection not loadable')
        const returnUrl = `${shopifyConfig.appUrl}/shopify?billing=returned`
        const variables = { name: String(body.name ?? 'Deploi dev-store test plan'), returnUrl, test: true, trialDays: 0, lineItems: [{ plan: { appRecurringPricingDetails: { price: { amount: Number(body.amount ?? 1), currencyCode: String(body.currency ?? 'USD') }, interval: 'EVERY_30_DAYS' } } }] }
        const data = await shopifyGraphql<{ appSubscriptionCreate: { appSubscription: { id: string; status: string } | null; confirmationUrl: string | null; userErrors: { field: string[] | null; message: string }[] } }>(row, { query: M_CREATE_SUBSCRIPTION, operationName: 'DeploiCreateSubscription', variables }, { mutation: true })
        const r = data.appSubscriptionCreate
        if (r.appSubscription) await admin(db => recordSubscription(db, { orgId: conn.org_id, connectionId: conn.id, externalId: r.appSubscription!.id, planKey: 'dev_test', status: r.appSubscription!.status, isTest: true, actor: actor.label }))
        return NextResponse.json({ ok: true, subscription: r.appSubscription, confirmationUrl: r.confirmationUrl, userErrors: r.userErrors })
      }
      case 'billing-status': {
        const row = await admin(db => loadConnection(db, conn.id))
        if (!row) throw new Error('connection not loadable')
        const data = await shopifyGraphql<{ currentAppInstallation: { activeSubscriptions: { id: string; name: string; status: string; test: boolean; currentPeriodEnd: string | null }[] } }>(row, { query: Q_ACTIVE_SUBSCRIPTIONS, operationName: 'DeploiActiveSubscriptions' })
        for (const s of data.currentAppInstallation.activeSubscriptions) await admin(db => recordSubscription(db, { orgId: conn.org_id, connectionId: conn.id, externalId: s.id, planKey: 'dev_test', status: s.status, isTest: s.test, currentPeriodEnd: s.currentPeriodEnd, actor: actor.label }))
        const rows = await admin(db => db.query<{ provider: string; plan_key: string; status: string; is_test: boolean; external_id: string | null }>('select provider, plan_key, status, is_test, external_id from app_subscriptions where connection_id = $1 order by created_at desc', [conn.id]))
        return NextResponse.json({ ok: true, shopify: data.currentAppInstallation.activeSubscriptions, deploi: rows })
      }
      case 'issues': {
        const rows = await withActor(actor, db => db.query<{ id: string; check_key: string; kind: string; status: string; resource_label: string; severity: string }>('select id, check_key, kind, status, resource_label, severity from issues where connection_id = $1 order by first_detected_at desc limit 50', [conn.id]))
        const proposals = await withActor(actor, db => db.query<{ id: string; status: string; target_label: string; change: unknown; change_hash: string; agent_id: string | null }>('select id, status, target_label, change, change_hash, agent_id from proposals where connection_id = $1 order by created_at desc limit 50', [conn.id]))
        return NextResponse.json({ ok: true, issues: rows, proposals })
      }
      default: return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const err = e as Error & { code?: string }
    log.error('devstore.harness.failed', { action, error: err.message })
    return NextResponse.json({ ok: false, error: err.code ?? 'failed', message: err.message }, { status: 500 })
  }
}
