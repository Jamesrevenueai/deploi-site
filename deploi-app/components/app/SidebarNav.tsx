'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { navActive } from '@/lib/nav'
import type { AppNavItem } from '@/lib/store/nav'
import { css } from '@/components/dp/css'
import { NAV_ICONS } from '@/components/dp/bits'

const ICON: Record<string, keyof typeof NAV_ICONS> = {
  '/store': 'command', '/store/my-team': 'agents', '/store/team': 'library', '/store/approvals': 'approvals', '/store/completed': 'proof',
  '/store/integrations': 'connections', '/store/weekly': 'reports', '/store/settings': 'settings',
}
const LINK = 'display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 12px; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 600;'

/** The main nav (design): the current entry is a solid indigo pill with white text; My agents a soft count, Approvals an indigo badge. */
export function SidebarNav({ items, counts }: { items: AppNavItem[]; counts: { needsYou: number; agents: number } }) {
  const path = usePathname()
  const active = items.filter(it => navActive(it, path)).sort((a, b) => b.href.length - a.href.length)[0]
  return (
    <nav aria-label="Main" style={css('display: flex; flex-direction: column; gap: 2px;')}>
      {items.map(it => {
        const on = it === active
        const n = it.count ? counts[it.count] : null
        const badge = it.count === 'needsYou'
          ? 'margin-left: auto; font-family: \'JetBrains Mono\', monospace; font-size: 11px; background: #4F46E5; color: #FFFFFF; padding: 2px 8px; border-radius: 999px;'
          : 'margin-left: auto; font-family: \'JetBrains Mono\', monospace; font-size: 11px; background: #EEF2FF; color: #3730A3; padding: 2px 8px; border-radius: 999px;'
        return (
          <Link key={it.href} href={it.href} className={on ? undefined : 'dp-nav'} aria-current={on ? 'page' : undefined}
            style={css(LINK + (on ? 'background: #4F46E5; color: #FFFFFF;' : 'color: #312E81;'))}>
            {NAV_ICONS[ICON[it.href] ?? 'command']}{it.label}
            {n !== null && n > 0 && <span style={css(on ? badge.replace('background: #4F46E5; color: #FFFFFF', 'background: #FFFFFF; color: #4F46E5') : badge)} aria-label={`${n} ${it.count === 'needsYou' ? 'waiting' : n === 1 ? 'agent' : 'agents'}`}>{n.toLocaleString('en-US')}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
