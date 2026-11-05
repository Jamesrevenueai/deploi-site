import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { customerView, integrationStatuses } from '@/lib/integrations/registry'

export const dynamic = 'force-dynamic'

/** Every integration with its status, what it is used for, its permissions and scopes. Never an environment variable name. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'staff_read_only', 'staff see every organization at /staff/integrations')
    return NextResponse.json({ ok: true, integrations: (await integrationStatuses(actor.orgId)).map(customerView) })
  } catch (e) { return errorResponse(e) }
}
