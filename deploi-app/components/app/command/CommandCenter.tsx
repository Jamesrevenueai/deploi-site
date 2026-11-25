'use client'
/**
 * The Command center (/store), ported from the approved design (design-ref/app-command-center.html): header (workspace
 * label, greeting, search, + New agent), the #F5F7FF hero (hours saved this week, a line written from real activity,
 * "Review N approvals" / "See the proof", two ring gauges), four KPI cards with sparklines, the agent roster next to
 * "Live work, with proof", and "Waiting on you". Store and Office show the same layout with their own data.
 * Every number is from the server's read (CommandCenter + CommandStats); nothing is invented, and empty data says so.
 */
import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { CommandCenter as Data, NeedsYouItem, TeamAgent } from '@/lib/app/contract'
import type { CommandStats } from '@/lib/app/command-stats'
import { StoreApiError } from '@/components/store/api'
import { css } from '@/components/dp/css'
import { BotMark, Ring, Sparkline, PILL, BTN_PRIMARY, BTN_SECONDARY, H2, type PillKind } from '@/components/dp/bits'
import { decide } from './NeedsYouCard'
import { TeamChat, type ChatTarget } from './TeamChat'
import { StopNotice } from './StopAll'
import { agoText, greeting } from './time'

const LIBRARY = '/store/team'
const NEW_AGENT = '/store/agents/new'
const has = (q: string, ...xs: (string | null | undefined)[]) => xs.some(x => (x ?? '').toLowerCase().includes(q))
const n = (v: number) => v.toLocaleString('en-US')
const pillOf = (a: TeamAgent): PillKind => (a.status === 'waiting' ? 'Needs you' : a.status === 'working' ? 'Working' : 'Idle')
const hhmm = (iso: string, tz: string) => { try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso)) } catch { return iso.slice(11, 16) } }
const weekday = (now: Date, tz: string) => { try { return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(now) } catch { return 'week' } }

/** The hero's line, written from real activity only. */
export function heroLine(d: { doneToday: number; ownToday: number; needYou: number; workspace: 'store' | 'office'; agents: number }): string {
  if (!d.agents) return d.workspace === 'store' ? 'No agents are switched on yet. Turn one on in the library and its work shows up here, with proof.' : 'No office agents are set up yet. Add one and its work shows up here, with proof.'
  if (!d.doneToday) return d.needYou ? `Nothing finished yet today. ${d.needYou} ${d.needYou === 1 ? 'item needs' : 'items need'} your OK.` : 'Nothing finished yet today. Your agents are watching and will act when something needs doing.'
  const tasks = `Your agents handled ${n(d.doneToday)} ${d.doneToday === 1 ? 'task' : 'tasks'} today.`
  const own = d.ownToday ? ` ${n(d.ownToday)} of them ${d.ownToday === 1 ? 'was' : 'were'} fixed on their own` : ''
  const ok = d.needYou ? `${own ? ' —' : ''} ${d.needYou} ${d.needYou === 1 ? 'needs' : 'need'} your OK.` : own ? '.' : ''
  return `${tasks}${own}${ok}`.replace(/\s+/g, ' ').trim()
}

