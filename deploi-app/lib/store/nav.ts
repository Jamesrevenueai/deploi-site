/** Navigation for the merchant area of the Deploi web app (/store). The embedded Shopify app uses App Bridge's own menu. */
import type { NavItem } from '../nav'

export const MERCHANT_NAV: NavItem[] = [
  { href: '/store', label: 'Overview', icon: 'home', exact: true },
  { href: '/store/issues', label: 'Issues', icon: 'inbox' },
  { href: '/store/activity', label: 'Activity', icon: 'list' },
  { href: '/store/rules', label: 'Rules', icon: 'shield' },
  { href: '/store/connect', label: 'Store', icon: 'spark' },
]

/** Pages listed in the embedded app's App Bridge navigation menu (the first entry is the app home). */
export const EMBEDDED_NAV: { href: string; label: string }[] = [
  { href: '/shopify', label: 'Overview' },
  { href: '/shopify/issues', label: 'Issues' },
  { href: '/shopify/activity', label: 'Activity' },
  { href: '/shopify/rules', label: 'Rules' },
]
