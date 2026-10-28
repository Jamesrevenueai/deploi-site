/**
 * Demo controls for SYNTHETIC stores only (never a real merchant): reset the catalogue, make an
 * outside change (as the merchant or another app would), or inject a platform fault. Disabled in
 * production unless DEMO_CONTROLS=true.
 */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { audit } from '@/lib/engine/audit'
import { setSyntheticState, mutateSynthetic, injectFault, type SynthFault } from '@/lib/connectors/shopify/synthetic'
import { northwindState, harborState, NORTHWIND_DOMAIN } from '@/lib/connectors/shopify/demo-store'

export async function POST(req: Request) {
  try {
    if (env.isProd && process.env.DEMO_CONTROLS !== 'true') throw new HttpError(404, 'not_found', 'not available')
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const conn = await withActor(actor, db => db.one<{ id: string; org_id: string; external_id: string; is_synthetic: boolean }>(
      `select id, org_id, external_id, is_synthetic from store_connections where id = $1`, [String(body.connectionId ?? '')]))
    if (!conn) throw new HttpError(404, 'not_found', 'connection not found')
    if (!conn.is_synthetic) throw new HttpError(403, 'not_synthetic', 'demo controls only work on synthetic stores')
    const action = String(body.action ?? '')
    if (action === 'reset') {
      await setSyntheticState(conn.id, conn.external_id === NORTHWIND_DOMAIN ? northwindState() : harborState())
    } else if (action === 'external_change') {
      const variantId = String(body.variantId ?? '')
      await mutateSynthetic(conn.id, s => {
        const p = s.products.find(x => x.variants.some(v => v.id === variantId))
        const v = p?.variants.find(x => x.id === variantId)
        if (!p || !v) throw new HttpError(404, 'not_found', 'variant not found')
        if (body.inventoryPolicy === 'CONTINUE' || body.inventoryPolicy === 'DENY') v.inventoryPolicy = body.inventoryPolicy
        if (Array.isArray(body.tags)) p.tags = body.tags.map(String)
        if (typeof body.available === 'number' && v.levels[0]) { v.levels[0].available = body.available; v.levels[0].onHand = Math.max(body.available, 0); v.levels[0].committed = body.available < 0 ? -body.available : 0 }
        if (body.status === 'ACTIVE' || body.status === 'DRAFT' || body.status === 'ARCHIVED') p.status = body.status
        p.updatedAt = new Date().toISOString()
      })
    } else if (action === 'fault') {
      const modes: SynthFault['mode'][] = ['user_error', 'lost_response_applied', 'lost_response_not_applied', 'write_does_not_stick', 'read_error', 'throttle_once']
      const mode = modes.find(m => m === body.mode)
      if (!mode) throw new HttpError(400, 'invalid_input', 'unknown fault mode')
      await injectFault(conn.id, { op: String(body.op ?? 'DeploiSetInventoryPolicy'), mode })
    } else throw new HttpError(400, 'invalid_input', 'unknown action')
    await admin(db => audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: `demo.${action}`, actor: actor.label, detail: { synthetic: true } }))
    return NextResponse.json({ ok: true })
  } catch (e) { return errorResponse(e) }
}
