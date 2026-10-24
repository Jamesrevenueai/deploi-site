/**
 * Public lead intake for getdeploi.com (book-a-call form, /evv early access, chat bubble).
 * Inserts through a SECURITY DEFINER function as the anon role; the anon role has
 * no table access. CORS is restricted to the marketing site origins.
 *
 * Phase 16: optional Website Improvement fields (see docs/CONTRIBUTING-STREAMS.md, "Lead API").
 * Unknown fields are ignored. Password-like segments in free text are replaced by "[removed]"
 * and counted in a warning log; no password is ever stored.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { anon } from '@/lib/db'
import { log } from '@/lib/log'
import { stripSecretsFrom } from '@/lib/website/sanitize'
import { websitePriceCents } from '@/lib/website/states'

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
  // ---- Website Improvement (optional; contract in docs/CONTRIBUTING-STREAMS.md)
  service_interest: z.enum(['operations', 'website_improvement']).optional().default('operations'),
  website_url: z.string().trim().max(500).optional().nullable(),
  website_platform: z.string().trim().max(120).optional().nullable(),
  website_goal: z.string().trim().max(1000).optional().nullable(),
  website_pages: z.array(z.string().trim().max(300)).max(3).optional().default([]),
  website_changes: z.string().trim().max(4000).optional().nullable(),
  website_issues: z.string().trim().max(4000).optional().nullable(),
  access_status: z.enum(['have_login', 'need_to_find', 'agency_managed', 'unknown']).optional().default('unknown'),
  approval_contact: z.string().trim().max(200).optional().nullable(),
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
  const { fields, removed } = stripSecretsFrom({ message: lead.message, website_changes: lead.website_changes, website_issues: lead.website_issues, website_goal: lead.website_goal })
  if (removed) log.warn('lead.secret_segments_removed', { source: lead.source, count: removed })
  const isWebsite = lead.service_interest === 'website_improvement'
  try {
    const id = await anon(db => db.one<{ id: string }>(
      'select public_create_lead_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19) as id',
      [lead.name, lead.email, lead.agency_name, lead.phone ?? null, fields.message, lead.source, lead.city ?? null, lead.county ?? null, lead.state ?? 'OH',
        lead.service_interest, isWebsite ? lead.website_url ?? null : null, isWebsite ? lead.website_platform ?? null : null, isWebsite ? fields.website_goal : null,
        JSON.stringify(isWebsite ? lead.website_pages : []), isWebsite ? fields.website_changes : null, isWebsite ? fields.website_issues : null,
        lead.access_status, isWebsite ? lead.approval_contact ?? null : null, websitePriceCents()]), { ip })
    log.info('lead.created', { source: lead.source, id: id?.id, service_interest: lead.service_interest })
    return NextResponse.json({ ok: true, id: id?.id ?? null }, { headers })
  } catch (e) {
    log.error('lead.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'could not save lead' }, { status: 500, headers })
  }
}
