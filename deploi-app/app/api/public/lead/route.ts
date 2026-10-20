/**
 * Public lead intake for getdeploi.com (book-a-call form, /evv early access, chat bubble).
 * Inserts through a SECURITY DEFINER function as the anon role; the anon role has
 * no table access. CORS is restricted to the marketing site origins.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { anon } from '@/lib/db'
import { log } from '@/lib/log'

const Lead = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  agency_name: z.string().trim().max(200).optional().default(''),
  phone: z.string().trim().max(40).optional().nullable(),
  message: z.string().trim().max(4000).optional().nullable(),
  source: z.enum(['site', 'evv-page', 'chat']),
  city: z.string().trim().max(120).optional().nullable(),
  county: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(2).optional().nullable(),
  /** honeypot */
  website: z.string().optional(),
})

function corsHeaders(origin: string | null) {
  const allowed = env.allowedOrigins
  const ok = origin && (allowed.includes(origin) || origin === env.siteUrl || (!env.isProd && /^http:\/\/localhost(:\d+)?$/.test(origin)))
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] ?? env.siteUrl,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: Request) {
  const headers = corsHeaders(req.headers.get('origin'))
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400, headers }) }
  const parsed = Lead.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid lead', issues: parsed.error.issues.map(i => i.path.join('.')) }, { status: 400, headers })
  const lead = parsed.data
  if (lead.website) return NextResponse.json({ ok: true, id: null }, { headers }) // bot
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  try {
    const id = await anon(db => db.one<{ id: string }>(
      'select public_create_lead($1,$2,$3,$4,$5,$6,$7,$8,$9) as id',
      [lead.name, lead.email, lead.agency_name, lead.phone ?? null, lead.message ?? null, lead.source, lead.city ?? null, lead.county ?? null, lead.state ?? 'OH']), { ip })
    log.info('lead.created', { source: lead.source, id: id?.id })
    return NextResponse.json({ ok: true, id: id?.id ?? null }, { headers })
  } catch (e) {
    log.error('lead.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'could not save lead' }, { status: 500, headers })
  }
}
