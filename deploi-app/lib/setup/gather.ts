import type { Db } from '../db'
import { computeReadiness, type Readiness } from './readiness'
import { keyPresence, twilioCampaignStatus, supabasePlan } from './providers'
import { getSettings, settingString } from './settings'

/** Everything the page and the banner need. Live lookups run only when their keys exist. */
export async function gatherReadiness(db: Db, opts: { resendTestSend?: { ok: boolean; mocked: boolean; error?: string } | null } = {}): Promise<Readiness> {
  const keys = keyPresence()
  const settings = await getSettings(db)
  const [tw, sb] = await Promise.all([twilioCampaignStatus(), supabasePlan()])
  return computeReadiness({
    resendKeyPresent: keys.resendKeyPresent,
    resendTestSend: opts.resendTestSend ?? null,
    twilioSidPresent: keys.twilioSidPresent,
    twilioTokenPresent: keys.twilioTokenPresent,
    twilioMessagingServicePresent: keys.twilioMessagingServicePresent,
    twilioCampaignStatus: tw.status,
    twilioLookupError: tw.error,
    stripeKeyPresent: keys.stripeKeyPresent,
    baaTemplatePath: settingString(settings.baa_template, 'path'),
    sowTemplatePath: settingString(settings.sow_template, 'path'),
    bookingUrl: settingString(settings.booking_url, 'url') ?? keys.bookingUrlEnv,
    supabasePlan: sb.plan,
    supabaseLookupError: sb.error,
  })
}
