'use client'
/**
 * The Agent library (/store/team), ported from the approved design (design-ref/app-agent-library.html): header with
 * how many agents are on, filters by area, a "Build your own agent" card, and one card per agent with its on/off switch.
 * A locked agent shows the plan that unlocks it; clicking that opens an upgrade prompt. Plan gating is the server's
 * (the switch API answers upgrade_required); this screen only explains it. The Office side shows the Office agents
 * of the catalog, gated by the Office plan.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Sheet } from '@/components/ui/Sheet'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, NoStore, useStore } from '@/components/store/bits'
import { css } from '@/components/dp/css'
import { BotMark, BTN_PRIMARY, BTN_SECONDARY } from '@/components/dp/bits'
import { CATALOG, OFFICE_ORDER, isOfficePlan, type OfficePlanKey } from '@/lib/pricing'
import { LEVEL_SHORT, TIER_NAME } from './format'
import type { TeamAgent, TeamResponse, PermissionLevel, TierKey } from './types'

type Area = 'All' | 'Orders' | 'Products' | 'Customers' | 'Marketing' | 'Finance' | 'Store'
const AREAS: Area[] = ['All', 'Orders', 'Products', 'Customers', 'Marketing', 'Finance', 'Store']
/** The design's area and one-line description for each library agent. */
export const AGENT_CARD: Record<string, { area: Exclude<Area, 'All'>; desc: string; name?: string }> = {
  order_tracker: { area: 'Orders', desc: 'Watches every shipment, spots stuck orders and updates customers before they ask.' },
  returns: { area: 'Orders', desc: 'Handles return requests under your policy, issues labels and restocks items.' },
  inventory_watcher: { area: 'Products', desc: 'Predicts stock-outs and drafts reorders with your suppliers.' },
  listing_writer: { area: 'Products', desc: 'Writes and improves product titles, descriptions and SEO in your voice.' },
  supplier_chaser: { area: 'Products', desc: 'Follows up on late purchase orders until you have a ship date.' },
  customer_care: { area: 'Customers', desc: 'Answers customer emails and chats, escalates only what needs you.' },
  campaign: { area: 'Marketing', desc: 'Plans and sends email campaigns to the right customer groups.' },
  promo_manager: { area: 'Marketing', desc: 'Finds slow movers and proposes discounts that protect your margin.' },
  ai_visibility: { area: 'Marketing', desc: 'Gets your products found in AI shopping assistants and Shopify Agentic.' },
  payout_fees_checker: { area: 'Finance', desc: 'Checks every payout and flags fees or chargebacks that look wrong.', name: 'Payout & Fees Checker' },
  weekly_insights: { area: 'Finance', desc: 'Sends a plain-English summary of sales, wins and what to fix.' },
  store_health_checker: { area: 'Store', desc: 'Finds broken links, slow pages and missing info — then fixes them.' },
}
const ORDER = Object.keys(AGENT_CARD)

const FILTER = 'min-height: 44px; padding: 0 16px; border-radius: 999px; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;'
const FILTER_ON = 'background: #4F46E5; color: #FFFFFF; border: 1px solid #4F46E5;'
const FILTER_OFF = 'background: #FFFFFF; color: #3730A3; border: 1px solid #C7D2FE;'
const CARD = 'border: 1px solid #E0E7FF; border-radius: 18px; padding: 22px; display: flex; flex-direction: column; gap: 14px; background: #FFFFFF;'
const LOCK = 'font: inherit; font-size: 12px; font-weight: 700; color: #3730A3; padding: 6px 10px; min-height: 32px; border: 1px solid #C7D2FE; border-radius: 999px; background: #FFFFFF; cursor: pointer; white-space: nowrap;'
const AREA_TAG = "font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #4F46E5;"

