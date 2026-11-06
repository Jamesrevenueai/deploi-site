// @vitest-environment jsdom
/**
 * The Command center (components/app/command/CommandCenter.tsx) rendered from the real CommandCenter of the
 * database: it shows only what the feeds hold (one card, row and team line per item, the hero's own numbers, proof
 * chips linking to the actual proof), honest empty states with zero rows for a fresh organization, the
 * needs-you approve and decline from the card through POST /api/app/needs-you/:id (the item then leaves "Needs you"
 * and the approved one shows up done with its proof), a search that only filters what is loaded, and the sidebar's
 * workspace, counts and allowance (lib/app/shell.ts, components/app/Usage.tsx).
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import type { Actor } from '../../lib/engine/actor'
import type { CommandCenter as Data } from '../../lib/app/contract'
import { commandCenter, setAgentAutonomy } from '../../lib/app/contract'
import { runAgentLoop, registerLoopResumer, LOOP_RESUME_JOB, type LoopSpec } from '../../lib/events/loop'
import { registerPackAgents } from '../../lib/packs/registry'
import { runDueJobs } from '../../lib/jobs'
import '../../lib/cases/jobs'
import { NW, merchantActor, resetMerchant } from '../merchant/helpers'
import { captureNotify, releaseNotify, cleanW1 } from '../autonomy/helpers'
import { routeFetch } from './ui-helpers'

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/store', redirect: (to: string) => { throw new Error(`redirect ${to}`) } }))
const { CommandCenter } = await import('../../components/app/command/CommandCenter')
const { Usage, usageText } = await import('../../components/app/Usage')
const { workspaceSources, loadShell } = await import('../../lib/app/shell')

const ready = await prepareDb()
const NOW = '2026-11-06T15:00:00.000Z'
const show = (data: Data) => render(<CommandCenter data={data} now={NOW} timeZone="America/New_York" />)

// a pack agent that waits for the owner (ask_first), as in tests/app/redesign.test.ts
const KEY = 'ui_fixer'
const REF = `pack:${KEY}`
registerPackAgents([{ key: KEY, name: 'UI Fixer', pack: 'home_services', job: 'Fixes test records.', triggers: ['sweep'], actions: ['update_record'], status: 'working', shopifyReady: false }])
const broken = new Set<string>()
const spec = (k: string): LoopSpec<{ k: string }> => ({
  orgId: NW.org, agentKey: KEY, agentName: 'UI Fixer', actionType: 'update_record', problemKey: k,
  detect: async () => (broken.has(k) ? { k } : null),
  describe: p => ({ title: `Record ${p.k} is wrong`, whatHappened: `Record ${p.k} shows the wrong value.`, whatIDid: [`Set record ${p.k} back.`] }),
  act: async (_db, p) => { broken.delete(p.k); return { proof: [{ label: 'Changed', value: `${p.k}: fixed` }] } },
  verify: async (_db, p) => ({ ok: !broken.has(p.k), proof: [{ label: `Fresh read of ${p.k}`, value: broken.has(p.k) ? 'wrong' : 'right' }] }),
})
registerLoopResumer(KEY, async r => (r.problemKey.startsWith('ui:') ? spec(r.problemKey) : null))

const cleanApp = () => admin(async db => {
  for (const t of ['agent_profiles', 'agent_instructions', 'app_workspace_prefs', 'agent_chat_messages']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
  await db.query(`delete from cases where org_id = $1 and kind = 'agent_action'`, [NW.org])
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); router.refresh.mockClear() })

describe.skipIf(!ready)('Command center: only real data', () => {
  let owner: Actor
  beforeAll(async () => { await resetMerchant(NW); await cleanApp(); owner = await merchantActor(NW) })

  it('renders one line per agent, done item and request of the feeds, the hero numbers as read, and links to the real pages', async () => {
    const data = await commandCenter(owner, 'store')
    expect(data.team.length).toBeGreaterThan(0)
    show(data)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Good morning. Your team is on it.') // 10:00 in New York
    expect(screen.getByText(/Friday, November 6 · Store/)).toBeTruthy()
    // the team: exactly the feed's agents, in order, each with its status pill, its line, today's count and its page
    const rows = screen.queryAllByTestId('team-row')
    expect(rows).toHaveLength(data.team.length)
    data.team.forEach((a, i) => {
      const row = within(rows[i])
      expect(rows[i].querySelector('.cc-agent-name')?.textContent).toBe(a.name)
      expect(rows[i].querySelector('.cc-agent-area')?.textContent).toBe(a.area)
      expect(rows[i].querySelectorAll('td')[2].textContent).toBe(a.doingNow)
      expect(row.getByText(`${a.todayActions} ${a.todayActions === 1 ? 'action' : 'actions'}`)).toBeTruthy()
      expect(rows[i].querySelector(`[data-status="${a.status}"]`)).toBeTruthy()
      expect(row.getByRole('link', { name: `Open ${a.name}` }).getAttribute('href')).toBe(`/agents/${encodeURIComponent(a.id)}`)
    })
    // the table scrolls inside its own labelled box
    const box = screen.getByTestId('team-table')
    expect(box.getAttribute('role')).toBe('region')
    expect(box.getAttribute('aria-label')).toBe('Your team')
    expect(box.className).toBe('app-table-wrap')
    expect((box.querySelector('table') as HTMLTableElement).style.minWidth).toBe('780px')
    // done and needs-you: as many as the feeds hold, no more
    expect(screen.queryAllByTestId('done-row')).toHaveLength(data.doneWithProof.length)
    expect(screen.queryAllByTestId('needs-you-card')).toHaveLength(data.needsYou.length)
    for (const d of data.doneWithProof) expect(screen.getAllByRole('link', { name: new RegExp(`^Proof: ${d.proof.label.replace(/[/()]/g, '.')}`) }).some(l => l.getAttribute('href') === d.proof.href)).toBe(true)
    // the hero says what hero() says
    const hero = within(screen.getByTestId('hero'))
    expect(hero.getByText(new RegExp(`^${data.hero.agentsRunning} agents? running`))).toBeTruthy()
    expect(hero.getByText(new RegExp(`handled ${data.hero.handledSinceYesterday} things? since yesterday`))).toBeTruthy()
    const tiles = screen.getByTestId('hero').querySelectorAll('dd')
    expect(tiles[1].textContent).toBe(String(data.hero.fixedOnTheirOwn))
    expect(tiles[2].textContent).toBe(String(data.hero.needYouCount))
    expect(screen.getByRole('link', { name: 'Full proof log' }).getAttribute('href')).toBe('/store/completed')
    expect(screen.getByRole('link', { name: 'Build a custom agent' }).getAttribute('href')).toBe('/store/agents/new')
    expect(screen.getByRole('link', { name: 'Browse library' }).getAttribute('href')).toBe('/store/team')
  })

  it('search filters what is loaded and never makes up results', async () => {
    const data = await commandCenter(owner, 'store')
    show(data)
    const search = screen.getByRole('searchbox', { name: 'Search agents, orders, proof' })
    const first = data.team[0]
    fireEvent.change(search, { target: { value: first.name } })
    const rows = screen.queryAllByTestId('team-row')
    expect(rows.length).toBe(data.team.filter(a => [a.name, a.area, a.doingNow, a.job].some(x => x.toLowerCase().includes(first.name.toLowerCase()))).length)
    expect(rows[0].querySelector('.cc-agent-name')?.textContent).toBe(first.name)
    fireEvent.change(search, { target: { value: 'zzqx no such thing' } })
    expect(screen.queryAllByTestId('team-row')).toHaveLength(0)
    expect(screen.getByText('No agents match “zzqx no such thing”')).toBeTruthy()
  })

  it('the sidebar reads the connected store, the counts of this side and the real allowance', async () => {
    expect(await workspaceSources(NW.org, 'store')).toEqual({ name: expect.any(String), sources: ['Shopify'] })
    const shell = await loadShell(owner as Extract<Actor, { kind: 'profile' }>)
    const cc = await commandCenter(owner, shell.workspace)
    expect(shell).toMatchObject({ workspace: 'store', needsYouCount: cc.needsYou.length, agentCount: cc.team.length, allowance: cc.allowance })
    render(<Usage allowance={{ used: 12, limit: null, planName: 'Free beta', resetsAt: '2026-12-01T00:00:00.000Z', enforced: false }} />)
    expect(screen.getByText('12 used · no monthly limit')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('Free beta · resets Dec 1')).toBeTruthy()
    cleanup()
    render(<Usage allowance={{ used: 300, limit: 1200, planName: 'Growth', resetsAt: '2026-12-01T00:00:00.000Z', enforced: true }} />)
    expect(screen.getByText('300 of 1,200')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Actions used' }).getAttribute('aria-valuenow')).toBe('25')
    expect(usageText({ used: 0, limit: null, planName: 'x', resetsAt: NOW, enforced: false })).toBe('0 used · no monthly limit')
  })
})

describe.skipIf(!ready)('Command center: a fresh organization', () => {
  const ORG = uuidFrom('org:redesign-ui:fresh')
  const UID = uuidFrom('user:redesign-ui:fresh')
  const EMAIL = 'owner@redesign-ui-fresh.example'
  const actor: Actor = { kind: 'profile', session: { uid: UID, email: EMAIL, role: 'client', agencyId: ORG, orgType: 'merchant' }, orgId: ORG, label: `user:${EMAIL}` }
  beforeAll(() => admin(async db => {
    await db.query(`insert into agencies (id, name, state, org_type) values ($1, 'Fresh UI Co', '', 'merchant') on conflict (id) do nothing`, [ORG])
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [UID, EMAIL])
    await db.query(`insert into profiles (id, email, role, agency_id, org_role) values ($1,$2,'client',$3,'owner') on conflict (id) do update set agency_id = excluded.agency_id, org_role = 'owner'`, [UID, EMAIL, ORG])
  }))
  afterAll(() => admin(async db => { await db.query('delete from auth.users where id = $1', [UID]); await db.query('delete from agencies where id = $1', [ORG]) }))

  for (const ws of ['store', 'office'] as const) {
    it(`${ws}: honest empty states and zero rows`, async () => {
      const data = await commandCenter(actor, ws)
      show(data)
      expect(screen.getByTestId('needs-empty').textContent).toMatch(/^Nothing needs you right now/)
      expect(screen.getByTestId('done-empty').textContent).toBe('No finished work yetProof shows up here as your agents work.')
      expect(screen.getByTestId('team-empty').textContent).toMatch(/^No agents yet/)
      for (const id of ['needs-you-card', 'done-row', 'team-row']) expect(screen.queryAllByTestId(id)).toHaveLength(0)
      expect(screen.queryByTestId('team-table')).toBeNull()
      const hero = screen.getByTestId('hero')
      expect(hero.textContent).toContain('0 agents running · no check yet')
      expect(hero.textContent).toContain('Your agents handled 0 things since yesterday. Nothing needs a yes from you.')
      expect(hero.textContent).not.toContain('Nobody had to ask')
      expect([...hero.querySelectorAll('dd')].map(d => d.textContent)).toEqual(['0 min', '0', '0'])
      expect(screen.getByTestId('command-center').getAttribute('data-workspace')).toBe(ws)
    })
  }
  it('names the organization and says nothing is connected', async () => {
    expect(await workspaceSources(ORG, 'store')).toEqual({ name: 'Fresh UI Co', sources: [] })
    expect(await workspaceSources(ORG, 'office')).toEqual({ name: 'Fresh UI Co', sources: [] })
  })
})

describe.skipIf(!ready)('Command center: deciding what needs you from the card', () => {
  let owner: Actor
  let savedPacks: Record<string, unknown> | null = null
  beforeAll(async () => {
    savedPacks = await admin(db => db.one<Record<string, unknown>>('select * from pack_settings where org_id = $1', [NW.org]))
    await admin(db => db.query(`insert into pack_settings (org_id, business_type, packs, updated_by) values ($1, 'home_services', '{home_services}', 'test')
      on conflict (org_id) do update set business_type = 'home_services', packs = '{home_services}'`, [NW.org]))
    owner = await merchantActor(NW)
  })
  beforeEach(async () => { await cleanW1(); await cleanApp(); captureNotify(); broken.clear() })
  afterAll(async () => {
    releaseNotify(); await cleanW1(); await cleanApp()
    await admin(async db => {
      await db.query('delete from pack_settings where org_id = $1', [NW.org])
      if (savedPacks) await db.query(`insert into pack_settings (org_id, business_type, packs, trade, settings, updated_by, source) values ($1,$2,$3,$4,$5,$6,$7)`,
        [NW.org, savedPacks.business_type, savedPacks.packs, savedPacks.trade, JSON.stringify(savedPacks.settings ?? {}), savedPacks.updated_by, savedPacks.source ?? 'owner'])
    })
  })

  async function waiting(k: string) {
    broken.add(k)
    await setAgentAutonomy(owner, REF, 'ask_first')
    expect(await admin(db => runAgentLoop(db, spec(k)))).toMatchObject({ status: 'waiting_for_owner' })
    const data = await commandCenter(owner, 'office')
    const item = data.needsYou.find(i => i.agent.id === REF && i.title === `Record ${k} is wrong`)!
    expect(item).toBeTruthy()
    return { data, item }
  }

  it('approve: the card posts the decision to the route, the page refreshes, the item leaves Needs you and shows up done with its proof', async () => {
    const { data, item } = await waiting('ui:1')
    const rf = routeFetch(NW.domain); vi.stubGlobal('fetch', rf.fetchMock)
    show(data)
    const card = screen.getAllByTestId('needs-you-card').find(c => c.textContent?.includes('Record ui:1 is wrong'))!
    expect(within(card).getByText('UI Fixer')).toBeTruthy()
    expect(within(card).getByText(item.explanation)).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Reply to UI Fixer' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: item.primaryAction }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(rf.calls).toEqual([{ method: 'POST', path: `/api/app/needs-you/${encodeURIComponent(item.id)}`, body: { decision: 'approve' } }])
    await runDueJobs({ kinds: [LOOP_RESUME_JOB] })
    expect(broken.has('ui:1')).toBe(false)
    // after the refresh: gone from the left column, in the right one with the proof of the case
    cleanup()
    const after = await commandCenter(owner, 'office')
    expect(after.needsYou.some(i => i.id === item.id)).toBe(false)
    show(after)
    expect(screen.queryAllByTestId('needs-you-card').some(c => c.textContent?.includes('Record ui:1 is wrong'))).toBe(false)
    const row = screen.getAllByTestId('done-row').find(r => r.textContent?.includes('Record ui:1 is wrong'))!
    expect(within(row).getByRole('link', { name: /^Proof: Before \/ after/ }).getAttribute('href')).toBe(`/store/work/${item.caseRef}`)
  })

  it('decline: the secondary button declines; nothing is done and it is not shown as done', async () => {
    const { data, item } = await waiting('ui:2')
    const rf = routeFetch(NW.domain); vi.stubGlobal('fetch', rf.fetchMock)
    show(data)
    const card = screen.getAllByTestId('needs-you-card').find(c => c.textContent?.includes('Record ui:2 is wrong'))!
    fireEvent.click(within(card).getByRole('button', { name: item.secondaryAction! }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(rf.calls.at(-1)).toEqual({ method: 'POST', path: `/api/app/needs-you/${encodeURIComponent(item.id)}`, body: { decision: 'decline' } })
    expect(broken.has('ui:2')).toBe(true)
    const after = await commandCenter(owner, 'office')
    expect(after.needsYou.some(i => i.id === item.id)).toBe(false)
    expect(after.doneWithProof.some(d => d.what === 'Record ui:2 is wrong')).toBe(false)
  })

  it('a refused decision stays on the card and says why', async () => {
    const { data, item } = await waiting('ui:3')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'forbidden', message: 'your role cannot approve this' }), { status: 403 })))
    show(data)
    const card = screen.getAllByTestId('needs-you-card').find(c => c.textContent?.includes('Record ui:3 is wrong'))!
    fireEvent.click(within(card).getByRole('button', { name: item.primaryAction }))
    expect((await within(card).findByRole('alert')).textContent).toBe('your role cannot approve this')
    expect(router.refresh).not.toHaveBeenCalled()
    expect((await commandCenter(owner, 'office')).needsYou.some(i => i.id === item.id)).toBe(true)
  })
})
