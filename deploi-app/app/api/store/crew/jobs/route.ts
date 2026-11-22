import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { addJobAsOwner, cancelJobAsOwner, crewJobsFor, markDoneAsOwner, sendTodayAsOwner } from '@/lib/notify/crew'

export const dynamic = 'force-dynamic'

/** One day's crew jobs (?date=YYYY-MM-DD, default today). Every member of the organization may look. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await crewJobsFor(actor, new URL(req.url).searchParams.get('date'))) })
  } catch (e) { return errorResponse(e) }
}

/**
 * { action: 'add_job', jobRef, crewMemberId, date, address, details, photos } | { action: 'cancel', jobId }
 * | { action: 'mark_done', jobId } | { action: 'send', crewMemberId } (send that person today's jobs now).
 * Owners and admins only (checked on the server).
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    switch (body.action) {
      case 'add_job': return NextResponse.json({ ok: true, job: await addJobAsOwner(actor, body) })
      case 'cancel': return NextResponse.json({ ok: true, ...(await cancelJobAsOwner(actor, jobId)) })
      case 'mark_done': { const r = await markDoneAsOwner(actor, jobId); return NextResponse.json({ ok: true, job: r.job }) }
      case 'send': return NextResponse.json({ ok: true, result: await sendTodayAsOwner(actor, typeof body.crewMemberId === 'string' ? body.crewMemberId : '') })
      default: throw new HttpError(400, 'invalid_input', 'action must be add_job, cancel, mark_done or send')
    }
  } catch (e) { return errorResponse(e) }
}
