'use client'
/**
 * The team dashboard (/store/team): every library agent as a card with its bot character and on/off
 * switch, locked agents with the tier that unlocks them, this week's time and money saved, the usage
 * meter against the plan's allowance, and (Pro) the merchant's own agents.
 */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, NoStore, useStore } from '@/components/store/bits'
import { Character } from './Character'
import { Switch } from './Switch'
import { LEVEL_SHORT, TIER_NAME, fmtAgo, minutesWords, usd } from './format'
import type { TeamAgent, TeamResponse, PermissionLevel } from './types'

type WeeklyResponse = { ok: true; facts: { library?: { time: { minutes: number }; money: { usd: number; stockoutsAvoided: number; ordersRecovered: number; formula: string }; actionsTotal: number } } }

export function TeamScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<TeamResponse>('/api/store/library'), 'team')
  const weekly = useLoad(() => storeFetch<WeeklyResponse>('/api/store/weekly').catch(() => null), 'team-weekly')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [setup, setSetup] = useState<TeamAgent | null>(null)
  const [setupValue, setSetupValue] = useState('')
  const [custom, setCustom] = useState<{ name: string; job: string; permission: PermissionLevel } | null>(null)

  const header = <PageHeader eyebrow={<span className="au-eyebrow"><Icon name="spark" size={13} />Your team</span>} title="Agents" sub="Twelve agents, each with one job. Switch one on and it starts in draft-for-approval: nothing happens in your store until you approve it. Grant auto-run per action type once you trust it." actions={<Button size="sm" variant="ghost" href={`${base}/plan`}><Icon name="badge" size={15} />Plan and usage</Button>} />
  if (loading && !data) return <>{header}<Loading label="Loading your team" rows={4} /></>
  if (error && !data) return <>{header}{error.status === 404 ? <NoStore /> : <ErrorState error={error} onRetry={reload} />}</>
  if (!data) return null
  const lib = weekly.data?.facts.library
  const waiting = data.agents.reduce((s, a) => s + a.waiting, 0)

  async function flip(a: TeamAgent, on: boolean, settings?: Record<string, unknown>) {
    setBusy(a.key); setNotice(null)
    try {
      await storeFetch(`/api/store/library/${a.key}/switch`, { method: 'POST', body: { enabled: on, settings } })
      setNotice({ tone: 'ok', text: on ? `${a.name} is on, at ${LEVEL_SHORT[a.permission].toLowerCase()}. It runs once a day and whenever you ask; everything it wants to do waits in its approval queue.` : `${a.name} is off. Its open drafts were closed.` })
      setSetup(null)
    } catch (e) {
      const err = asApiError(e)
      if (err.code === 'needs_setup') { setSetup(a); setSetupValue('') ; setNotice(null) }
      else if (err.code === 'upgrade_required') setNotice({ tone: 'warn', text: `${err.message}. See the plans.` })
      else setNotice({ tone: 'warn', text: err.message })
    } finally { setBusy(null); await reload() }
  }
  async function createCustom() {
    if (!custom) return
    setBusy('custom'); setNotice(null)
    try { await storeFetch('/api/store/library/custom', { method: 'POST', body: custom }); setNotice({ tone: 'ok', text: `${custom.name} created at "${LEVEL_SHORT[custom.permission]}". Switch it on from its card.` }); setCustom(null) }
    catch (e) { setNotice({ tone: 'warn', text: (e as StoreApiError).message }) } finally { setBusy(null); await reload() }
  }
  async function toggleCustom(id: string, enabled: boolean) {
    setBusy(id); try { await storeFetch(`/api/store/library/custom/${id}`, { method: 'PUT', body: { enabled } }) } catch (e) { setNotice({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null); await reload() }
  }
  async function runCustom(id: string, name: string) {
    setBusy(id); try { const r = await storeFetch<{ results: { counts: { noted: number; drafted: number; done: number } }[]; capabilities: string[] }>(`/api/store/library/custom/${id}/run`, { method: 'POST', body: {} }); const c = r.results.reduce((s, x) => ({ noted: s.noted + x.counts.noted, drafted: s.drafted + x.counts.drafted, done: s.done + x.counts.done }), { noted: 0, drafted: 0, done: 0 }); setNotice({ tone: 'ok', text: `${name} ran ${r.capabilities.length} capabilit${r.capabilities.length === 1 ? 'y' : 'ies'}: ${c.noted} reported, ${c.drafted} waiting for you, ${c.done} done.` }) } catch (e) { setNotice({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null); await reload() }
  }

  const u = data.usage
  const pct = Math.min(100, Math.round((u.actionsUsed / Math.max(1, u.allowance)) * 100))
  return (
    <>
      {header}
      {!data.store.connected && <div className="mb-4"><NoStore /></div>}
      {!data.onboarding.completedAt && data.store.connected && <div className="mb-4"><Banner icon="spark"><strong>Finish setting up.</strong> Choose the plan to trial and switch on your first agents. <Link href={`${base}/onboarding`} className="text-ink underline">Continue onboarding</Link></Banner></div>}
      <div aria-live="polite">{notice && <div className="mb-4"><Banner tone={notice.tone === 'ok' ? 'info' : 'warn'} icon={notice.tone === 'ok' ? 'check' : 'alert'}>{notice.text}</Banner></div>}</div>

      <section aria-label="This week" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="au-tile"><div className="v">{waiting}</div><div className="l">waiting for you</div><div className="s">across every agent</div></div>
        <div className="au-tile"><div className="v">{lib ? lib.actionsTotal : '—'}</div><div className="l">actions this week</div><div className="s">{data.agents.filter(a => a.enabled).length} of 12 agents on</div></div>
        <div className="au-tile"><div className="v">{lib ? minutesWords(lib.time.minutes) : '—'}</div><div className="l">time saved</div><div className="s">estimate · finished work only</div></div>
        <div className="au-tile"><div className="v">{lib ? usd(lib.money.usd) : '—'}</div><div className="l">money saved</div><div className="s">{lib ? `${lib.money.stockoutsAvoided} stockouts avoided · ${lib.money.ordersRecovered} orders recovered` : 'estimate'}</div></div>
      </section>

      <section aria-label="Usage" className="au-panel mt-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="ok">{TIER_NAME[u.tier]} plan</Badge><span className="text-[14px] text-grey">{u.actionsUsed} of {u.allowance} actions used in {u.month}{u.overageActions ? ` · ${u.overageActions} over the allowance` : ''}</span></div>
          <Link href={`${base}/plan`} className="text-[13px] text-ink underline">Plan and prices (coming soon)</Link>
        </div>
        <div className={`au-meter mt-3 ${u.overageActions ? 'over' : ''}`} role="progressbar" aria-valuenow={u.actionsUsed} aria-valuemin={0} aria-valuemax={u.allowance} aria-label="Monthly action allowance"><span style={{ width: `${pct}%` }} /></div>
        <p className="pt-2 text-[12px] text-grey-h">Every action an agent reports, drafts or makes counts once. Private beta: nothing is charged; usage is tracked so the allowance is right when prices are set.</p>
      </section>

      <section aria-label="Agent library" className="mt-6">
        <ul className="au-roster">
          {data.agents.map(a => (
            <li key={a.key}>
              <div className={`au-panel au-roster-row ${a.locked ? 'locked' : ''} ${a.enabled ? 'glow' : ''}`} data-agent={a.key} data-locked={a.locked} data-enabled={a.enabled}>
                <Link href={`${base}/team/${a.key}`} aria-label={`Open ${a.name}`} tabIndex={-1}><Character agentKey={a.key} hue={a.character.hue} shape={a.character.shape} off={!a.enabled} label={`${a.name} character`} /></Link>
                <div className="min-w-0">
                  <Link href={`${base}/team/${a.key}`} className="name hover:underline underline-offset-4">{a.name}</Link>
                  <div className="tag line-clamp-1" title={a.tagline}>{a.tagline}</div>
                  <div className="meta">
                    {a.locked ? <Link href={`${base}/plan?upgrade=${a.upgradeTo ?? ''}`} className="au-lock" data-upgrade={a.key}><Icon name="shield" size={12} />Upgrade to {a.upgradeTo ? TIER_NAME[a.upgradeTo] : 'unlock'}</Link> : <>
                      <Badge tone="muted">{LEVEL_SHORT[a.permission]}</Badge>
                      {a.waiting > 0 && <Link href={`${base}/team/${a.key}#queue`} className="badge warn" style={{ padding: '4px 10px' }}>{a.waiting} waiting</Link>}
                      {a.grants.length > 0 && <Badge tone="muted">{a.grants.length} auto-run</Badge>}
                      <span className="text-grey-h self-center">{a.lastRunAt ? `ran ${fmtAgo(a.lastRunAt)}` : 'not run yet'}</span>
                    </>}
                  </div>
                </div>
                {a.locked ? <span className="sr-only">Locked</span>
                  : <Switch on={a.enabled} disabled={busy === a.key || !data.store.connected} onChange={on => flip(a, on)} label={`Switch ${a.name} ${a.enabled ? 'off' : 'on'}`} />}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="byo-h" className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div><h2 id="byo-h" className="text-[1.15rem]">Build your own agent</h2><p className="pt-1 text-[14px] text-grey-h">Describe a job in your own words and pick a permission level. It starts at read only, the most restrictive, and uses the library&rsquo;s capabilities.</p></div>
          {data.buildYourOwn.allowed ? <Button size="sm" onClick={() => setCustom({ name: '', job: '', permission: 'read' })}><Icon name="plus" size={15} />New agent</Button> : <Link href={`${base}/plan?upgrade=pro`} className="au-lock" data-upgrade="build_your_own"><Icon name="shield" size={12} />Pro · Upgrade</Link>}
        </div>
        {data.buildYourOwn.allowed && data.buildYourOwn.agents.length > 0 && (
          <ul className="au-grid">
            {data.buildYourOwn.agents.map(c => (
              <li key={c.id}><div className={`au-panel au-agent-card ${c.enabled ? 'glow' : ''}`} data-custom={c.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0"><Character agentKey="custom" hue={60} shape="square" off={!c.enabled} /><div className="min-w-0"><div className="name">{c.name}</div><div className="tag line-clamp-2">{c.job}</div></div></div>
                  <Switch on={c.enabled} disabled={busy === c.id} onChange={on => toggleCustom(c.id, on)} label={`Switch ${c.name} ${c.enabled ? 'off' : 'on'}`} />
                </div>
                <div className="flex flex-wrap gap-2 text-[12px]"><Badge tone="muted">{LEVEL_SHORT[c.permission]}</Badge>{c.capabilities.length ? c.capabilities.map(k => <Badge key={k} tone="muted">{data.agents.find(a => a.key === k)?.name ?? k}</Badge>) : <Badge tone="warn">No matching capability yet</Badge>}</div>
                <div className="mt-auto flex gap-2"><Button size="xs" variant="ghost" onClick={() => runCustom(c.id, c.name)} disabled={!c.enabled || busy === c.id}><Icon name="bolt" size={12} />Run now</Button><Link href={`${base}/team/custom-${c.id}`} className="btn ghost xs">Log</Link></div>
              </div></li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6"><Banner icon="shield">Every agent starts in draft-for-approval. Money actions (refunds, discounts) and live publishing wait for your approval at every level. Every action is logged with its evidence and, for changes, a fresh read of the store as proof.</Banner></div>

      <Sheet open={setup !== null} onClose={() => setSetup(null)} title={setup ? `Set up ${setup.name}` : ''}>
        {setup && (
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void flip(setup, true, { [setup.needs[0]?.key ?? 'notify']: setupValue }) }}>
            <p className="text-[15px] text-grey">Before it can be switched on, add {setup.needs.map(n => n.label).join(' and ')}.</p>
            <Field label={setup.needs[0]?.label ?? 'Value'} htmlFor="setup-value"><Input id="setup-value" type="email" required value={setupValue} onChange={e => setSetupValue(e.target.value)} placeholder="name@example.com" /></Field>
            <Button type="submit" disabled={busy !== null}>{busy ? 'Saving…' : 'Save and switch on'}</Button>
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
              <span className="text-[12px] text-grey-h">Defaults to read only. {custom.permission === 'act' ? 'Act still needs an auto-run grant per action type; money and publishing actions always wait for you.' : ''}</span>
            </fieldset>
            <Button type="submit" disabled={busy !== null}>{busy === 'custom' ? 'Creating…' : 'Create agent'}</Button>
          </form>
        )}
      </Sheet>
    </>
  )
}