function Toggle({ on, name, disabled, onChange }: { on: boolean; name: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={`Turn ${on ? 'off' : 'on'} ${name}`} disabled={disabled} onClick={() => onChange(!on)}
      style={css(`width: 52px; height: 32px; min-width: 52px; border-radius: 999px; border: 0; padding: 3px; display: flex; cursor: pointer; justify-content: ${on ? 'flex-end' : 'flex-start'}; background: ${on ? '#4F46E5' : '#C7D2FE'};${disabled ? ' opacity: 0.6; cursor: default;' : ''}`)}>
      <span aria-hidden style={css('width: 26px; height: 26px; border-radius: 999px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(30,27,75,0.25);')} />
    </button>
  )
}

function AgentCard({ name, desc, area, href, right, testid }: { name: string; desc: string; area: string; href?: string; right: React.ReactNode; testid: Record<string, string> }) {
  return (
    <article style={css(CARD)} {...testid}>
      <div style={css('display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;')}>
        <BotMark size={44} />
        {right}
      </div>
      <div style={css('display: flex; flex-direction: column; gap: 6px;')}>
        <h2 style={css('margin: 0; font-size: 17px; font-weight: 800; color: #1E1B4B;')}>{href ? <Link href={href} style={css('color: inherit; text-decoration: none;')}>{name}</Link> : name}</h2>
        <p style={css('margin: 0; font-size: 14px; line-height: 1.5; color: #3730A3;')}>{desc}</p>
      </div>
      <span style={css(AREA_TAG + ' margin-top: auto;')}>{area}</span>
    </article>
  )
}

type Upgrade = { agent: string; plan: string; href: string } | null

export function TeamScreen({ workspace = 'store', officePlan = null }: { workspace?: 'store' | 'office'; officePlan?: string | null }) {
  if (workspace === 'office') return <OfficeLibrary plan={isOfficePlan(officePlan) ? officePlan : null} />
  return <StoreLibrary />
}

function Header({ onCount }: { onCount: number }) {
  return (
    <header style={css('display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px;')}>
      <div style={css('display: flex; flex-direction: column; gap: 6px; max-width: 640px;')}>
        <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')}>Built by Deploi · one agent for every part of your store</span>
        <h1 style={css('margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: #1E1B4B;')}>Agent library</h1>
        <p style={css('margin: 0; font-size: 15px; line-height: 1.55; color: #3730A3;')}>Switch an agent on and it starts working. Every agent starts with the safest permissions — you widen them.</p>
      </div>
      <span data-testid="agents-on" style={css('font-size: 14px; font-weight: 700; color: #3730A3; padding: 10px 14px; background: #EEF2FF; border-radius: 12px;')}>{onCount} agents on</span>
    </header>
  )
}