export function CommandCenter({ data, stats, workspaceName, now: nowIso, timeZone, stopped = null, canAct = true }: {
  data: Data; stats: CommandStats; workspaceName: string; now: string; timeZone: string; stopped?: string | null; canAct?: boolean; learned?: unknown
}) {
  const router = useRouter()
  const now = useMemo(() => new Date(nowIso), [nowIso])
  const [query, setQuery] = useState('')
  const [chat, setChat] = useState<ChatTarget | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => router.refresh(), [router])
  const q = query.trim().toLowerCase()
  const store = data.workspace === 'store'

  const needs = q ? data.needsYou.filter(i => has(q, i.agent.name, i.title, i.explanation, i.caseRef)) : data.needsYou
  const done = (q ? data.doneWithProof.filter(d => has(q, d.agent.name, d.what, d.proof.label)) : data.doneWithProof).slice(0, 5)
  const team = q ? data.team.filter(a => has(q, a.name, a.area, a.doingNow, a.job)) : data.team
  const running = data.team.filter(a => a.status !== 'off').length
  const hours = Math.round((data.hero.timeSavedWeekMinutes / 60) * 10) / 10
  const ownWeek = stats.ownSeries.reduce((a, b) => a + b, 0)
  const vs = stats.doneSameDayLastWeek ? Math.round(((stats.doneToday - stats.doneSameDayLastWeek) / stats.doneSameDayLastWeek) * 100) : null
  const kpis = [
    { label: 'Agents running', value: `${n(running)} of ${n(data.team.length)}`, sub: data.team.length ? (data.team.some(a => a.status === 'waiting') ? `${data.team.filter(a => a.status === 'waiting').length} waiting on you` : 'All healthy') : 'None set up yet', series: Array(7).fill(running) },
    { label: 'Tasks done today', value: n(stats.doneToday), sub: vs === null ? `None last ${weekday(now, timeZone)}` : `${vs >= 0 ? '+' : ''}${vs}% vs. last ${weekday(now, timeZone)}`, series: stats.doneSeries },
    { label: 'Waiting on you', value: n(data.needsYou.length), sub: stats.oldestWaitingAt ? `Oldest: ${agoText(stats.oldestWaitingAt, now)}` : 'Nothing waiting', series: stats.askedSeries },
    { label: 'Fixed before you noticed', value: n(ownWeek), sub: 'This week', series: stats.ownSeries },
  ]
  const approve = async (i: NeedsYouItem) => {
    setBusy(i.id); setError(null)
    try { await decide(i.id, 'approve'); refresh() } catch (e) { setError(e instanceof StoreApiError ? e.message : 'That did not go through. Try again.') } finally { setBusy(null) }
  }

  return (
    <div data-testid="command-center" data-workspace={data.workspace} style={css('display: flex; flex-direction: column; gap: 28px;')}>
      <header style={css('display: flex; flex-wrap: wrap; align-items: center; gap: 16px;')}>
        <div style={css('display: flex; flex-direction: column; gap: 4px; margin-right: auto;')}>
          <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')} data-testid="workspace-label">{store ? 'Store' : 'Office'} · {workspaceName}</span>
          <h1 style={css('margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: #1E1B4B;')}>{greeting(now, timeZone).replace(/\.$/, '')}{stats.firstName ? `, ${stats.firstName}` : ''}</h1>
        </div>
        <label style={css('display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px; border: 1px solid #E0E7FF; border-radius: 12px; width: 280px; max-width: 100%; box-sizing: border-box; color: #4F46E5;')}>
          <span className="sr-only">Search agents, orders, tasks</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input type="search" placeholder="Search agents, orders, tasks" value={query} onChange={e => setQuery(e.target.value)} style={css('border: 0; outline-offset: 4px; font: inherit; font-size: 14px; color: #1E1B4B; width: 100%; background: transparent;')} />
        </label>
        <Link className="dp-btn" href={NEW_AGENT} style={css(BTN_PRIMARY)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New agent</Link>
      </header>

      <StopNotice stopped={stopped} canAct={canAct} onChanged={refresh} />

      <section aria-label="This week" data-testid="cc-hero" style={css('border: 1px solid #E0E7FF; border-radius: 20px; background: #F5F7FF; padding: 32px; display: flex; flex-wrap: wrap; gap: 32px; align-items: center;')}>
        <div style={css('flex: 1 1 380px; display: flex; flex-direction: column; gap: 14px;')}>
          <span style={css("font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: #4F46E5;")}>Time your agents saved this week</span>
          <div style={css('display: flex; align-items: baseline; gap: 10px;')} title={data.hero.timeSavedFormula}><span style={css('font-size: 72px; line-height: 1; font-weight: 800; letter-spacing: -0.04em; color: #1E1B4B;')} data-testid="hero-hours">{hours.toFixed(1)}</span><span style={css('font-size: 22px; font-weight: 700; color: #3730A3;')}>hours</span></div>
          <p style={css('margin: 0; font-size: 16px; line-height: 1.55; color: #3730A3; max-width: 520px;')} data-testid="hero-line">{heroLine({ doneToday: stats.doneToday, ownToday: stats.ownSeries[6], needYou: data.needsYou.length, workspace: data.workspace, agents: data.team.length })}</p>
          <div style={css('display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px;')}>
            <a className="dp-btn" href="#approvals" style={css(BTN_PRIMARY)}>Review {n(data.needsYou.length)} {data.needsYou.length === 1 ? 'approval' : 'approvals'}</a>
            <a className="dp-btn" href="#activity" style={css(BTN_SECONDARY)}>See the proof</a>
          </div>
        </div>
        <div style={css('flex: 0 1 360px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;')}>
          {[
            { v: stats.handledWithoutYouPct, color: '#4F46E5', label: 'Handled without you', text: stats.handledWithoutYouPct === null ? '—' : `${stats.handledWithoutYouPct}%`, aria: stats.handledWithoutYouPct === null ? 'Handled without you: no finished work this week' : `${stats.handledWithoutYouPct} percent handled without you (finished this week without waiting for approval)` },
            { v: stats.healthPct, color: '#7C6BFF', label: store ? 'Store health score' : 'Pipeline health', text: stats.healthPct === null ? '—' : String(stats.healthPct), aria: stats.healthPct === null ? `${store ? 'Store health' : 'Pipeline health'}: no cases this week` : `${store ? 'Store health' : 'Pipeline health'} ${stats.healthPct} of 100 (cases resolved, against blocked or cancelled, this week)` },
          ].map(r => (
            <div key={r.label} style={css('background: #FFFFFF; border: 1px solid #E0E7FF; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start;')}>
              <Ring value={r.v} color={r.color} label={r.aria} />
              <span style={css('font-size: 24px; font-weight: 800; color: #1E1B4B;')}>{r.text}</span>
              <span style={css('font-size: 12px; font-weight: 600; color: #4F46E5;')}>{r.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Key numbers" style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;')}>
        {kpis.map(k => (
          <div key={k.label} data-testid="kpi" style={css('border: 1px solid #E0E7FF; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 8px; background: #FFFFFF;')}>
            <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')}>{k.label}</span>
            <span style={css('font-size: 32px; font-weight: 800; letter-spacing: -0.03em; color: #1E1B4B;')}>{k.value}</span>
            <div style={css('display: flex; align-items: center; justify-content: space-between; gap: 8px;')}><span style={css('font-size: 12px; color: #3730A3;')}>{k.sub}</span><Sparkline series={k.series} /></div>
          </div>
        ))}
      </section>

      <div style={css('display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;')}>
        <section aria-labelledby="roster-h" style={css('flex: 1 1 420px; min-width: 0; border: 1px solid #E0E7FF; border-radius: 18px; overflow: hidden;')}>
          <div style={css('display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid #E0E7FF;')}>
            <h2 id="roster-h" style={css(H2)}>{store ? 'Store agents' : 'Office agents'}</h2>
            <Link href={LIBRARY} style={css('font-size: 13px; font-weight: 700; text-decoration: none; color: #4F46E5;')}>Open library →</Link>
          </div>
          {team.length ? (
            <ul style={css('list-style: none; margin: 0; padding: 0;')} data-testid="roster">
              {team.map(a => (
                <li key={a.id} style={css('display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid #EEF2FF;')}>
                  <BotMark />
                  <div style={css('flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;')}>
                    <Link href={`/agents/${encodeURIComponent(a.id)}`} style={css('font-size: 15px; font-weight: 700; color: #1E1B4B; text-decoration: none;')}>{a.name}</Link>
                    <span style={css('font-size: 13px; color: #3730A3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;')}>{a.doingNow}</span>
                  </div>
                  <span style={css(PILL[pillOf(a)])}>{pillOf(a)}</span>
                </li>
              ))}
            </ul>
          ) : <p data-testid="team-empty" style={css('margin: 0; padding: 20px; font-size: 14px; color: #3730A3;')}>{q && data.team.length ? `No agents match “${query.trim()}”.` : <>No agents yet. <Link href={LIBRARY} style={css('font-weight: 700;')}>Switch one on in the library</Link> and it shows up here.</>}</p>}
        </section>

        <section id="activity" aria-labelledby="act-h" style={css('flex: 1 1 380px; min-width: 0; border: 1px solid #E0E7FF; border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 16px;')}>
          <div style={css('display: flex; align-items: center; justify-content: space-between;')}>
            <h2 id="act-h" style={css(H2)}>Live work, with proof</h2>
            <span style={css('display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #4F46E5;')}><span style={css('width: 8px; height: 8px; border-radius: 999px; background: #4F46E5;')} />Live</span>
          </div>
          {done.length ? (
            <ol style={css('list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0;')} data-testid="activity">
              {done.map(e => (
                <li key={e.id} style={css('display: flex; gap: 14px; padding-bottom: 16px;')}>
                  <div style={css('display: flex; flex-direction: column; align-items: center;')} aria-hidden="true"><span style={css('width: 10px; height: 10px; border-radius: 999px; border: 2px solid #4F46E5; background: #FFFFFF; margin-top: 4px;')} /><span style={css('flex: 1; width: 2px; background: #E0E7FF; margin-top: 4px;')} /></div>
                  <div style={css('display: flex; flex-direction: column; gap: 4px; min-width: 0;')}>
                    <span style={css("font-size: 12px; font-family: 'JetBrains Mono', monospace; color: #4F46E5;")}><time dateTime={e.at}>{hhmm(e.at, timeZone)}</time> · {e.agent.name}</span>
                    <span style={css('font-size: 14px; line-height: 1.45; color: #1E1B4B;')}>{e.what}</span>
                    <Link href={e.proof.href} style={css('font-size: 13px; font-weight: 700; text-decoration: none; color: #4F46E5;')}>{e.proof.label} →</Link>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p data-testid="done-empty" style={css('margin: 0; font-size: 14px; color: #3730A3;')}>{q && data.doneWithProof.length ? `Nothing finished matches “${query.trim()}”.` : 'No finished work yet. Proof shows up here as your agents work.'}</p>}
          <Link href="/store/completed" style={css('font-size: 13px; font-weight: 700; text-decoration: none; color: #4F46E5;')}>Full proof log →</Link>
        </section>
      </div>

      <section id="approvals" aria-labelledby="ap-h" style={css('border: 1px solid #E0E7FF; border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px;')}>
        <div style={css('display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px;')}><h2 id="ap-h" style={css(H2)}>Waiting on you</h2><span style={css('font-size: 13px; color: #3730A3;')}>Agents found these and prepared the fix. One tap to approve.</span></div>
        {error && <p role="alert" style={css('margin: 0; font-size: 13px; font-weight: 600; color: #B42318;')}>{error}</p>}
        {needs.length ? needs.map(p => (
          <div key={p.id} data-testid="approval" style={css('display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 14px; background: #F5F7FF;')}>
            <span style={css('width: 10px; height: 10px; border-radius: 999px; background: #E8734A;')} aria-hidden="true" />
            <div style={css('flex: 1 1 320px; display: flex; flex-direction: column; gap: 2px;')}>
              <span style={css('font-size: 15px; font-weight: 700; color: #1E1B4B;')}>{p.title}</span>
              <span style={css('font-size: 13px; color: #3730A3;')}>{p.agent.name} · {p.spotted}</span>
            </div>
            <button className="dp-btn" type="button" disabled={!canAct} onClick={() => setChat({ agentId: p.agent.id, name: p.agent.name })} style={css('min-height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid #C7D2FE; background: #FFFFFF; color: #3730A3; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;')}>Edit</button>
            {p.decisions.includes('approve') && (
              <button className="dp-btn" type="button" disabled={!canAct || busy === p.id} aria-label={`Approve: ${p.title}`} onClick={() => void approve(p)} style={css('min-height: 44px; padding: 0 18px; border-radius: 10px; border: 0; background: #4F46E5; color: #FFFFFF; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;')}>{busy === p.id ? 'Approving…' : 'Approve'}</button>
            )}
          </div>
        )) : <p data-testid="needs-empty" style={css('margin: 0; font-size: 14px; color: #3730A3;')}>{q && data.needsYou.length ? `Nothing waiting matches “${query.trim()}”.` : 'Nothing needs you right now. When an agent needs a yes, it shows up here with what it spotted and what it prepared.'}</p>}
      </section>

      {chat && <TeamChat key={chat.agentId ?? 'team'} target={chat} workspace={data.workspace} onClose={() => setChat(null)} onChanged={refresh} />}
    </div>
  )
}
