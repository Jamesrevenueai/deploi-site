/**
 * Navigation for the customer app (/store and /office share it). The embedded Shopify app uses App Bridge's own menu.
 *
 * The labels are the customer's words for the work, not Deploi's internals:
 *  Home (the Control Room), My AI Team (every agent: store, Office and library), Work in Progress (cases being
 *  handled or needing attention), Needs My Approval (every decision waiting, from every source), Completed Work
 *  (verified outcomes), Inbox (customer mail), Business Insights, Integrations, Billing, Settings.
 */
import type { NavItem } from '../nav'
import type { CaseView } from '../cases'

export const MERCHANT_NAV: NavItem[] = [
  { href: '/store', label: 'Home', icon: 'home', exact: true, also: ['/store/control-room'], mobile: true },
  { href: '/store/my-team', label: 'My AI Team', short: 'Team', icon: 'users', also: ['/store/agents', '/store/team', '/office', '/store/packs'] },
  { href: '/store/work', label: 'Work in Progress', short: 'Work', icon: 'pipeline', also: ['/store/issues', '/store/purchase-orders'], mobile: true },
  { href: '/store/approvals', label: 'Needs My Approval', short: 'Approvals', icon: 'check', mobile: true },
  { href: '/store/completed', label: 'Completed Work', short: 'Done', icon: 'badge', also: ['/store/activity', '/store/weekly'] },
  { href: '/store/inbox/mail', label: 'Inbox', icon: 'inbox', mobile: true },
  { href: '/store/insights', label: 'Business Insights', short: 'Insights', icon: 'spark', also: ['/store/discover'] },
  { href: '/store/integrations', label: 'Integrations', short: 'Connect', icon: 'plug', also: ['/store/connections', '/store/connect'] },
  { href: '/store/billing', label: 'Billing', icon: 'dollar', also: ['/store/plan'] },
  { href: '/store/settings', label: 'Settings', icon: 'shield', also: ['/store/rules', '/store/legal', '/store/setup', '/store/onboarding', '/store/welcome', '/store/support', '/store/privacy'] },
]

/** The exact labels, in order (the brief's navigation). */
export const NAV_LABELS = MERCHANT_NAV.map(n => n.label)

/**
 * Old customer URLs and where they live now. Each keeps working through a redirect (the page files at the
 * old paths call redirect(); see app/store/** ). Paths not listed here still render their own page.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/store/control-room': '/store',
  '/store/inbox': '/store/approvals',
}

/**
 * The one first-run path (sign-up → agreements → products → connect → discovery → team). The earlier setup
 * wizard (/store/onboarding) and discovery first run (/store/welcome) redirect here.
 */
export const SETUP_PATH = '/store/setup'

/** Which Resolution Engine views each case page lists (GET /api/store/cases?view=...). */
export const CASE_VIEWS: Record<'work' | 'approvals' | 'completed', CaseView[]> = {
  work: ['in_progress', 'attention'],
  approvals: ['needs_approval'],
  completed: ['completed'],
}

/** The page a case reference opens. */
export const caseHref = (ref: string) => `/store/work/${encodeURIComponent(ref)}`

/** The embedded Shopify app's menu and the features it shows: lib/shopify/embedded.ts (embeddedNav, EMBEDDED_FEATURES). */
