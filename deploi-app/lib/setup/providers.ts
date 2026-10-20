/**
 * Live lookups for the readiness page. Every function resolves; nothing here throws.
 * Keys are read from env and never logged or returned.
 */
import { env } from '../env'
import { sendEmail } from '../adapters/email'
import { parseTwilioCampaignStatus, parseSupabasePlan, supabaseRef } from './readiness'

const e = (k: string) => (process.env[k] ?? '').trim()

export async function resendTestSend(to: string) {
  try {
    const r = await sendEmail({ to, subject: 'Deploi AI setup test', text: 'This is a test send from /staff/setup.' })
    return { ok: r.ok, mocked: r.mocked, error: r.error }
  } catch (err) {
    return { ok: false, mocked: false, error: (err as Error).message }
  }
}

export async function twilioCampaignStatus(): Promise<{ status: string | null; error: string | null }> {
  const { sid, token } = env.twilio
  const service = e('TWILIO_MESSAGING_SERVICE_SID')
  if (!sid || !token || !service) return { status: null, error: null }
  try {
    const res = await fetch(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(service)}/Compliance/Usa2p`, {
      headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { status: null, error: `HTTP ${res.status}` }
    return { status: parseTwilioCampaignStatus(await res.json()), error: null }
  } catch (err) {
    return { status: null, error: (err as Error).message }
  }
}

export async function supabasePlan(): Promise<{ plan: string | null; error: string | null }> {
  const token = e('SUPABASE_ACCESS_TOKEN')
  const ref = supabaseRef(env.supabaseUrl)
  if (!token) return { plan: null, error: null }
  if (!ref) return { plan: null, error: 'NEXT_PUBLIC_SUPABASE_URL is not a supabase.co URL' }
  const headers = { authorization: `Bearer ${token}` }
  try {
    const proj = await fetch(`https://api.supabase.com/v1/projects/${ref}`, { headers, signal: AbortSignal.timeout(8000) })
    if (!proj.ok) return { plan: null, error: `projects lookup HTTP ${proj.status}` }
    const p = (await proj.json()) as { organization_id?: string; plan?: unknown }
    const direct = parseSupabasePlan(p)
    if (direct) return { plan: direct, error: null }
    if (p.organization_id) {
      const org = await fetch(`https://api.supabase.com/v1/organizations/${p.organization_id}`, { headers, signal: AbortSignal.timeout(8000) })
      if (org.ok) {
        const plan = parseSupabasePlan(await org.json())
        if (plan) return { plan, error: null }
      }
    }
    return { plan: null, error: 'plan not present in the management API response' }
  } catch (err) {
    return { plan: null, error: (err as Error).message }
  }
}

export function keyPresence() {
  return {
    resendKeyPresent: Boolean(env.resendKey),
    twilioSidPresent: Boolean(env.twilio.sid),
    twilioTokenPresent: Boolean(env.twilio.token),
    twilioMessagingServicePresent: Boolean(e('TWILIO_MESSAGING_SERVICE_SID')),
    stripeKeyPresent: Boolean(e('STRIPE_SECRET_KEY')),
    bookingUrlEnv: env.bookingUrl || null,
  }
}
