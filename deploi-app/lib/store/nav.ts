/**
 * Navigation of the logged-in app (the sidebar of components/app/AppShell.tsx; /store, /office and /agents share it).
 * The embedded Shopify app uses App Bridge's own menu.
 *
 * The labels are the owner's words for the work (approved redesign 2026-11-06): Command center, Needs you, My agents,
 * Agent library, Proof log, Connections, Plan & actions. Pages that are not in the list (work in progress, inbox,
 * insights, settings) stay reachable from the pages that link to them and from the sidebar's footer (Settings).
 */
import type { NavItem } from '../nav'
import type { CaseView } from '../cases'

export type AppNavItem = NavItem & { /** a live count shown next to the label */ count?: 'needsYou' | 'agents' }

export const MERCHANT_NAV: AppNavItem[] = [
  { href: '/store', label: 'Command center', icon: 'home', exact: true, also: ['/store/control-room'] },
  { href: '/store/approvals', label: 'Needs you', icon: 'check', count: 'needsYou', also: ['/office/approvals'] },
  { href: '/store/my-team', label: 'My agents', icon: 'users', count: 'agents', also: ['/agents', '/store/agents', '/office/agents', '/store/packs'] },
  { href: '/store/team', label: 'Agent library', icon: 'spark' },
  { href: '/store/completed', label: 'Proof log', icon: 'badge', also: ['/store/activity', '/store/weekly', '/office/log'] },
  { href: '/store/integrations', label: 'Connections', icon: 'plug', also: ['/store/connections', '/store/connect', '/office/connections'] },
  { href: '/store/plan', label: 'Plan & actions', icon: 'dollar', also: ['/store/billing'] },
]

/** Where the sidebar's footer links (not one of the main entries). */
export const SETTINGS_HREF = '/store/settings'

/** The exact labels, in order. */
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