function UpgradePrompt({ upgrade, onClose }: { upgrade: Upgrade; onClose: () => void }) {
  return (
    <Sheet open={upgrade !== null} onClose={onClose} title={upgrade ? `${upgrade.agent} is on the ${upgrade.plan} plan` : ''}>
      {upgrade && (
        <div style={css('display: flex; flex-direction: column; gap: 16px;')} data-testid="upgrade-prompt">
          <p style={css('margin: 0; font-size: 15px; line-height: 1.55; color: #3730A3;')}>Upgrade to {upgrade.plan} to switch on {upgrade.agent}. Your agents, instructions and history stay as they are.</p>
          <div style={css('display: flex; flex-wrap: wrap; gap: 10px;')}>
            <Link href={upgrade.href} className="dp-btn" style={css(BTN_PRIMARY)}>See the {upgrade.plan} plan</Link>
            <button type="button" className="dp-btn" onClick={onClose} style={css(BTN_SECONDARY)}>Not now</button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

function Filters({ area, setArea }: { area: Area; setArea: (a: Area) => void }) {
  return (
    <div role="group" aria-label="Filter by area" style={css('display: flex; flex-wrap: wrap; gap: 8px;')}>
      {AREAS.map(a => <button key={a} type="button" aria-pressed={area === a} onClick={() => setArea(a)} style={css(FILTER + (area === a ? FILTER_ON : FILTER_OFF))}>{a}</button>)}
    </div>
  )
}

const GRID = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px;'

function BuildYourOwn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-testid="build-your-own"
      style={css('font: inherit; text-align: left; cursor: pointer; border: 2px dashed #A5B4FC; border-radius: 18px; padding: 22px; background: #F5F7FF; min-height: 200px; display: flex; flex-direction: column; gap: 12px; justify-content: center;')}>
      <span aria-hidden style={css('width: 44px; height: 44px; border-radius: 12px; background: #4F46E5; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700;')}>+</span>
      <span style={css('font-size: 17px; font-weight: 800; color: #1E1B4B;')}>Build your own agent</span>
      <span style={css('font-size: 14px; line-height: 1.5; color: #3730A3;')}>Describe the job in plain words. Deploi sets up the agent, its tools and its permissions.</span>
    </button>
  )
}

function Notice({ notice }: { notice: { tone: 'ok' | 'warn'; text: string } | null }) {
  return <div aria-live="polite">{notice && <p role={notice.tone === 'warn' ? 'alert' : 'status'} style={css(`margin: 0; padding: 12px 16px; border-radius: 12px; font-size: 14px; font-weight: 600; background: ${notice.tone === 'ok' ? '#EEF2FF' : '#FFF1EB'}; color: ${notice.tone === 'ok' ? '#312E81' : '#9A3412'};`)}>{notice.text}</p>}</div>
}

const nextTier = (t: TierKey): TierKey | null => (t === 'starter' ? 'growth' : t === 'growth' ? 'pro' : null)

function StoreLibrary() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<TeamResponse>('/api/store/library'), 'team')
  const [area, setArea] = useState<Area>('All')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [setup, setSetup] = useState<TeamAgent | null>(null)
  const [setupValue, setSetupValue] = useState('')
  const [upgrade, setUpgrade] = useState<Upgrade>(null)
  const [custom, setCustom] = useState<{ name: string; job: string; permission: PermissionLevel } | null>(null)

  if (loading && !data) return <div style={css('display: flex; flex-direction: column; gap: 24px;')}><Header onCount={0} /><Loading label="Loading the agent library" rows={4} /></div>
  if (error && !data) return <div style={css('display: flex; flex-direction: column; gap: 24px;')}><Header onCount={0} />{error.status === 404 ? <NoStore /> : <ErrorState error={error} onRetry={reload} />}</div>
  if (!data) return null

  const nameOf = (a: TeamAgent) => AGENT_CARD[a.key]?.name ?? a.name
  const askUpgrade = (agent: string, to: TierKey | null) => setUpgrade({ agent, plan: to ? TIER_NAME[to] : 'a higher', href: `${base}/plan${to ? `?upgrade=${to}` : ''}` })

  async function flip(a: TeamAgent, on: boolean, settings?: Record<string, unknown>) {
    setBusy(a.key); setNotice(null)
    try {
      await storeFetch(`/api/store/library/${a.key}/switch`, { method: 'POST', body: { enabled: on, settings } })
      setNotice({ tone: 'ok', text: on ? `${nameOf(a)} is on, at ${LEVEL_SHORT[a.permission].toLowerCase()}. Everything it wants to change waits for your approval until you widen its permissions.` : `${nameOf(a)} is off. Its open drafts were closed.` })
      setSetup(null)
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'needs_setup') { setSetup(a); setSetupValue(''); setNotice(null) }
      else if (err.code === 'upgrade_required') askUpgrade(nameOf(a), a.upgradeTo ?? nextTier(data!.tier))
      else setNotice({ tone: 'warn', text: err.message })
    } finally { setBusy(null); await reload() }
  }
  async function createCustom() {
    if (!custom) return
    setBusy('custom'); setNotice(null)
    try { await storeFetch('/api/store/library/custom', { method: 'POST', body: custom }); setNotice({ tone: 'ok', text: `${custom.name} created at "${LEVEL_SHORT[custom.permission]}". Switch it on from its card.` }); setCustom(null) }
    catch (e) {
      const err = asApiError(e)
      if (err.code === 'upgrade_required') { setCustom(null); askUpgrade('Another custom agent', nextTier(data!.tier)) }
      else setNotice({ tone: 'warn', text: (e as StoreApiError).message })
    } finally { setBusy(null); await reload() }
  }
  async function toggleCustom(id: string, enabled: boolean) {
    setBusy(id); try { await storeFetch(`/api/store/library/custom/${id}`, { method: 'PUT', body: { enabled } }) } catch (e) { setNotice({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null); await reload() }
  }

  const agents = [...data.agents].sort((a, b) => (ORDER.indexOf(a.key) + 99) % 99 - (ORDER.indexOf(b.key) + 99) % 99)
  const shown = agents.filter(a => area === 'All' || AGENT_CARD[a.key]?.area === area)
  const customs = data.buildYourOwn.agents
  const onCount = data.agents.filter(a => a.enabled).length + customs.filter(c => c.enabled).length

  return (
    <div style={css('display: flex; flex-direction: column; gap: 24px; min-width: 0;')} data-testid="agent-library">
      <Header onCount={onCount} />
      {!data.store.connected && <NoStore />}
      {!data.onboarding.completedAt && data.store.connected && <p style={css('margin: 0; font-size: 14px; color: #3730A3;')}>Finish setting up: <Link href={`${base}/onboarding`} style={css('color: #4F46E5; font-weight: 700;')}>continue onboarding</Link>.</p>}
      <Notice notice={notice} />
      <Filters area={area} setArea={setArea} />
      <section aria-label="Agents" style={css(GRID)}>
        {area === 'All' && <BuildYourOwn onClick={() => data.buildYourOwn.allowed ? setCustom({ name: '', job: '', permission: 'read' }) : askUpgrade('Build your own agent', nextTier(data.tier))} />}
        {shown.map(a => (
          <AgentCard key={a.key} name={nameOf(a)} desc={AGENT_CARD[a.key]?.desc ?? a.tagline} area={AGENT_CARD[a.key]?.area ?? 'Store'} href={a.locked ? undefined : `${base}/team/${a.key}`}
            testid={{ 'data-agent': a.key, 'data-locked': String(a.locked), 'data-enabled': String(a.enabled) }}
            right={a.locked
              ? <button type="button" style={css(LOCK)} data-upgrade={a.key} aria-label={`${nameOf(a)} needs the ${a.upgradeTo ? TIER_NAME[a.upgradeTo] : 'next'} plan. See the upgrade`} onClick={() => askUpgrade(nameOf(a), a.upgradeTo)}>{a.upgradeTo ? TIER_NAME[a.upgradeTo] : 'Upgrade'} plan</button>
              : <Toggle on={a.enabled} name={nameOf(a)} disabled={busy === a.key || !data.store.connected} onChange={on => void flip(a, on)} />} />
        ))}
        {area === 'All' && customs.map(c => (
          <AgentCard key={c.id} name={c.name} desc={c.job} area="Your own" href={`${base}/team/custom-${c.id}`} testid={{ 'data-custom': c.id, 'data-enabled': String(c.enabled) }}
            right={<Toggle on={c.enabled} name={c.name} disabled={busy === c.id} onChange={on => void toggleCustom(c.id, on)} />} />
        ))}
      </section>

      <UpgradePrompt upgrade={upgrade} onClose={() => setUpgrade(null)} />
      <Sheet open={setup !== null} onClose={() => setSetup(null)} title={setup ? `Set up ${nameOf(setup)}` : ''}>
        {setup && (
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void flip(setup, true, { [setup.needs[0]?.key ?? 'notify']: setupValue }) }}>
            <p className="text-[15px] text-grey">Before it can be switched on, add {setup.needs.map(n => n.label).join(' and ')}.</p>
            <Field label={setup.needs[0]?.label ?? 'Value'} htmlFor="setup-value"><Input id="setup-value" type="email" required value={setupValue} onChange={e => setSetupValue(e.target.value)} placeholder="name@example.com" /></Field>
            <button type="submit" className="dp-btn" disabled={busy !== null} style={css(BTN_PRIMARY)}>{busy ? 'Saving…' : 'Save and switch on'}</button>
          </form>
        )}
      </Sheet>
      <Sheet open={custom !== null} onClose={() => setCustom(null)} title="Build your own agent">
        {custom && (
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void createCustom() }}>
            <Field label="Name" htmlFor="custom-name"><Input id="custom-name" required maxLength={80} value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} placeholder="Late order nudger" /></Field>
            <Field label="The job, in your words" htmlFor="custom-job" hint="It is matched to what the library can do: orders, returns, listings, stock, suppliers, customers, campaigns, discounts, insights, payouts, store health, AI visibility."><Textarea id="custom-job" required maxLength={2000} rows={3} value={custom.job} onChange={e => setCustom({ ...custom, job: e.target.value })} placeholder="Every morning, tell me which orders are late and draft a note to each customer." /></Field>
            <fieldset className="flex flex-col gap-2"><legend className="text-[14px] text-ink">Permission level</legend>
              <div className="au-level" role="group" aria-label="Permission level">{(['read', 'draft', 'act'] as PermissionLevel[]).map(l => <button key={l} type="button" aria-pressed={custom.permission === l} onClick={() => setCustom({ ...custom, permission: l })}>{LEVEL_SHORT[l]}</button>)}</div>
              <span className="text-[12px] text-grey-h">Starts at read only, the most restrictive. Widening it later is logged as a grant.</span>
            </fieldset>
            <button type="submit" className="dp-btn" disabled={busy !== null} style={css(BTN_PRIMARY)}>{busy === 'custom' ? 'Creating…' : 'Create agent'}</button>
          </form>
        )}
      </Sheet>
    </div>
  )
}

