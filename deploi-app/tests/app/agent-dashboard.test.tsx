// @vitest-environment jsdom
/**
 * The agent dashboard (/agents/:id, components/app/agent) in a DOM, wired to the real /api/app route handlers and
 * the real database: the browser's fetch is answered by the route handlers (with an embedded Shopify session
 * token, as the API tests do), so every click goes UI -> API -> database, and a "reload" renders a fresh
 * dashboard read back from the database. Covers the autonomy level (saved, persisted, shown after reload), the
 * money-guard note and a money action that still waits under "Fully autonomous", standing instructions
 * add/edit/delete, pause/resume through the server action, the voice fallback, chat, empty states and the 404.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { NW, resetMerchant, merchantActor } from '../merchant/helpers'
import { registerPackAgents } from '../../lib/packs/registry'
import { runAgentLoop, type LoopSpec } from '../../lib/events/loop'
import type { AgentDashboard as Dashboard, ChatMessage } from '../../lib/app/contract'
import type { Session } from '../../lib/session'
import { GET as agentGet } from '../../app/api/app/agents/[id]/route'
import { POST as autonomyPost } from '../../app/api/app/agents/[id]/autonomy/route'
import { GET as instrGet, POST as instrPost } from '../../app/api/app/agents/[id]/instructions/route'
import { PATCH as instrPatch, DELETE as instrDelete } from '../../app/api/app/agents/[id]/instructions/[instructionId]/route'
import { GET as chatGet, POST as chatPost } from '../../app/api/app/agents/[id]/chat/route'
import { POST as needsPost } from '../../app/api/app/needs-you/[id]/route'
import { captureNotify, releaseNotify, cleanW1 } from '../autonomy/helpers'

// the server page and the pause action read the cookie session: give them the seeded owner's
const auth = vi.hoisted(() => ({ session: null as Session | null }))
vi.mock('@/lib/auth', async importOriginal => {
  const real = await importOriginal<typeof import('../../lib/auth')>()
  return { ...real, getSession: async () => auth.session, requireRole: async () => auth.session }
})
const { AgentDashboard } = await import('../../components/app/agent/AgentDashboard')
const { MONEY_NOTE } = await import('../../components/app/agent/AutonomyCard')
const { default: AgentPage } = await import('../../app/agents/[id]/page')
const { default: AgentNotFound } = await import('../../app/agents/[id]/not-found')

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!
const STORE = 'store:inventory_watcher'
const PKEY = 'ui_money_fixer'
const PACK = `pack:${PKEY}`
registerPackAgents([{ key: PKEY, name: 'Ledger Test', pack: 'home_services', job: 'Fixes test ledgers.', triggers: ['sweep'], actions: ['update_record'], status: 'working', shopifyReady: false }])

// ---------------------------------------------------------------- fetch -> the real route handlers
type Ctx = { params: Promise<Record<string, string>> }
const ctx = (p: Record<string, string>): Ctx => ({ params: Promise.resolve(p) })
const calls: string[] = []
async function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost')
  const method = (init?.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.pathname}`)
  const req = new Request(url, {
    method, body: init?.body as BodyInit | undefined,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signSessionToken({ dest: `https://${NW.domain}`, sub: '7' }, SECRET, KEY)}` },
  })
  const p = url.pathname
  let m: RegExpMatchArray | null
  if ((m = p.match(/^\/api\/app\/agents\/([^/]+)\/instructions\/([^/]+)$/))) return (method === 'PATCH' ? instrPatch : instrDelete)(req, ctx({ id: m[1], instructionId: m[2] }) as never)
  if ((m = p.match(/^\/api\/app\/agents\/([^/]+)\/instructions$/))) return (method === 'POST' ? instrPost : instrGet)(req, ctx({ id: m[1] }) as never)
  if ((m = p.match(/^\/api\/app\/agents\/([^/]+)\/autonomy$/))) return autonomyPost(req, ctx({ id: m[1] }) as never)
  if ((m = p.match(/^\/api\/app\/agents\/([^/]+)\/chat$/))) return (method === 'POST' ? chatPost : chatGet)(req, ctx({ id: m[1] }) as never)
  if ((m = p.match(/^\/api\/app\/agents\/([^/]+)$/))) return agentGet(req, ctx({ id: m[1] }) as never)
  if ((m = p.match(/^\/api\/app\/needs-you\/([^/]+)$/))) return needsPost(req, ctx({ id: m[1] }) as never)
  return new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404 })
}
const getJson = async <T,>(path: string) => (await (await routeFetch(path)).json()) as T
const dashboard = async (id: string) => (await getJson<{ dashboard: Dashboard }>(`/api/app/agents/${encodeURIComponent(id)}`)).dashboard
const history = async (id: string) => (await getJson<{ messages: ChatMessage[] }>(`/api/app/agents/${encodeURIComponent(id)}/chat`)).messages
/** a page load: read the dashboard and the chat history back from the database and render them */
async function load(id: string) { cleanup(); return render(<AgentDashboard initial={await dashboard(id)} history={await history(id)} />) }

