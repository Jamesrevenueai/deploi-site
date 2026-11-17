import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { discoverNow, discoverView, requestDiscovery } from '@/lib/discovery'
import { EngineError } from '@/lib/engine/errors'
import '@/lib/discovery/jobs'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** The latest discovery run, the business profile, what was found (as cases) and the recommended AI team. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await discoverView(actor)) })
  } catch (e) { return errorResponse(e) }
}

/**
 * Start a discovery run for the signed-in organization. Body {} runs it now and answers with the result;
 * { wait: false } queues it as a job (`discovery.run`) and answers at once.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new EngineError('forbidden', "Deploi staff cannot run discovery for a customer")
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (body.wait === false) {
      const job = await requestDiscovery(actor.orgId, 'owner', { trigger: 'manual' })
      return NextResponse.json({ ok: true, queued: Boolean(job?.id), job }, { status: 202 })
    }
    const { run, started } = await discoverNow(actor)
    return NextResponse.json({ ok: true, started, runId: run.id, status: run.status, view: await discoverView(actor) })
  } catch (e) { return errorResponse(e) }
}
