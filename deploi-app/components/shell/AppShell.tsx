import type { ReactNode } from 'react'
import type { NavItem } from '@/lib/nav'
import type { Session } from '@/lib/session'
import { Rail, BottomBar } from './Nav'
import { Icon } from '../ui/Icon'

/** Left rail on desktop, bottom bar on mobile. Content is left-aligned, one-handed at 390px. */
export function AppShell({ items, session, children }: { items: NavItem[]; session: Session; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <Rail items={items} email={session.email} role={session.role} />
      <header className="topbar">
        <span className="wordmark" style={{ fontSize: 22 }}>deploi <span className="text-grey-h">ai</span></span>
        <form action="/logout" method="post"><button className="btn ghost xs" type="submit" aria-label="Sign out"><Icon name="logout" size={14} /></button></form>
      </header>
      <main className="content">{children}</main>
      <BottomBar items={items} />
    </div>
  )
}
