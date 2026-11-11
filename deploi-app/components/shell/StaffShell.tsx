import type { ReactNode } from 'react'
import type { NavItem } from '@/lib/nav'
import type { Session } from '@/lib/session'
import { Rail, BottomBar, Wordmark } from './Nav'
import { Icon } from '../ui/Icon'

/**
 * The staff console's shell: left rail on desktop, bottom bar on mobile. (The customer app has its own shell,
 * components/app/AppShell.tsx.)
 */
export function StaffShell({ items, session, children }: { items: NavItem[]; session: Session; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">Skip to content</a>
      <Rail items={items} email={session.email} role={session.role} />
      <header className="topbar">
        <span className="wordmark" style={{ fontSize: 22 }}><Wordmark /></span>
        <form action="/logout" method="post"><button className="btn ghost xs" type="submit" aria-label="Sign out"><Icon name="logout" size={14} /></button></form>
      </header>
      <main className="content" id="main">{children}</main>
      <BottomBar items={items} />
    </div>
  )
}
