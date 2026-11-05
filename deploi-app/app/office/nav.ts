/** Deploi Office's own pages (/office), shown as tabs under the shared customer navigation (lib/store/nav.ts). */
import type { NavItem } from '@/lib/nav'

export const OFFICE_NAV: NavItem[] = [
  { href: '/office', label: 'Office overview', icon: 'home', exact: true },
  { href: '/office/approvals', label: 'Office approvals', icon: 'inbox' },
  { href: '/office/agents', label: 'Office agents', icon: 'bolt' },
  { href: '/office/connections', label: 'Office connections', icon: 'mail' },
  { href: '/office/log', label: 'Work log', icon: 'list' },
]
