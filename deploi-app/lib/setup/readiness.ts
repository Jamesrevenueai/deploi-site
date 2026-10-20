/**
 * Pure readiness computation for /staff/setup. Inputs are gathered elsewhere
 * (env + live provider lookups + settings rows); this only decides green/red.
 */
export type ReadinessInputs = {
  resendKeyPresent: boolean
  resendTestSend: { ok: boolean; mocked: boolean; error?: string } | null
  twilioSidPresent: boolean
  twilioTokenPresent: boolean
  twilioMessagingServicePresent: boolean
  /** null when no lookup could be made */
  twilioCampaignStatus: string | null
  twilioLookupError?: string | null
  stripeKeyPresent: boolean
  baaTemplatePath: string | null
  sowTemplatePath: string | null
  bookingUrl: string | null
  /** 'free' | 'pro' | 'team' | 'enterprise' | null when unknown */
  supabasePlan: string | null
  supabaseLookupError?: string | null
}

export type Check = { key: string; label: string; ok: boolean; detail: string; note?: string }
export type Readiness = { checks: Check[]; okCount: number; total: number; incomplete: number }

export const TEAM_PLAN_NOTE = 'Team plan + BAA required before first client PHI'

export function computeReadiness(i: ReadinessInputs): Readiness {
  const checks: Check[] = []

  checks.push({
    key: 'resend', label: 'Resend email',
    ok: i.resendKeyPresent && Boolean(i.resendTestSend?.ok) && !i.resendTestSend?.mocked,
    detail: !i.resendKeyPresent ? 'No RESEND_API_KEY; the mock adapter is in use.'
      : !i.resendTestSend ? 'Key present; send a test email to confirm.'
      : i.resendTestSend.ok && !i.resendTestSend.mocked ? 'Key present and a test email was delivered.'
      : i.resendTestSend.mocked ? 'Key present but the send was mocked.'
      : `Key present; test send failed: ${i.resendTestSend.error ?? 'unknown error'}.`,
  })

  const twilioMissing = [!i.twilioSidPresent && 'TWILIO_ACCOUNT_SID', !i.twilioTokenPresent && 'TWILIO_AUTH_TOKEN', !i.twilioMessagingServicePresent && 'TWILIO_MESSAGING_SERVICE_SID'].filter(Boolean) as string[]
  const campaignOk = (i.twilioCampaignStatus ?? '').toUpperCase() === 'VERIFIED'
  checks.push({
    key: 'twilio', label: 'Twilio SMS + A2P 10DLC',
    ok: twilioMissing.length === 0 && campaignOk,
    detail: twilioMissing.length ? `Missing ${twilioMissing.join(', ')}; the mock adapter is in use.`
      : i.twilioLookupError ? `Credentials present; campaign lookup failed: ${i.twilioLookupError}.`
      : i.twilioCampaignStatus === null ? 'Credentials present; no A2P 10DLC campaign found on the messaging service.'
      : campaignOk ? 'Credentials present; A2P 10DLC campaign is VERIFIED.'
      : `Credentials present; A2P 10DLC campaign status is ${i.twilioCampaignStatus} (needs VERIFIED).`,
  })

  checks.push({ key: 'stripe', label: 'Stripe', ok: i.stripeKeyPresent, detail: i.stripeKeyPresent ? 'STRIPE_SECRET_KEY present.' : 'No STRIPE_SECRET_KEY; invoicing stays manual.' })
  checks.push({ key: 'baa_template', label: 'BAA template', ok: Boolean(i.baaTemplatePath), detail: i.baaTemplatePath ? `Uploaded: ${i.baaTemplatePath}` : 'Not uploaded.' })
  checks.push({ key: 'sow_template', label: 'SOW template', ok: Boolean(i.sowTemplatePath), detail: i.sowTemplatePath ? `Uploaded: ${i.sowTemplatePath}` : 'Not uploaded.' })
  checks.push({ key: 'booking_url', label: 'Calendar booking URL', ok: Boolean(i.bookingUrl), detail: i.bookingUrl ? i.bookingUrl : 'Not set (settings or BOOKING_URL).' })

  const plan = (i.supabasePlan ?? '').toLowerCase()
  checks.push({
    key: 'supabase_plan', label: 'Supabase plan tier',
    ok: plan === 'team' || plan === 'enterprise',
    detail: !i.supabasePlan ? (i.supabaseLookupError ? `Unknown: ${i.supabaseLookupError}` : 'Unknown: set SUPABASE_ACCESS_TOKEN to read the plan.')
      : `Plan: ${i.supabasePlan[0].toUpperCase()}${i.supabasePlan.slice(1)}.`,
    note: TEAM_PLAN_NOTE,
  })

  const okCount = checks.filter(c => c.ok).length
  return { checks, okCount, total: checks.length, incomplete: checks.length - okCount }
}

/** Project ref from a Supabase URL like https://abc123.supabase.co */
export function supabaseRef(url: string): string | null {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in)\b/i.exec(url.trim())
  return m ? m[1] : null
}

/** First campaign_status in a Twilio Usa2p list payload, or null. */
export function parseTwilioCampaignStatus(payload: unknown): string | null {
  const list = (payload as { compliance?: unknown[]; us_app_to_person?: unknown[] } | null)
  const items = (list?.compliance ?? list?.us_app_to_person ?? []) as { campaign_status?: string }[]
  const first = items.find(x => typeof x?.campaign_status === 'string')
  return first?.campaign_status ?? null
}

/** Plan tier from a Supabase management API organization/project payload, or null. */
export function parseSupabasePlan(payload: unknown): string | null {
  const p = payload as { plan?: string | { id?: string; name?: string }; subscription_tier?: string } | null
  if (!p) return null
  if (typeof p.plan === 'string') return p.plan
  if (p.plan && typeof p.plan === 'object') return p.plan.id ?? p.plan.name ?? null
  if (typeof p.subscription_tier === 'string') return p.subscription_tier.replace(/^tier_/, '')
  return null
}
