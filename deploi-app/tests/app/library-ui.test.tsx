// @vitest-environment jsdom
/**
 * The Agent library (components/team/TeamScreen.tsx, design-ref/app-agent-library.html) over the real routes
 * (GET /api/store/library, POST /api/store/library/:key/switch) as the embedded session of a Starter store:
 * the header counts agents on, the area filters, the "Build your own" card, one card per agent with its switch,
 * a locked agent shows "<Plan> plan" and opens the upgrade prompt, and the server refuses switching it on (402)
 * whatever the browser sends. The Office side lists the Office agents gated by the Office plan.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { prepareDb, SESSIONS } from '../db/helpers'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'
import { admin } from '../../lib/db'
import { NW, resetMerchant } from '../merchant/helpers'
import { GET as libGet } from '../../app/api/store/library/route'
import { POST as libAction } from '../../app/api/store/library/[key]/[action]/route'

// the owner's web session (the Shopify-embedded session hides the library: tests/shopify/embedded-gating.test.ts)
const cookie = vi.hoisted(() => ({ value: undefined as string | undefined, name: '' }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === cookie.name && cookie.value ? { value: cookie.value } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/store/team' }))
const { TeamScreen } = await import('../../components/team/TeamScreen')

const ready = await prepareDb()
const calls: { method: string; path: string; status: number }[] = []
const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = String(input)
  const method = (init.method ?? 'GET').toUpperCase()
  const req = new Request(`http://localhost:3000${path}`, { method, headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, ...(init.body ? { body: init.body as string } : {}) })
  const m = new URL(req.url).pathname.match(/^\/api\/store\/library\/([a-z_]+)\/([a-z_]+)$/)
  const res = path.startsWith('/api/store/library') && !m ? await libGet(req) : m ? await libAction(req, { params: Promise.resolve({ key: m[1], action: m[2] }) })
    : new Response(JSON.stringify({ ok: false, error: 'not_found', message: 'no test route' }), { status: 404 })
  calls.push({ method, path, status: res.status })
  return res
})
const setTier = (tier: string) => admin(db => db.query(`update agencies set plan_tier = $2, plan_key = $2 where id = $1`, [NW.org, tier]))
const reset = () => admin(db => db.query(`delete from library_switches where org_id = $1 and engine_agent_id is null`, [NW.org]))

afterEach(() => { cleanup(); calls.length = 0 })

describe.skipIf(!ready)('Agent library (Starter store)', () => {
  beforeAll(async () => { Object.assign(cookie, { name: DEV_COOKIE_NAME, value: encodeDevSession(SESSIONS.northwind) }); await resetMerchant(NW); await reset(); await setTier('starter'); vi.stubGlobal('fetch', fetchMock) })
  afterAll(async () => { vi.unstubAllGlobals(); await reset(); await setTier('growth') })

  it('renders the design: header, filters, Build your own, 12 agents with Starter\'s 7 unlocked and the rest showing their plan', async () => {
    render(<TeamScreen />)
    await screen.findByRole('group', { name: 'Filter by area' }, { timeout: 5000 })
    expect(screen.getByText('Built by Deploi · one agent for every part of your store')).toBeTruthy()
    expect(screen.getByTestId('agents-on').textContent).toMatch(/^\d+ agents on$/)
    const filters = within(screen.getByRole('group', { name: 'Filter by area' })).getAllByRole('button')
    expect(filters.map(b => b.textContent)).toEqual(['All', 'Orders', 'Products', 'Customers', 'Marketing', 'Finance', 'Store'])
    expect(filters[0].getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('build-your-own').textContent).toContain('Build your own agent')
    const cards = document.querySelectorAll('article[data-agent]')
    expect(cards).toHaveLength(12)
    const unlocked = [...cards].filter(c => c.getAttribute('data-locked') === 'false').map(c => c.getAttribute('data-agent')).sort()
    expect(unlocked).toEqual(['customer_care', 'inventory_watcher', 'listing_writer', 'order_tracker', 'store_health_checker', 'supplier_chaser', 'weekly_insights'])
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    for (const s of screen.getAllByRole('switch')) expect(s.getAttribute('aria-label')).toMatch(/^Turn (on|off) /)
    const returns = document.querySelector('article[data-agent="returns"]') as HTMLElement
    expect(within(returns).getByRole('button', { name: /needs the Growth plan/ }).textContent).toBe('Growth plan')
    const ai = document.querySelector('article[data-agent="ai_visibility"]') as HTMLElement
    expect(within(ai).getByRole('button', { name: /needs the Pro plan/ }).textContent).toBe('Pro plan')
  })

  it('a filter shows only that area', async () => {
    render(<TeamScreen />)
    await screen.findByRole('group', { name: 'Filter by area' }, { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: 'Finance' }))
    expect([...document.querySelectorAll('article[data-agent]')].map(c => c.getAttribute('data-agent'))).toEqual(['payout_fees_checker', 'weekly_insights'])
    expect(screen.queryByTestId('build-your-own')).toBeNull()
    expect(screen.getByRole('button', { name: 'Finance' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a locked agent opens the upgrade prompt to its plan; the API refuses switching it on (402) and nothing is stored', async () => {
    render(<TeamScreen />)
    await screen.findByRole('group', { name: 'Filter by area' }, { timeout: 5000 })
    fireEvent.click(within(document.querySelector('article[data-agent="returns"]') as HTMLElement).getByRole('button'))
    const prompt = await screen.findByTestId('upgrade-prompt')
    expect(within(prompt).getByRole('link', { name: 'See the Growth plan' }).getAttribute('href')).toMatch(/\/plan\?upgrade=growth$/)
    // the browser cannot get around it: a direct switch-on is refused by the server
    const res = await fetchMock('/api/store/library/returns/switch', { method: 'POST', body: JSON.stringify({ enabled: true }) })
    expect(res.status).toBe(402)
    expect(await admin(db => db.one(`select 1 as x from library_switches where org_id = $1 and agent_key = 'returns' and enabled`, [NW.org]))).toBeNull()
  })

  it('an unlocked agent switches on through the API at the most restrictive level', async () => {
    render(<TeamScreen />)
    await screen.findByRole('group', { name: 'Filter by area' }, { timeout: 5000 })
    const card = document.querySelector('article[data-agent="listing_writer"]') as HTMLElement
    const sw = within(card).getByRole('switch')
    if (sw.getAttribute('aria-checked') === 'true') { fireEvent.click(sw); await waitFor(() => expect(within(document.querySelector('article[data-agent="listing_writer"]') as HTMLElement).getByRole('switch').getAttribute('aria-checked')).toBe('false')) }
    fireEvent.click(within(document.querySelector('article[data-agent="listing_writer"]') as HTMLElement).getByRole('switch'))
    await waitFor(() => expect(within(document.querySelector('article[data-agent="listing_writer"]') as HTMLElement).getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/store/library/listing_writer/switch' && c.status === 200)).toBe(true)
    expect(await admin(db => db.one<{ permission: string }>(`select permission from library_switches where org_id = $1 and agent_key = 'listing_writer'`, [NW.org]))).toMatchObject({ permission: expect.stringMatching(/^(read|draft)$/) })
  })
})

describe('Agent library: the Office side', () => {
  afterAll(() => cleanup())
  it('Solo unlocks Lead Responder, Invoice Runner, CRM Follow-up and Owner Updates; Team agents show "Team plan"', () => {
    render(<TeamScreen workspace="office" officePlan="solo" />)
    const cards = [...document.querySelectorAll('article[data-agent]')]
    expect(cards.filter(c => c.getAttribute('data-locked') === 'false').map(c => c.getAttribute('data-agent'))).toEqual(['lead_responder', 'invoice_runner', 'crm_followup', 'owner_updates'])
    const locked = cards.filter(c => c.getAttribute('data-locked') === 'true')
    expect(locked.map(c => within(c as HTMLElement).getByRole('button').textContent)).toEqual(['Team plan', 'Team plan'])
    fireEvent.click(within(locked[0] as HTMLElement).getByRole('button'))
    expect(within(screen.getByTestId('upgrade-prompt')).getByRole('link', { name: 'See the Team plan' })).toBeTruthy()
  })
  it('Business unlocks all six', () => {
    cleanup()
    render(<TeamScreen workspace="office" officePlan="business" />)
    expect([...document.querySelectorAll('article[data-agent]')].every(c => c.getAttribute('data-locked') === 'false')).toBe(true)
  })
})
