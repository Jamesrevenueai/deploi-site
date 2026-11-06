import type { ReactNode } from 'react'
import type { NavItem } from '@/lib/nav'
import type { Session } from '@/lib/session'
import { Rail, BottomBar, Wordmark } from './Nav'
import { Icon } from '../ui/Icon'

/** Left rail on desktop, bottom bar on mobile. Content is left-aligned, one-handed at 390px. */
export function AppShell({ items, session, children, subnav }: { items: NavItem[]; session: Session; children: ReactNode; subnav?: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">Skip to content</a>
      <Rail items={items} email={session.email} role={session.role} />
      <header className="topbar">
        <span className="wordmark" style={{ fontSize: 22 }}><Wordmark /></span>
        <form action="/logout" method="post"><button className="btn ghost xs" type="submit" aria-label="Sign out"><Icon name="logout" size={14} /></button></form>
      </header>
      <main className="content" id="main">{subnav}{children}</main>
      <BottomBar items={items} />
    </div>
  )
}
