/** Navigation for Deploi Office (/office). */
import type { NavItem } from '@/lib/nav'

export const OFFICE_NAV: NavItem[] = [
  { href: '/office', label: 'Overview', icon: 'home', exact: true },
  { href: '/office/approvals', label: 'Approvals', icon: 'inbox' },
  { href: '/office/agents', label: 'Agents', icon: 'bolt' },
  { href: '/office/connections', label: 'Connections', icon: 'mail' },
  { href: '/office/log', label: 'Work log', icon: 'list' },
  { href: '/store', label: 'Commerce', icon: 'spark' },
]
