import { NextResponse } from 'next/server'
import { resolveActor, HttpError, limitActor, readJson } from '@/lib/store/request'
import { officeError } from '@/lib/office/request'
import { env } from '@/lib/env'
import { connectIntegration, customerView, disconnectIntegration, integrationDef, reconnectIntegration, testIntegration, statusOf } from '@/lib/integrations/registry'
import { diagnostics } from '@/lib/integrations/diagnostics'
import { reregisterWebhooks } from '@/lib/integrations/webhooks'
import { breakSyntheticConnection } from '@/lib/integrations/demo'
import { isIntegrationKey, type IntegrationKey } from '@/lib/integrations/types'
import { admin } from '@/lib/db'

export const dynamic = 'force-dynamic'

const keyOf = async (params: Promise<{ key: string }>): Promise<IntegrationKey> => {
  const { key } = await params
  if (!isIntegrationKey(key)) throw new HttpError(404, 'not_found', 'unknown integration')
  return key
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const connId = (v: unknown) => { if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, 'invalid_input', 'connectionId is required'); return v }

/** The "Advanced" diagnostics of one integration for the signed-in customer's organization. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'staff_read_only', 'staff see every organization at /staff/integrations')
    const key = await keyOf(ctx.params)
    const [view, diag] = await Promise.all([admin(db => statusOf(db, integrationDef(key), actor.orgId)), diagnostics(actor.orgId, key, { live: new URL(req.url).searchParams.get('live') !== '0' })])
    return NextResponse.json({ ok: true, integration: customerView(view), diagnostics: diag })
  } catch (e) { return officeError(e) }
}

/**
 * Body { op: 'test' }                              read-only probe of every connection (recorded in the health history)
 *      { op: 'connect', synthetic? }               the existing connect flow ({ kind: 'link' | 'redirect' | 'done' })
 *      { op: 'reconnect', connectionId }           reconnect in place (same id); provider consent URL, or done for synthetic
 *      { op: 'disconnect', connectionId }
 *      { op: 'webhooks', connectionId }            re-register webhooks (Shopify, WooCommerce)
 *      { op: 'demo_break', connectionId }          synthetic Office connections only; off in production unless DEMO_CONTROLS=true
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'staff_read_only', 'Deploi staff can view integrations but not change them for a customer')
    const key = await keyOf(ctx.params)
    const body = await readJson(req)
    const op = String(body.op ?? '')
    if (op === 'test') return NextResponse.json({ ok: true, ...(await testIntegration(actor.orgId, key)) })
    if (op === 'connect') {
      if (!body.synthetic) await limitActor('oauth_start', actor)
      return NextResponse.json({ ok: true, result: await connectIntegration(actor, key, { synthetic: body.synthetic === true }) })
    }
    if (op === 'reconnect') {
      await limitActor('oauth_start', actor)
      return NextResponse.json({ ok: true, result: await reconnectIntegration(actor, key, connId(body.connectionId)) })
    }
    if (op === 'disconnect') return NextResponse.json({ ok: true, ...(await disconnectIntegration(actor, key, connId(body.connectionId))) })
    if (op === 'webhooks') return NextResponse.json({ ok: true, ...(await reregisterWebhooks(actor, key, connId(body.connectionId))) })
    if (op === 'demo_break') {
      if (env.isProd && process.env.DEMO_CONTROLS !== 'true') throw new HttpError(404, 'not_found', 'not available')
      return NextResponse.json({ ok: true, ...(await breakSyntheticConnection(actor, key, connId(body.connectionId))) })
    }
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return officeError(e) }
}