// ---------------------------------------------------------------- the pack agent's loop (a money action and a plain one)
const broken = new Set<string>()
let acts = 0
const spec = (problemKey: string, actionType: string): LoopSpec<{ k: string }> => ({
  orgId: NW.org, agentKey: PKEY, agentName: 'Ledger Test', actionType, problemKey,
  detect: async () => (broken.has(problemKey) ? { k: problemKey } : null),
  describe: p => ({ title: `Ledger ${p.k} needs a refund`, whatHappened: `Ledger ${p.k} was charged twice.`, whatIDid: [`Refund ledger ${p.k}.`] }),
  act: async (_db, p) => { acts++; broken.delete(p.k); return { proof: [{ label: 'Changed', value: `${p.k}: fixed` }] } },
  verify: async (_db, p) => ({ ok: !broken.has(p.k), proof: [{ label: 'Fresh read', value: 'right' }] }),
})

const profile = (ref: string) => admin(db => db.one<{ autonomy: string; paused_at: string | null }>('select autonomy, paused_at from agent_profiles where org_id = $1 and agent_ref = $2', [NW.org, ref]))
const instructions = (ref: string) => admin(db => db.query<{ text: string }>('select text from agent_instructions where org_id = $1 and agent_ref = $2 order by position, created_at', [NW.org, ref]))
let savedPacks: Record<string, unknown> | null = null
async function clean() {
  await admin(async db => {
    for (const t of ['agent_profiles', 'agent_instructions', 'agent_chat_messages']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
    await db.query(`delete from library_auto_run_grants where org_id = $1 and agent_key = 'inventory_watcher'`, [NW.org])
    await db.query(`delete from library_switches where org_id = $1 and agent_key = 'inventory_watcher' and engine_agent_id is null`, [NW.org])
    await db.query(`delete from cases where org_id = $1 and kind = 'agent_action'`, [NW.org])
  })
}

describe.skipIf(!ready)('agent dashboard UI (DOM -> /api/app -> database)', () => {
  const realFetch = globalThis.fetch
  beforeAll(async () => {
    await resetMerchant(NW)
    savedPacks = await admin(db => db.one<Record<string, unknown>>('select * from pack_settings where org_id = $1', [NW.org]))
    await admin(db => db.query(`insert into pack_settings (org_id, business_type, packs, updated_by) values ($1, 'home_services', '{home_services}', 'test')
      on conflict (org_id) do update set business_type = 'home_services', packs = '{home_services}'`, [NW.org]))
    const owner = await merchantActor(NW)
    auth.session = owner.kind === 'profile' ? owner.session : null
    globalThis.fetch = routeFetch as typeof fetch
  })
  beforeEach(async () => { await cleanW1(); await clean(); broken.clear(); acts = 0; calls.length = 0; captureNotify() })
  afterEach(() => { cleanup(); releaseNotify() })
  afterAll(async () => {
    globalThis.fetch = realFetch
    await cleanW1(); await clean()
    await admin(async db => {
      await db.query('delete from pack_settings where org_id = $1', [NW.org])
      if (savedPacks) await db.query(`insert into pack_settings (org_id, business_type, packs, trade, settings, updated_by, source) values ($1,$2,$3,$4,$5,$6,$7)`,
        [NW.org, savedPacks.business_type, savedPacks.packs, savedPacks.trade, JSON.stringify(savedPacks.settings ?? {}), savedPacks.updated_by, savedPacks.source ?? 'owner'])
    })
  })

  it('renders the real agent: header, four stats, scopes with their level words, back link to the command center', async () => {
    await load(STORE)
    expect(screen.getByRole('heading', { level: 1, name: 'Inventory Watcher' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Command center/ }).getAttribute('href')).toBe('/store')
    expect(within(screen.getByRole('list', { name: 'This agent in numbers' })).getAllByRole('listitem').map(li => li.firstChild?.textContent))
      .toEqual(['Products watched', 'Sell-outs prevented (30 days)', 'Time saved this week', 'Actions used this month'])
    const scopes = within(screen.getByRole('list', { name: 'What it can touch' })).getAllByRole('listitem').map(li => li.textContent)
    expect(scopes).toEqual(expect.arrayContaining(['Read your store· read', 'Reorder stock from a supplier· ask first']))
    expect(screen.getByRole('button', { name: 'Pause agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Call this agent/ })).toBeTruthy()
    for (const name of [/Message Inventory Watcher/, /Speak to Inventory Watcher/, /Send message/]) expect(screen.getAllByLabelText(name).length).toBeGreaterThan(0)
  })

  it('autonomy: choosing a level saves it through the API, it is persisted, and a reload shows it', async () => {
    await load(STORE)
    const group = screen.getByRole('group', { name: 'How much can it do alone?' })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(3)
    expect(group.textContent).toContain('Spots issues, drafts the fix, waits for you.')
    expect(group.textContent).toContain('Fixes small things, texts you a summary.')
    expect(group.textContent).toContain('Handles everything inside its limits.')
    fireEvent.click(within(group).getByRole('radio', { name: /Ask first/ }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(calls).toContain(`POST /api/app/agents/${encodeURIComponent(STORE)}/autonomy`)
    expect(await profile(STORE)).toMatchObject({ autonomy: 'ask_first' })

    await load(STORE)
    expect((screen.getByRole('radio', { name: /Ask first/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: /Fully autonomous/ }) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /Fully autonomous/ }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(await profile(STORE)).toMatchObject({ autonomy: 'autonomous' })
    await load(STORE)
    expect((screen.getByRole('radio', { name: /Fully autonomous/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('autonomy: a refused save says so and keeps the saved level selected', async () => {
    await load(STORE)
    const before = (screen.getAllByRole('radio') as HTMLInputElement[]).find(r => r.checked)!.value
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).endsWith('/autonomy')
      ? new Response(JSON.stringify({ ok: false, error: 'forbidden', message: 'no' }), { status: 403 }) : routeFetch(i, init))) as typeof fetch
    try {
      fireEvent.click(screen.getByRole('radio', { name: before === 'ask_first' ? /Fully autonomous/ : /Ask first/ }))
      await waitFor(() => expect(screen.getByText(/^Not saved: Only owners and admins can change this\./)).toBeTruthy())
      expect((screen.getAllByRole('radio') as HTMLInputElement[]).find(r => r.checked)!.value).toBe(before)
    } finally { globalThis.fetch = routeFetch as typeof fetch }
  })

  it('money guard: the note is shown, and under "Fully autonomous" a money action still waits for the owner (shown as waiting)', async () => {
    await load(PACK)
    expect(screen.getByText(MONEY_NOTE)).toBeTruthy()
    expect(MONEY_NOTE).toBe('Anything that spends money always asks first, on every level.')
    fireEvent.click(screen.getByRole('radio', { name: /Fully autonomous/ }))
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(await profile(PACK)).toMatchObject({ autonomy: 'autonomous' })

    broken.add('ui:money')
    expect(await admin(db => runAgentLoop(db, spec('ui:money', 'refund')))).toMatchObject({ status: 'waiting_for_owner' })
    expect(acts).toBe(0)

    await load(PACK)
    expect((screen.getByRole('radio', { name: /Fully autonomous/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Waiting on you')).toBeTruthy()
    expect(screen.getByTestId('doing-now').textContent).toBe('Waiting for you: Ledger ui:money needs a refund')
    const row = within(screen.getByRole('table')).getByText('Ledger ui:money needs a refund').closest('tr')!
    expect(row.textContent).toContain('Waiting for you')
    expect(within(row).getByRole('link').getAttribute('href')).toMatch(/^\/store\/work\//)
    // its own (non-money) action acts under "Fully autonomous"; the refund above still waited
    expect(within(screen.getByRole('list', { name: 'What it can touch' })).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Update record· acts'])

    // the chat offers the decision inline; declining goes through POST /api/app/needs-you/:id and nothing moves
    fireEvent.change(screen.getByLabelText('Message Ledger Test'), { target: { value: 'anything that needs me?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    const decline = await screen.findByRole('button', { name: 'Decline' })
    fireEvent.click(decline)
    await waitFor(() => expect(screen.getByText(/^Declined: Decline/)).toBeTruthy())
    expect(calls.some(c => c.startsWith('POST /api/app/needs-you/'))).toBe(true)
    expect(acts).toBe(0)
  })

  it('standing instructions: add, edit and delete inline through the API', async () => {
    await load(STORE)
    expect(screen.getByText('No standing instructions yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a standing instruction for Inventory Watcher' }))
    fireEvent.change(screen.getByLabelText('New instruction for Inventory Watcher'), { target: { value: 'Never reorder candles' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save instruction' }))
    await screen.findByRole('button', { name: 'Edit instruction: Never reorder candles' })
    expect(await instructions(STORE)).toEqual([{ text: 'Never reorder candles' }])

    fireEvent.click(screen.getByRole('button', { name: 'Edit instruction: Never reorder candles' }))
    fireEvent.change(screen.getByLabelText('Edit instruction 1'), { target: { value: 'Never reorder candles in July' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Edit instruction: Never reorder candles in July' })
    expect(await instructions(STORE)).toEqual([{ text: 'Never reorder candles in July' }])

    await load(STORE)
    expect(screen.getByText('Never reorder candles in July')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete instruction: Never reorder candles in July' }))
    await screen.findByText('No standing instructions yet')
    expect(await instructions(STORE)).toEqual([])
    expect(calls.filter(c => /instructions/.test(c)).map(c => c.split(' ')[0])).toEqual(['POST', 'PATCH', 'DELETE'])
  })

  it('standing instructions: an empty one is not sent; an API refusal is shown', async () => {
    await load(STORE)
    fireEvent.click(screen.getByRole('button', { name: /Add a standing instruction/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save instruction' }))
    await screen.findByText('Write the instruction first.')
    expect(calls.some(c => c.startsWith('POST') && c.endsWith('/instructions'))).toBe(false)
  })

  it('empty states: no chat history gives a greeting from the real status (nothing stored), no work, no instructions', async () => {
    await load(PACK)
    const greeting = document.querySelector('[data-greeting]')!
    const doing = screen.getByTestId('doing-now').textContent!
    expect(greeting.textContent).toBe(`Hi, I'm Ledger Test. ${doing}. Ask me how things are, what I did today or what needs you, or tell me to pause.`)
    expect(screen.getByText('No work yet — finished work shows here with its proof')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('No standing instructions yet')).toBeTruthy()
    expect(await history(PACK)).toEqual([])
  })

  it('chat: a message goes to the agent and its answer comes back from real data; history shows on reload', async () => {
    await load(STORE)
    fireEvent.change(screen.getByLabelText('Message Inventory Watcher'), { target: { value: 'status' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText(/^Inventory Watcher: /)
    await load(STORE)
    expect(document.querySelector('[data-greeting]')).toBeNull()
    expect(screen.getByText('status')).toBeTruthy()
    expect(screen.getByText(/^Inventory Watcher: /)).toBeTruthy()
  })

  it('"Call this agent" without browser speech falls back to text and says so', async () => {
    await load(STORE)
    fireEvent.click(screen.getByRole('button', { name: /Call this agent/ }))
    expect(screen.getByText('Voice is not available in this browser, so you can type to Inventory Watcher instead.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Message Inventory Watcher'))
  })

  it('pause and resume are real (server action): the agent is paused, then back on', async () => {
    await load(PACK)
    fireEvent.click(screen.getByRole('button', { name: 'Pause agent' }))
    await screen.findByRole('button', { name: 'Resume agent' })
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByTestId('doing-now').textContent).toBe('Paused by you')
    expect((await profile(PACK))!.paused_at).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume agent' }))
    await screen.findByRole('button', { name: 'Pause agent' })
    expect((await profile(PACK))!.paused_at).toBeNull()
  })

  it('404: an unknown or malformed agent id renders the not-found page', async () => {
    for (const id of [encodeURIComponent('pack:nobody_here'), encodeURIComponent('office:00000000-0000-0000-0000-000000000000'), 'garbage', '%E0%A4%A']) {
      await expect(AgentPage({ params: Promise.resolve({ id }) }), id).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/) })
    }
    const page = await AgentPage({ params: Promise.resolve({ id: encodeURIComponent(STORE) }) })
    cleanup(); render(page)
    expect(screen.getByRole('heading', { level: 1, name: 'Inventory Watcher' })).toBeTruthy()
    cleanup(); render(<AgentNotFound />)
    expect(screen.getByRole('heading', { level: 1, name: 'Agent not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the command center' }).getAttribute('href')).toBe('/store')
  })
})
