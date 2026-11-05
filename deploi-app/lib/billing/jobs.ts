/** The hourly billing work (called from /api/cron/agents): trial-ending reminders, then any notice left unsent. */
import { admin } from '../db'
import { log } from '../log'
import { billingMode } from './config'
import { queueTrialReminders } from './lifecycle'
import { deliverNotices } from './notify'

export async function billingHourly(now = new Date()): Promise<{ reminders: number; sent: number; skipped: number; failed: number } | null> {
  if (billingMode() === 'off') return null
  try {
    const reminders = await admin(db => queueTrialReminders(db, now))
    return { reminders, ...(await deliverNotices({ limit: 200 })) }
  } catch (e) {
    log.error('billing.hourly.failed', { error: (e as Error).message.slice(0, 200) })
    return null
  }
}
