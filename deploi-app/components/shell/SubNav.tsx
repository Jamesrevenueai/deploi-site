'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { navActive, type NavItem } from '@/lib/nav'

/** Section tabs under the shared navigation (Deploi Office's own pages). */
export function SubNav({ items, label }: { items: NavItem[]; label: string }) {
  const path = usePathname()
  return (
    <nav className="subnav" aria-label={label}>
      {items.map(it => {
        const active = navActive(it, path)
        return <Link key={it.href} href={it.href} aria-current={active ? 'page' : undefined}>{it.label}</Link>
      })}
    </nav>
  )
}
