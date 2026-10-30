/**
 * Early access applications from getdeploi.com. Inserts through a SECURITY DEFINER function as the
 * anon role; the anon role has no table access. CORS is restricted to the marketing site origins.
 * Unknown fields are ignored. Password-like segments in free text are replaced by "[removed]" and
 * counted in a warning log; no password is ever stored.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { anon } from '@/lib/db'
import { log } from '@/lib/log'
import { stripSecretsFrom } from '@/lib/leads/sanitize'

const Lead = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  /** the store or company name */
  store_name: z.string().trim().max(200).optional(),
  /** the same field under its old name, sent by website builds from before the rename */
  agency_name: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional().nullable(),
  source: z.literal('site').optional().default('site'),
  service_interest: z.literal('early_access').optional().default('early_access'),
  store_url: z.string().trim().max(500).regex(/^https?:\/\/[^\s/]+\.[^\s]+$/i),
  platforms: z.array(z.enum(['shopify', 'woocommerce', 'amazon'])).min(1).max(3),
  catalog_size: z.enum(['under_100', '100_1000', '1000_10000', 'over_10000']).optional().nullable(),
  /** honeypot */
  website: z.string().optional(),
  /** time-trap: how long the form was open (ms); absent from older clients */
  elapsed_ms: z.number().int().min(0).max(864e5).optional(),
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
  // bots: the honeypot was filled, or the form was submitted faster than a person can type (answer as if accepted)
  if (lead.website || (lead.elapsed_ms !== undefined && lead.elapsed_ms < 2500)) { log.warn('lead.bot_dropped', { source: lead.source, reason: lead.website ? 'honeypot' : 'too_fast' }); return NextResponse.json({ ok: true, id: null }, { headers }) }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const { fields, removed } = stripSecretsFrom({ message: lead.message })
  if (removed) log.warn('lead.secret_segments_removed', { source: lead.source, count: removed })
  try {
    const id = await anon(db => db.one<{ id: string }>('select public_create_early_access($1,$2,$3,$4,$5::text[],$6,$7) as id',
      [lead.name, lead.email, lead.store_name ?? lead.agency_name ?? '', lead.store_url, lead.platforms, lead.catalog_size ?? null, fields.message]), { ip })
    log.info('lead.created', { source: lead.source, id: id?.id, service_interest: 'early_access', platforms: lead.platforms.length })
    return NextResponse.json({ ok: true, id: id?.id ?? null }, { headers })
  } catch (e) {
    log.error('lead.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'could not save application' }, { status: 500, headers })
  }
}
