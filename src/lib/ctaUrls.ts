/**
 * All checkout / booking URLs read from Vite env. If a var is empty the
 * button "falls back" to scrolling to the on-page waitlist form (via the
 * `#waitlist` anchor). This lets us ship the site before Stripe/Cal.com
 * accounts exist.
 */

const AUDIT: string | undefined = import.meta.env.VITE_AUDIT_CHECKOUT_URL
const AUDIT_FOUNDING: string | undefined = import.meta.env.VITE_AUDIT_FOUNDING_CHECKOUT_URL
const COURSE: string | undefined = import.meta.env.VITE_COURSE_CHECKOUT_URL
const MINI_AUDIT: string | undefined = import.meta.env.VITE_MINI_AUDIT_URL

export const WAITLIST_ANCHOR = '#waitlist'

function pick(v: string | undefined): string {
  return v && v.trim() ? v.trim() : WAITLIST_ANCHOR
}

export const auditUrl = () => pick(AUDIT)
export const auditFoundingUrl = () => pick(AUDIT_FOUNDING)
export const courseUrl = () => pick(COURSE)
export const miniAuditUrl = () => pick(MINI_AUDIT)

export const isConfigured = {
  audit: () => Boolean(AUDIT && AUDIT.trim()),
  auditFounding: () => Boolean(AUDIT_FOUNDING && AUDIT_FOUNDING.trim()),
  course: () => Boolean(COURSE && COURSE.trim()),
  miniAudit: () => Boolean(MINI_AUDIT && MINI_AUDIT.trim()),
}
