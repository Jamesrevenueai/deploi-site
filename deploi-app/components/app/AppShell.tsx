import type { ReactNode } from 'react'
import Link from 'next/link'
import type { Session } from '@/lib/session'
import type { ShellData } from '@/lib/app/shell'
import { MERCHANT_NAV, SETTINGS_HREF } from '@/lib/store/nav'
import { WorkspaceSwitch } from './WorkspaceSwitch'
import { SidebarNav } from './SidebarNav'
import { Usage } from './Usage'

/** The Deploi mark: a rounded square in the blue, pink and orange gradient with two white eyes, and the wordmark. */
export function Logo() {
  return (
    <Link href="/store" className="app-logo" aria-label="Deploi, Command center">
      <span className="app-logo-mark" aria-hidden="true" />
      <span className="app-logo-word" aria-hidden="true">deploi</span>
    </Link>
  )
}

/**
 * The logged-in app: the dark backdrop with its three glows, and the white app surface holding the sidebar and the
 * page. The sidebar (240px) wraps above the content on phones. Used by /store, /office and /agents.
 */
export function AppShell({ shell, session, children, subnav }: { shell: ShellData; session: Session; children: ReactNode; subnav?: ReactNode }) {
  return (
    <div className="app-backdrop">
      <a href="#main" className="app-skip">Skip to content</a>
      <div className="app-surface">
        <aside className="app-sidebar" aria-label="Sidebar">
          <Logo />
          <div>
            <p className="app-label" id="workspace-label">Workspace</p>
            <WorkspaceSwitch workspace={shell.workspace} />
            <div className="app-ws" data-testid="workspace-name">
              <p className="app-ws-name">{shell.workspaceName}</p>
              <p className="app-ws-sources">
                {shell.sources.length ? shell.sources.join(' · ') : <>Nothing connected yet · <Link href="/store/integrations">Connect</Link></>}
              </p>
            </div>
          </div>
          <SidebarNav items={MERCHANT_NAV} counts={{ needsYou: shell.needsYouCount, agents: shell.agentCount }} />
          {(shell.sections ?? []).length > 0 && (
            <nav aria-label="Your business" className="app-nav-sub" data-testid="business-sections">
              <p className="app-label">Your business</p>
              <ul className="app-nav">
                {shell.sections.map(s => <li key={s.href}><Link href={s.href} className="app-nav-link"><span>{s.label}</span></Link></li>)}
              </ul>
            </nav>
          )}
          <Usage allowance={shell.allowance} />
          <div className="app-signout">
            <span title={session.email}>{session.email}</span>
            <Link href={SETTINGS_HREF} className="app-btn app-btn--text" style={{ paddingInline: 6 }}>Settings</Link>
          </div>
          <form action="/logout" method="post" style={{ margin: '0 6px' }}><button type="submit" className="app-btn app-btn--secondary" style={{ width: '100%' }}>Sign out</button></form>
        </aside>
        <main className="app-main aurora-surface" id="main">{subnav}{children}</main>
      </div>
    </div>
  )
}
