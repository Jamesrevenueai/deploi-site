/** Navigation for both areas. Sections 4–8 own the pages; the shell owns the rail. */
export type NavItem = { href: string; label: string; /** highlight only on this exact path (for an area's home link) */ exact?: boolean; icon: 'pipeline' | 'chat' | 'clipboard' | 'bolt' | 'shield' | 'list' | 'mail' | 'home' | 'users' | 'calendar' | 'badge' | 'inbox' | 'spark' | 'dollar' | 'file' }

export const STAFF_NAV: NavItem[] = [
  { href: '/staff/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { href: '/staff/conversations', label: 'Conversations', icon: 'chat' },
  { href: '/staff/assessments', label: 'Assessments', icon: 'clipboard' },
  { href: '/staff/engagements', label: 'Engagements', icon: 'file' },
  { href: '/staff/website', label: 'Website', icon: 'spark' },
  { href: '/staff/actions', label: 'Actions', icon: 'bolt' },
  { href: '/staff/evv', label: 'EVV', icon: 'shield' },
  { href: '/staff/queue', label: 'Queue', icon: 'list' },
  { href: '/staff/economics', label: 'Economics', icon: 'dollar' },
  { href: '/staff/audit', label: 'Audit', icon: 'list' },
  { href: '/staff/emails/preview', label: 'Emails', icon: 'mail' },
  { href: '/staff/setup', label: 'Setup', icon: 'spark' },
]

export const CLIENT_NAV: NavItem[] = [
  { href: '/app/home', label: 'Home', icon: 'home' },
  { href: '/app/referrals', label: 'Referrals', icon: 'inbox' },
  { href: '/app/shifts', label: 'Shifts', icon: 'calendar' },
  { href: '/app/evv', label: 'EVV', icon: 'shield' },
  { href: '/app/authorizations', label: 'Auths', icon: 'clipboard' },
  { href: '/app/applicants', label: 'Applicants', icon: 'users' },
  { href: '/app/credentials', label: 'Credentials', icon: 'badge' },
]
