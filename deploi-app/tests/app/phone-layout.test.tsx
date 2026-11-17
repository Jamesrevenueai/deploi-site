// @vitest-environment jsdom
/**
 * Phone layout fixes (2026-11-08 live preview findings):
 *   - the sidebar folds behind a Menu button (aria-expanded, aria-controls), shows how many things need the owner, and
 *     closes when the page changes;
 *   - Help and Feedback keep their accessible names when they shrink to icon buttons (the label is visually hidden on
 *     phones, never removed);
 *   - the CSS: the menu only folds at 840px and below, the folded body is hidden, the floating buttons shrink at 640px.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const { nav } = vi.hoisted(() => ({ nav: { path: '/store' } }))
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
const { SidebarBody } = await import('../../components/app/SidebarBody')
const { FeedbackButton } = await import('../../components/team/FeedbackButton')

afterEach(() => { cleanup(); nav.path = '/store' })

describe('phone menu', () => {
  it('starts folded, opens and closes, says what needs you, and folds again on a new page', () => {
    const { rerender } = render(<SidebarBody needsYou={3}><nav aria-label="Main"><a href="/store/room">Team room</a></nav></SidebarBody>)
    const btn = screen.getByRole('button', { name: /^Menu/ })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!
    expect(body.getAttribute('data-open')).toBe('false')
    expect(screen.getByLabelText('3 need you')).toBeTruthy()
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(body.getAttribute('data-open')).toBe('true')
    expect(btn.textContent).toContain('Close menu')
    nav.path = '/store/room'
    rerender(<SidebarBody needsYou={3}><nav aria-label="Main"><a href="/store/room">Team room</a></nav></SidebarBody>)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows no count when nothing needs you (one need: singular)', () => {
    render(<SidebarBody needsYou={0}><p>x</p></SidebarBody>)
    expect(screen.queryByLabelText(/needs? you/)).toBeNull()
    cleanup()
    render(<SidebarBody needsYou={1}><p>x</p></SidebarBody>)
    expect(screen.getByLabelText('1 needs you')).toBeTruthy()
  })

  it('Feedback keeps its name when it is an icon button', () => {
    render(<FeedbackButton />)
    expect(screen.getByRole('button', { name: 'Feedback' })).toBeTruthy()
  })

  it('the CSS folds the menu at 840px and shrinks Help and Feedback at 640px', () => {
    const app = readFileSync('styles/app.css', 'utf8')
    expect(app).toMatch(/@media \(max-width: 840px\)[\s\S]*\.app-sidebar-body\[data-open="false"\] \{ display: none; \}/)
    expect(app).toMatch(/\.app-menu-btn \{ display: none; \}/)
    const g = readFileSync('app/globals.css', 'utf8')
    expect(g).toMatch(/@media \(max-width: 640px\) \{\s*\.au-feedback \{ width: 44px;[\s\S]*\.au-fab-label \{ position: absolute; width: 1px;/)
  })
})
