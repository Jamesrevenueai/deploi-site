import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { listRules } from '@/lib/engine/queries'
import { updateRule, ensureRules } from '@/lib/engine/rules'
import { assertMerchant, withActor } from '@/lib/engine/actor'
import { loadConnection, runScan } from '@/lib/engine/scan'

export const maxDuration = 300

async function connectionFor(actor: Awaited<ReturnType<typeof resolveActor>>, id: string | null) {
  const conns = await withActor(actor, db => db.query<{ id: string; org_id: string }>(`select id, org_id from store_connections where ${actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'} order by created_at`))
  const c = id ? conns.find(x => x.id === id) : conns.length === 1 ? conns[0] : null
  if (!c) throw new HttpError(404, 'not_found', 'connection not found')
  return c
}

/** Rules for one connection, with each check's plain-language explanation. ?connection=<id> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const c = await connectionFor(actor, new URL(req.url).searchParams.get('connection'))
    await admin(async db => { const conn = await loadConnection(db, c.id); if (conn) await ensureRules(db, conn) })
    return NextResponse.json({ ok: true, connectionId: c.id, rules: await listRules(actor, c.id) })
  } catch (e) { return errorResponse(e) }
}

/** Change a rule. Body: { connectionId?, checkKey, enabled?, config? }. Bumps the rule version and rescans. */
export async function PUT(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const c = await connectionFor(actor, typeof body.connectionId === 'string' ? body.connectionId : null)
    assertMerchant(actor, c.org_id)
    const rule = await admin(db => updateRule(db, { connectionId: c.id, checkKey: String(body.checkKey ?? ''), enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, config: body.config, actor: actor.label }))
    const scan = await runScan(c.id, { trigger: 'manual', actor: actor.label }).catch(e => ({ error: (e as Error).message }))
    return NextResponse.json({ ok: true, rule, scan })
  } catch (e) { return errorResponse(e) }
}
