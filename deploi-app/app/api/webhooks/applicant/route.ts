/** Inbound applicant (job board / form webhook). Bearer APPLICANT_WEBHOOK_SECRET when set. */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'

const Applicant = z.object({
  agency_id: z.string().uuid(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  source: z.string().trim().max(40).optional().default('webhook'),
})

export async function POST(req: Request) {
  const secret = process.env.APPLICANT_WEBHOOK_SECRET?.trim()
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ ok: false }, { status: 401 })
  const parsed = Applicant.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid applicant' }, { status: 400 })
  const a = parsed.data
  const id = await admin(db => db.one<{ id: string }>(
    `insert into applicants (agency_id, first_name, last_name, phone, email, source, status) values ($1,$2,$3,$4,$5,$6,'new') returning id`,
    [a.agency_id, a.first_name, a.last_name, a.phone ?? null, a.email ?? null, a.source]))
  log.info('applicant.inbound', { applicant_id: id?.id, agency_id: a.agency_id })
  return NextResponse.json({ ok: true, id: id?.id })
}
