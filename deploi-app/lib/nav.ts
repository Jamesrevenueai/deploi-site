/** Navigation for the staff area (the merchant area's is in lib/store/nav.ts). The shell owns the rail. */
export type NavItem = { href: string; label: string; /** highlight only on this exact path (for an area's home link) */ exact?: boolean; icon: 'pipeline' | 'chat' | 'clipboard' | 'bolt' | 'shield' | 'list' | 'mail' | 'home' | 'users' | 'calendar' | 'badge' | 'inbox' | 'spark' | 'dollar' | 'file' }

export const STAFF_NAV: NavItem[] = [
  { href: '/staff/early-access', label: 'Early access', icon: 'inbox' },
  { href: '/staff/audit', label: 'Audit', icon: 'list' },
  { href: '/staff/store-access', label: 'Store access', icon: 'shield' },
]
