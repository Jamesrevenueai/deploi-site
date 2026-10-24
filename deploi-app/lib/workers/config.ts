/**
 * Ops-stream configuration read straight from process.env (lib/env.ts is shared and stays untouched).
 * Every value has a safe default; none of them enables sending anything.
 */
const e = (k: string, d = '') => (process.env[k] ?? d).trim()
const num = (k: string, d: number) => { const n = Number(e(k, String(d))); return Number.isFinite(n) ? n : d }

export const DEFAULT_URGENT_KEYWORDS = ['emergency', '911', 'fall', 'fell', 'hospital', 'injured', 'chest pain', 'unsafe']

export const opsConfig = {
  /** minutes after a provider accepted a message with no delivery callback before the row is marked 'unknown' */
  get deliveryUnknownAfterMin() { return num('ACTION_DELIVERY_UNKNOWN_AFTER_MIN', 120) },
  /** default expiry for actions that have no specific rule; 0 = no expiry */
  get defaultExpiryHours() { return num('ACTION_EXPIRY_HOURS_DEFAULT', 0) },
  /** a drafted first reply to a referral is stale after this many hours */
  get referralReplyExpiryHours() { return num('ACTION_REFERRAL_REPLY_EXPIRY_HOURS', 72) },
  /** contact window used when an agency has no capacity_rules.hours, "HH:MM-HH:MM" local */
  get contactWindowDefault(): { start: string; end: string } {
    const m = e('CONTACT_WINDOW_DEFAULT', '08:00-20:00').match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/)
    return m ? { start: m[1], end: m[2] } : { start: '08:00', end: '20:00' }
  },
  /** inbound messages containing any of these create an admin task and never get an automated answer */
  get urgentKeywords(): string[] {
    const list = e('URGENT_KEYWORDS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    return list.length ? list : DEFAULT_URGENT_KEYWORDS
  },
  get isProd() { return process.env.NODE_ENV === 'production' },
}
