import { NextResponse } from 'next/server'
import { HttpError, readJson } from '@/lib/store/request'
import { officeActor, officeError } from '@/lib/office/request'
import { approveOfficeAction, editOfficeAction, rejectOfficeAction } from '@/lib/office/approvals'

export const dynamic = 'force-dynamic'

/**
 * Body { op: 'approve', shownHash }  approve the exact item shown and carry it out
 *      { op: 'reject' }
 *      { op: 'edit', shownHash, subject?, body?, summary?, description? }  any change clears an earlier approval
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await officeActor(req, { mutating: true })
    const { id } = await ctx.params
    const b = await readJson(req)
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    if (b.op === 'approve') return NextResponse.json({ ok: true, ...(await approveOfficeAction(actor, id, String(b.shownHash ?? ''))) })
    if (b.op === 'reject') return NextResponse.json({ ok: true, ...(await rejectOfficeAction(actor, id)) })
    if (b.op === 'edit') return NextResponse.json({ ok: true, ...(await editOfficeAction(actor, id, { shownHash: String(b.shownHash ?? ''), subject: str(b.subject), body: str(b.body), summary: str(b.summary), description: str(b.description) })) })
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return officeError(e) }
}