const OFFICE_AREA: Record<string, string> = { lead_responder: 'Customers', invoice_runner: 'Finance', crm_followup: 'Customers', owner_updates: 'Office', dispatch_coordinator: 'Jobs', books_reconciler: 'Finance' }
const OFFICE_NAME: Record<OfficePlanKey, string> = { solo: 'Solo', team: 'Team', business: 'Business' }

/** The Office side: the catalog's Office agents, unlocked by the Office plan (Solo, Team, Business). */
function OfficeLibrary({ plan }: { plan: OfficePlanKey | null }) {
  const [upgrade, setUpgrade] = useState<Upgrade>(null)
  const rank = plan ? OFFICE_ORDER.indexOf(plan) : -1
  const list = CATALOG.office.agentCatalog
  const unlocked = list.filter(a => OFFICE_ORDER.indexOf(a.minPlan) <= rank)
  return (
    <div style={css('display: flex; flex-direction: column; gap: 24px; min-width: 0;')} data-testid="agent-library" data-workspace="office">
      <Header onCount={unlocked.length} />
      {!plan && <p style={css('margin: 0; font-size: 14px; color: #3730A3;')}>No Office plan yet. <Link href="/store/plan?suite=office" style={css('color: #4F46E5; font-weight: 700;')}>Choose Solo, Team or Business</Link> to switch these on.</p>}
      <section aria-label="Office agents" style={css(GRID)}>
        <BuildYourOwn onClick={() => setUpgrade({ agent: 'Build your own agent', plan: 'Solo', href: '/store/plan?suite=office' })} />
        {list.map(a => {
          const open = OFFICE_ORDER.indexOf(a.minPlan) <= rank
          return (
            <AgentCard key={a.key} name={a.name} desc={a.job} area={OFFICE_AREA[a.key] ?? 'Office'} testid={{ 'data-agent': a.key, 'data-locked': String(!open) }}
              right={open ? <span style={css('font-size: 12px; font-weight: 700; padding: 6px 10px; border-radius: 999px; background: #EEF2FF; color: #3730A3;')}>Included</span>
                : <button type="button" style={css(LOCK)} data-upgrade={a.key} onClick={() => setUpgrade({ agent: a.name, plan: OFFICE_NAME[a.minPlan], href: `/store/plan?suite=office&upgrade=${a.minPlan}` })}>{OFFICE_NAME[a.minPlan]} plan</button>} />
          )
        })}
      </section>
      <UpgradePrompt upgrade={upgrade} onClose={() => setUpgrade(null)} />
    </div>
  )
}
