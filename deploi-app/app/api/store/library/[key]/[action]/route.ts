import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { grantAutoRun, revokeAutoRun, setInstructions, setPermission, setSettings, setSwitch } from '@/lib/library/switches'
import { runLibraryAgent } from '@/lib/library/actions'
import { chat } from '@/lib/library/chat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * switch { enabled, settings? }   on or off (tier-gated; a locked agent answers 402 upgrade_required)
 * run                              run now (only when switched on)
 * chat { text, via? }              text or voice (transcribed in the browser) message; returns both messages
 * permission { level }             read | draft | act (lowering below act revokes every auto-run grant)
 * instructions { text }            standing instructions the runner reads on every run
 * settings { ...patch }            per-agent settings (supplier address, thresholds)
 * grant { actionType, maxPerDay }  auto-run for one action type (needs "act"; never for money or publishing actions)
 * revoke { actionType }
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { key, action } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff can view but not change a merchant team')
    switch (action) {
      case 'switch': return NextResponse.json({ ok: true, ...(await setSwitch(actor, key, body.enabled === true, { settings: body.settings && typeof body.settings === 'object' ? body.settings as Record<string, unknown> : undefined })) })
      case 'run': return NextResponse.json({ ok: true, ...(await runLibraryAgent({ orgId: actor.orgId, agentKey: key, trigger: 'manual', actor: actor.label })) })
      case 'chat': return NextResponse.json({ ok: true, ...(await chat(actor, key, String(body.text ?? ''), body.via === 'voice' ? 'voice' : 'text')) })
      case 'permission': return NextResponse.json({ ok: true, ...(await setPermission(actor, key, body.level)) })
      case 'instructions': return NextResponse.json({ ok: true, ...(await setInstructions(actor, key, String(body.text ?? ''))) })
      case 'settings': return NextResponse.json({ ok: true, ...(await setSettings(actor, key, body.patch && typeof body.patch === 'object' ? body.patch as Record<string, unknown> : {})) })
      case 'grant': return NextResponse.json({ ok: true, ...(await grantAutoRun(actor, key, String(body.actionType ?? ''), typeof body.maxPerDay === 'number' ? body.maxPerDay : 20)) })
      case 'revoke': return NextResponse.json({ ok: true, ...(await revokeAutoRun(actor, key, String(body.actionType ?? ''))) })
      default: throw new HttpError(404, 'not_found', 'unknown action')
    }
  } catch (e) { return errorResponse(e) }
}
