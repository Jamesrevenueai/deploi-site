'use client'
/**
 * The sidebar's contents. On wide screens it is always shown. On phones (840px and below) it folds behind a "Menu"
 * button so the page starts at the top of the screen instead of under the whole menu; the button says how many things
 * need the owner, and the menu closes itself when a link is followed.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

export function SidebarBody({ needsYou, children }: { needsYou: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const path = usePathname()
  const id = useId()
  useEffect(() => { setOpen(false) }, [path])
  return (
    <>
      <button type="button" className="app-menu-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)} data-testid="menu-button">
        <span aria-hidden="true" className="app-menu-icon" />
        {open ? 'Close menu' : 'Menu'}
        {!open && needsYou > 0 && <span className="app-menu-count" aria-label={`${needsYou} need${needsYou === 1 ? 's' : ''} you`}>{needsYou}</span>}
      </button>
      <div id={id} className="app-sidebar-body" data-open={open ? 'true' : 'false'}>{children}</div>
    </>
  )
}
