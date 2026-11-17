'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { navActive } from '@/lib/nav'
import type { AppNavItem } from '@/lib/store/nav'
import { Icon } from '@/components/ui/Icon'

/** The sidebar's entries; the current one is dark (#14141F, white text). Needs you carries an orange count, My agents a grey one. */
export function SidebarNav({ items, counts }: { items: AppNavItem[]; counts: { needsYou: number; agents: number } }) {
  const path = usePathname()
  // the most specific entry wins when two could claim a path
  const active = items.filter(it => navActive(it, path)).sort((a, b) => b.href.length - a.href.length)[0]
  return (
    <nav aria-label="Main">
      <ul className="app-nav">
        {items.map(it => {
          const on = it === active
          const n = it.count ? counts[it.count] : null
          return (
            <li key={it.href}>
              <Link href={it.href} className="app-nav-link" aria-current={on ? 'page' : undefined}>
                <Icon name={it.icon} size={18} />
                <span>{it.label}</span>
                {n !== null && n > 0 && <span className={`app-count${it.count === 'needsYou' ? ' orange' : ''}`} aria-label={`${n} ${it.count === 'needsYou' ? 'waiting' : n === 1 ? 'agent' : 'agents'}`}>{n}</span>}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
