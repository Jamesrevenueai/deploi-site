/**
 * Office sign-up from getdeploi.com (service businesses: HVAC, construction, landscaping, property managers, real
 * estate and leasing agents). 404 unless OFFICE_SIGNUP=on. Same protections as /api/public/lead: CORS limited to the
 * marketing site, per-IP limit (bucket `lead`), honeypot and time-trap, password-like text removed. Inserts through the
 * SECURITY DEFINER function public_create_office_signup as the anon role (migration 065); staff invite the business,
 * and its onboarding (/start) sets the business type, connects its tools and switches on its agents.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { anon } from '@/lib/db'
import { log } from '@/lib/log'
import { stripSecretsFrom } from '@/lib/leads/sanitize'
import { clientIp, hitByIp, tooManyRequests } from '@/lib/security/rate-limit'

const OFFICE_BUSINESS_TYPES = ['home_services', 'property_manager', 'real_estate_agent', 'leasing_agent', 'office'] as const
const OFFICE_TOOLS = ['outlook', 'google', 'quickbooks', 'hubspot', 'salesforce', 'pipedrive', 'zoho', 'buildium', 'other'] as const

const Signup = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  company: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  business_type: z.enum(OFFICE_BUSINESS_TYPES),
  trade: z.enum(['construction', 'hvac', 'roofing', 'landscaping', 'cleaning', 'general']).optional().nullable(),
  tools: z.array(z.enum(OFFICE_TOOLS)).max(9).optional().default([]),
  website_url: z.string().trim().max(500).optional().nullable(),
  message: z.string().trim().max(4000).optional().nullable(),
  /** honeypot */
  website: z.string().optional(),
  elapsed_ms: z.number().int().min(0).max(864e5).optional(),
})

const officeSignupOn = (e: Record<string, string | undefined> = process.env) => (e.OFFICE_SIGNUP ?? '').trim().toLowerCase() === 'on'

function corsHeaders(origin: string | null) {
  const allowed = env.allowedOrigins
  const ok = origin && (allowed.includes(origin) || origin === env.siteUrl || (!env.isProd && /^http:\/\/localhost(:\d+)?$/.test(origin)))
  return { 'access-control-allow-origin': ok ? origin : allowed[0] ?? env.siteUrl, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: officeSignupOn() ? 204 : 404, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: Request) {
  const headers = corsHeaders(req.headers.get('origin'))
  if (!officeSignupOn()) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404, headers })
  const limited = await hitByIp('lead', req)
  if (!limited.allowed) return tooManyRequests(limited, headers)
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400, headers }) }
  const parsed = Signup.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid sign-up', issues: parsed.error.issues.map(i => i.path.join('.')) }, { status: 400, headers })
  const s = parsed.data
  if (s.website || (s.elapsed_ms !== undefined && s.elapsed_ms < 2500)) { log.warn('office_signup.bot_dropped', { reason: s.website ? 'honeypot' : 'too_fast' }); return NextResponse.json({ ok: true, id: null }, { headers }) }
  const { fields, removed } = stripSecretsFrom({ message: s.message })
  if (removed) log.warn('office_signup.secret_segments_removed', { count: removed })
  try {
    const id = await anon(db => db.one<{ id: string }>('select public_create_office_signup($1,$2,$3,$4,$5,$6,$7::text[],$8,$9) as id',
      [s.name, s.email, s.company, s.phone ?? null, s.business_type, s.business_type === 'home_services' ? (s.trade ?? 'general') : null, s.tools, s.website_url ?? null, fields.message]), { ip: clientIp(req.headers) })
    log.info('office_signup.created', { id: id?.id, business_type: s.business_type, tools: s.tools.length })
    return NextResponse.json({ ok: true, id: id?.id ?? null }, { headers })
  } catch (e) {
    log.error('office_signup.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'could not save the sign-up' }, { status: 500, headers })
  }
}
