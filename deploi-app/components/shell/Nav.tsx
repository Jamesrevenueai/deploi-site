'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '../ui/Icon'
import type { NavItem } from '@/lib/nav'

export function Rail({ items, email, role }: { items: NavItem[]; email: string; role: string }) {
  const path = usePathname()
  return (
    <nav className="rail" aria-label="Primary">
      <Link href={items[0].href} className="wordmark mb-6 px-3">deploi <span className="text-grey-h">ai</span></Link>
      {items.map(it => {
        const active = path === it.href || path.startsWith(it.href + '/')
        return (
          <Link key={it.href} href={it.href} className={`rail-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
            <Icon name={it.icon} size={18} />{it.label}
          </Link>
        )
      })}
      <div className="mt-auto flex flex-col gap-2 px-3 pt-4 text-[13px] text-grey-h" style={{ borderTop: '1px solid var(--dg-line)' }}>
        <span className="truncate" title={email}>{email}</span>
        <span className="uppercase tracking-wide">{role}</span>
        <form action="/logout" method="post"><button className="rail-link !px-0 text-[13px]" type="submit"><Icon name="logout" size={14} />Sign out</button></form>
      </div>
    </nav>
  )
}

export function BottomBar({ items }: { items: NavItem[] }) {
  const path = usePathname()
  return (
    <nav className="bottombar" aria-label="Primary">
      {items.map(it => {
        const active = path === it.href || path.startsWith(it.href + '/')
        return (
          <Link key={it.href} href={it.href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
            <Icon name={it.icon} size={20} />{it.label}
          </Link>
        )
      })}
    </nav>
  )
}
