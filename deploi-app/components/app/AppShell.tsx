import type { ReactNode } from 'react'
import Link from 'next/link'
import type { Session } from '@/lib/session'
import type { ShellData } from '@/lib/app/shell'
import { MERCHANT_NAV } from '@/lib/store/nav'
import { css } from '@/components/dp/css'
import { LogoMark, Wordmark } from '@/components/dp/bits'
import { WorkspaceSwitch } from './WorkspaceSwitch'
import { SidebarNav } from './SidebarNav'
import { Usage } from './Usage'
import { SidebarBody } from './SidebarBody'

/** The Deploi mark (node graph, coral node) and wordmark "deploi.ai" (design-ref/app-*.html). */
export function Logo() {
  return (
    <Link href="/store" aria-label="deploi.ai, Command center" style={css('display: flex; align-items: center; gap: 10px; padding: 0 8px; text-decoration: none;')}>
      <LogoMark /><Wordmark />
    </Link>
  )
}

/**
 * The logged-in app (approved Indigo design): a white page, the 248px sidebar with a #E0E7FF right border (logo, Store |
 * Office switch, the main nav with counts, and the "Actions this month" card), and the page. On phones the sidebar
 * stacks above the page and its links fold behind a Menu button (SidebarBody). Used by /store, /office and /agents.
 */
export function AppShell({ shell, session, children, subnav }: { shell: ShellData; session: Session; children: ReactNode; subnav?: ReactNode }) {
  return (
    <div className="dp-app" style={css("font-family: 'Plus Jakarta Sans', system-ui, sans-serif; color: #1E1B4B; background: #FFFFFF; min-height: 100vh; display: flex; flex-wrap: wrap;")}>
      <a href="#main" className="app-skip">Skip to content</a>
      <aside aria-label="Sidebar" className="dp-sidebar" style={css('flex: 1 1 248px; max-width: 100%; box-sizing: border-box; padding: 24px 16px; border-right: 1px solid #E0E7FF; display: flex; flex-direction: column; gap: 24px; background: #FFFFFF;')}>
        <Logo />
        <WorkspaceSwitch workspace={shell.workspace} />
        <SidebarBody needsYou={shell.needsYouCount}>
          <div style={css('display: flex; flex-direction: column; gap: 24px; flex: 1;')}>
            <SidebarNav items={MERCHANT_NAV} counts={{ needsYou: shell.needsYouCount, agents: shell.agentCount }} />
            {(shell.sections ?? []).length > 0 && (
              <nav aria-label="Your business" data-testid="business-sections" style={css('display: flex; flex-direction: column; gap: 2px;')}>
                <span style={css('padding: 0 12px 6px; font-size: 12px; font-weight: 700; color: #4F46E5;')}>Your business</span>
                {shell.sections.map(s => <Link key={s.href} href={s.href} className="dp-nav" style={css('display: flex; align-items: center; min-height: 40px; padding: 0 12px; border-radius: 10px; color: #312E81; text-decoration: none; font-size: 14px; font-weight: 600;')}>{s.label}</Link>)}
              </nav>
            )}
            <div style={css('margin-top: auto; display: flex; flex-direction: column; gap: 12px;')}>
              <Usage allowance={shell.allowance} />
              <div style={css('display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; font-size: 12px; color: #312E81;')}>
                <span title={session.email} style={css('min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;')}>{session.email}</span>
                <form action="/logout" method="post" style={css('margin: 0;')}><button type="submit" style={css('min-height: 44px; padding: 0 8px; border: 0; background: transparent; color: #4F46E5; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;')}>Sign out</button></form>
              </div>
            </div>
          </div>
        </SidebarBody>
      </aside>
      <main id="main" className="dp-main" style={css('flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 28px 40px 48px; display: flex; flex-direction: column; gap: 28px;')}>
        {subnav}{children}
      </main>
    </div>
  )
}
