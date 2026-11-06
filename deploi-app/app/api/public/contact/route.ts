/**
 * The website contact form (getdeploi.com/contact). Limited per client IP (bucket `contact`), every attempt
 * counted, before anything is parsed. CORS is restricted to the marketing site origins, like the early-access
 * endpoint. The message is stored in contact_messages (staff read only) and staff are told through the system
 * mailer. Password-like segments are removed from the message; bots (honeypot, too fast) are answered as if
 * accepted and dropped.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { stripSecretsFrom } from '@/lib/leads/sanitize'
import { clientIp, hitByIp, tooManyRequests } from '@/lib/security/rate-limit'
import { sendSystemEmail, supportInbox } from '@/lib/email/system'

const Contact = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  company: z.string().trim().max(200).optional().nullable(),
  topic: z.enum(['sales', 'support', 'partnership', 'press', 'other']).optional().default('other'),
  message: z.string().trim().min(1).max(4000),
  /** honeypot */
  website: z.string().optional(),
  elapsed_ms: z.number().int().min(0).max(864e5).optional(),
})

function corsHeaders(origin: string | null) {
  const allowed = env.allowedOrigins
  const ok = origin && (allowed.includes(origin) || origin === env.siteUrl || (!env.isProd && /^http:\/\/localhost(:\d+)?$/.test(origin)))
  return { 'access-control-allow-origin': ok ? origin : allowed[0] ?? env.siteUrl, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' }
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function POST(req: Request) {
  const headers = corsHeaders(req.headers.get('origin'))
  const limited = await hitByIp('contact', req)
  if (!limited.allowed) return tooManyRequests(limited, headers)
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400, headers }) }
  const parsed = Contact.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid message', issues: parsed.error.issues.map(i => i.path.join('.')) }, { status: 400, headers })
  const c = parsed.data
  if (c.website || (c.elapsed_ms !== undefined && c.elapsed_ms < 2500)) { log.warn('contact.bot_dropped', { reason: c.website ? 'honeypot' : 'too_fast' }); return NextResponse.json({ ok: true, id: null }, { headers }) }
  const { fields, removed } = stripSecretsFrom({ message: c.message })
  if (removed) log.warn('contact.secret_segments_removed', { count: removed })
  const message = String(fields.message ?? '')
  try {
    const row = await admin(db => db.one<{ id: string }>(`insert into contact_messages (name, email, company, topic, message, ip) values ($1,$2,$3,$4,$5,$6) returning id`,
      [c.name, c.email.toLowerCase(), c.company || null, c.topic, message, clientIp(req.headers)]))
    await sendSystemEmail({ key: `contact:${row!.id}`, template: 'contact_staff', to: supportInbox(), related: { contact_id: row!.id },
      params: { name: c.name, email: c.email, company: c.company ?? '', topic: c.topic, message }, replyTo: c.email })
    log.info('contact.created', { id: row!.id, topic: c.topic })
    return NextResponse.json({ ok: true, id: row!.id }, { headers })
  } catch (e) {
    log.error('contact.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'could not save the message' }, { status: 500, headers })
  }
}
