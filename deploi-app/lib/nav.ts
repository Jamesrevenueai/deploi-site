/** Navigation for the staff area (the merchant area's is in lib/store/nav.ts). The shell owns the rail. */
export type NavItem = {
  href: string; label: string
  /** shorter label for the mobile bottom bar */ short?: string
  /** highlight only on this exact path (for an area's home link) */ exact?: boolean
  /** other paths (and their sub-paths) that belong to this entry */ also?: string[]
  /** shown in the mobile bottom bar (the rest are under More) */ mobile?: boolean
  icon: 'pipeline' | 'chat' | 'clipboard' | 'bolt' | 'shield' | 'list' | 'mail' | 'home' | 'users' | 'calendar' | 'badge' | 'inbox' | 'spark' | 'dollar' | 'file' | 'alert' | 'check' | 'map' | 'plug'
}

/** Is this entry the current page? */
export function navActive(it: NavItem, path: string): boolean {
  if (path === it.href || (!it.exact && path.startsWith(it.href + '/'))) return true
  return (it.also ?? []).some(a => path === a || path.startsWith(a + '/'))
}

export const STAFF_NAV: NavItem[] = [
  { href: '/staff/early-access', label: 'Early access', icon: 'inbox' },
  { href: '/staff/audit', label: 'Audit', icon: 'list' },
  { href: '/staff/store-access', label: 'Store access', icon: 'shield' },
  { href: '/staff/unit-economics', label: 'Unit economics', icon: 'dollar' },
  { href: '/staff/support', label: 'Support', icon: 'chat' },
]
