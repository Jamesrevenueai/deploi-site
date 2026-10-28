/** Navigation for the merchant area of the Deploi web app (/store). The embedded Shopify app uses App Bridge's own menu. */
import type { NavItem } from '../nav'

export const MERCHANT_NAV: NavItem[] = [
  { href: '/store/agents', label: 'Agents', icon: 'bolt' },
  { href: '/store', label: 'Overview', icon: 'home', exact: true },
  { href: '/store/issues', label: 'Issues', icon: 'inbox' },
  { href: '/store/activity', label: 'Activity', icon: 'list' },
  { href: '/store/rules', label: 'Rules', icon: 'shield' },
  { href: '/store/connect', label: 'Store', icon: 'spark' },
]

/** The embedded app's home route (App Bridge marks it rel="home"; it is the app's landing page, not a menu entry). */
export const EMBEDDED_HOME = '/shopify'

/** Pages listed in the embedded app's App Bridge navigation menu, in order. */
export const EMBEDDED_NAV: { href: string; label: string }[] = [
  { href: '/shopify/agents', label: 'Agents' },
  { href: EMBEDDED_HOME, label: 'Overview' },
  { href: '/shopify/issues', label: 'Issues' },
  { href: '/shopify/activity', label: 'Activity' },
  { href: '/shopify/rules', label: 'Rules' },
]
