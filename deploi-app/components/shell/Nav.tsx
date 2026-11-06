'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '../ui/Icon'
import { navActive, type NavItem } from '@/lib/nav'

export function Wordmark() {
  return <>deploi<span className="dot">.</span></>
}

export function Rail({ items, email, role }: { items: NavItem[]; email: string; role: string }) {
  const path = usePathname()
  return (
    <nav className="rail" aria-label="Primary">
      <Link href={items[0].href} className="wordmark mb-6 px-3 pt-1" aria-label="Deploi home"><Wordmark /></Link>
      {items.map(it => {
        const active = navActive(it, path)
        return (
          <Link key={it.href} href={it.href} className={`rail-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
            <Icon name={it.icon} size={18} />{it.label}
          </Link>
        )
      })}
      <div className="mt-auto flex flex-col gap-1 px-3 pt-4 text-[13px] text-grey-h" style={{ borderTop: '1px solid var(--c-line)' }}>
        <span className="truncate text-ink" title={email}>{email}</span>
        <span className="capitalize">{role}</span>
        <form action="/logout" method="post"><button className="rail-link !px-0 text-[13px]" type="submit"><Icon name="logout" size={14} />Sign out</button></form>
      </div>
    </nav>
  )
}

/** Mobile: the entries marked `mobile` plus More, which opens the rest. */
export function BottomBar({ items }: { items: NavItem[] }) {
  const path = usePathname()
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [path])
  const main = items.filter(i => i.mobile)
  const rest = items.filter(i => !i.mobile)
  const restActive = rest.some(i => navActive(i, path))
  return (
    <>
      {open && (
        <div className="more-menu" id="more-menu" role="menu" aria-label="More">
          {rest.map(it => {
            const active = navActive(it, path)
            return <Link key={it.href} href={it.href} role="menuitem" className={`rail-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}><Icon name={it.icon} size={18} />{it.label}</Link>
          })}
        </div>
      )}
      <nav className="bottombar" aria-label="Primary">
        {main.map(it => {
          const active = navActive(it, path)
          return (
            <Link key={it.href} href={it.href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              <Icon name={it.icon} size={20} />{it.short ?? it.label}
            </Link>
          )
        })}
        {rest.length > 0 && (
          <button type="button" aria-expanded={open} aria-controls="more-menu" onClick={() => setOpen(o => !o)} className={restActive ? 'active' : ''} style={restActive ? { color: 'var(--c-accent)' } : undefined}>
            <Icon name="menu" size={20} />More
          </button>
        )}
      </nav>
    </>
  )
}
