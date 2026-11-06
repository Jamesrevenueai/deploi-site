import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { assertNotEmbedded } from '@/lib/store/embedded-gate'
import { deleteCustomAgent, updateCustomAgent } from '@/lib/library/custom'

export const dynamic = 'force-dynamic'

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    assertNotEmbedded(actor) // build your own is not offered inside Shopify
    const { id } = await ctx.params
    const body = await readJson(req)
    return NextResponse.json({ ok: true, agent: await updateCustomAgent(actor, id, { enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, permission: body.permission, job: typeof body.job === 'string' ? body.job : undefined, name: typeof body.name === 'string' ? body.name : undefined }) })
  } catch (e) { return errorResponse(e) }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    assertNotEmbedded(actor) // build your own is not offered inside Shopify
    const { id } = await ctx.params
    await deleteCustomAgent(actor, id)
    return NextResponse.json({ ok: true })
  } catch (e) { return errorResponse(e) }
}
