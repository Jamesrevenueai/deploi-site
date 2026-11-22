// @vitest-environment jsdom
/**
 * The Store | Office switch of the sidebar: a keyboard-operable radiogroup that switches the whole app through
 * POST /api/app/workspace (the real route, on the database), after which the Command center's feeds are the
 * other side's; on another page it opens the Command center. A refused switch goes back and says why.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, resetMerchant } from '../merchant/helpers'
import { routeFetch, commandCenterOver } from './ui-helpers'

// next/navigation: the router's calls are recorded, `nav.path` is the current path (hoisted: no imports)
const { router, nav } = vi.hoisted(() => ({ router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }, nav: { path: '/store' } }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => nav.path, redirect: (to: string) => { throw new Error(`redirect ${to}`) } }))
const { WorkspaceSwitch } = await import('../../components/app/WorkspaceSwitch')

const ready = await prepareDb()
const clean = () => admin(db => db.query('delete from app_workspace_prefs where org_id = $1', [NW.org]))

describe.skipIf(!ready)('Store | Office switch', () => {
  let rf: ReturnType<typeof routeFetch>
  beforeAll(async () => { await resetMerchant(NW); await clean() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); router.refresh.mockClear(); router.push.mockClear(); nav.path = '/store' })
  afterAll(clean)
  const mount = (ws: 'store' | 'office') => { rf = routeFetch(NW.domain); vi.stubGlobal('fetch', rf.fetchMock); return render(<WorkspaceSwitch workspace={ws} />) }

  it('is a labelled radiogroup with Store checked; choosing Office posts it and the feeds become the Office side', async () => {
    mount('store')
    const group = screen.getByRole('radiogroup', { name: 'Workspace' })
    const [store, office] = screen.getAllByRole('radio')
    expect(group).toBeTruthy()
    expect([store.textContent, office.textContent]).toEqual(['Store', 'Office'])
    expect(store.getAttribute('aria-checked')).toBe('true')
    expect(office.getAttribute('aria-checked')).toBe('false')
    // roving tab stop: only the checked segment is in the tab order
    expect([store.tabIndex, office.tabIndex]).toEqual([0, -1])
    expect((await commandCenterOver(rf.token)).workspace).toBe('store')

    fireEvent.click(office)
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(rf.calls).toEqual([{ method: 'POST', path: '/api/app/workspace', body: { workspace: 'office' } }])
    expect(office.getAttribute('aria-checked')).toBe('true')
    // the whole app follows: the default read of the Command center is now the Office side, with Office agents only
    const cc = await commandCenterOver(rf.token)
    expect(cc.workspace).toBe('office')
    expect(cc.team.every((a: { workspace: string }) => a.workspace === 'office')).toBe(true)
    expect(cc.needsYou.every((a: { workspace: string }) => a.workspace === 'office')).toBe(true)
    expect(cc.doneWithProof.every((a: { workspace: string }) => a.workspace === 'office')).toBe(true)
  })

  it('works from the keyboard: arrow keys move the focus and choose; from another page it opens the Command center', async () => {
    nav.path = '/store/integrations'
    mount('office')
    const [store, office] = screen.getAllByRole('radio')
    office.focus()
    fireEvent.keyDown(office, { key: 'ArrowLeft' })
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/store'))
    expect(document.activeElement).toBe(store)
    expect(store.getAttribute('aria-checked')).toBe('true')
    expect([store.tabIndex, office.tabIndex]).toEqual([0, -1])
    expect(rf.calls.at(-1)).toEqual({ method: 'POST', path: '/api/app/workspace', body: { workspace: 'store' } })
    expect((await commandCenterOver(rf.token)).workspace).toBe('store')
    // End jumps to the last segment; the checked one again does nothing
    fireEvent.keyDown(store, { key: 'End' })
    await waitFor(() => expect(office.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(office)
    expect(rf.calls.filter(c => c.method === 'POST')).toHaveLength(2)
  })

  it('a refused switch goes back to the side you were on and says why', async () => {
    mount('store')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'rate_limited', message: 'too many requests; try again later' }), { status: 429 })))
    fireEvent.click(screen.getByRole('radio', { name: 'Office' }))
    expect((await screen.findByRole('alert')).textContent).toBe('too many requests; try again later')
    expect(screen.getByRole('radio', { name: 'Store' }).getAttribute('aria-checked')).toBe('true')
    expect(router.refresh).not.toHaveBeenCalled()
  })
})
