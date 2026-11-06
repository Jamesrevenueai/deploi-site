'use client'
/**
 * The Command center (/store): the greeting and search, the hero band, "Needs you" next to "Done, with proof", and
 * the team. Store and Office show the same layout with their own data (the feeds already filter by workspace).
 * Everything shown is the CommandCenter the server read for this request; nothing is invented, and an empty feed
 * says so. Search filters what is loaded here; it never makes up results.
 */
import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { CommandCenter as Data, NeedsYouItem } from '@/lib/app/contract'
import { Button, Card, EmptyState } from '@/components/app/ui'
import { Hero } from './Hero'
import { NeedsYouCard } from './NeedsYouCard'
import { DoneList } from './DoneList'
import { TeamTable } from './TeamTable'
import { TeamChat, MicIcon, type ChatTarget } from './TeamChat'
import { StopAllButton, StopNotice } from './StopAll'
import { dateLine, greeting } from './time'

const PROOF_LOG = '/store/completed'
const LIBRARY = '/store/team'
const NEW_AGENT = '/store/agents/new'

const has = (q: string, ...xs: (string | null | undefined)[]) => xs.some(x => (x ?? '').toLowerCase().includes(q))

/**
 * `now` is the time of the server's read and `timeZone` the organization's own, so the greeting and the times are
 * the same on the server and in the browser (no hydration mismatch) and match the business's day.
 */
export function CommandCenter({ data, now: nowIso, timeZone, stopped = null, canAct = true }: { data: Data; now: string; timeZone: string; stopped?: string | null; canAct?: boolean }) {
  const router = useRouter()
  const now = useMemo(() => new Date(nowIso), [nowIso])
  const [query, setQuery] = useState('')
  const [chat, setChat] = useState<ChatTarget | null>(null)
  const refresh = useCallback(() => router.refresh(), [router])
  const closeChat = useCallback(() => setChat(null), [])
  const q = query.trim().toLowerCase()

  const needs = q ? data.needsYou.filter(i => has(q, i.agent.name, i.title, i.explanation, i.caseRef)) : data.needsYou
  const done = q ? data.doneWithProof.filter(d => has(q, d.agent.name, d.what, d.proof.label)) : data.doneWithProof
  const team = q ? data.team.filter(a => has(q, a.name, a.area, a.doingNow, a.job)) : data.team
  const noMatch = (what: string) => <EmptyState title={`No ${what} match “${query.trim()}”`}>Clear the search to see everything.</EmptyState>
  const reply = (i: NeedsYouItem) => setChat({ agentId: i.agent.id, name: i.agent.name })
  const side = data.workspace === 'office' ? 'Office' : 'Store'

  return (
    <div className="cc" data-testid="command-center" data-workspace={data.workspace}>
      <header className="cc-head">
        <div>
          <p className="cc-date">{dateLine(now, timeZone)} · {side}</p>
          <h1 className="app-h1">{greeting(now, timeZone)} Your team is on it.</h1>
        </div>
        <div className="cc-tools">
          <label className="app-search">
            <span className="sr-only">Search agents, orders, proof</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input type="search" className="app-input" placeholder="Search agents, orders, proof" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <Button onClick={() => setChat({ agentId: null, name: 'your team' })}><MicIcon />Talk to your team</Button>
        </div>
      </header>

      <StopNotice stopped={stopped} canAct={canAct} onChanged={refresh} />
      <Hero hero={data.hero} now={now} />

      <div className="cc-cols">
        <section aria-labelledby="needs-title">
          <div className="cc-section-head"><h2 className="app-h2" id="needs-title">Needs you</h2></div>
          {needs.length ? (
            <ul className="cc-list">{needs.map(i => <NeedsYouCard key={i.id} item={i} onDecided={refresh} onReply={reply} />)}</ul>
          ) : q && data.needsYou.length ? noMatch('requests') : (
            <EmptyState title="Nothing needs you right now" testId="needs-empty">When an agent needs a yes from you, it shows up here with what it spotted and what it prepared.</EmptyState>
          )}
        </section>
        <section aria-labelledby="done-title">
          <div className="cc-section-head">
            <h2 className="app-h2" id="done-title">Done, with proof</h2>
            <Link href={PROOF_LOG} className="app-link">Full proof log</Link>
          </div>
          {done.length ? <Card size="lg" style={{ paddingBlock: 6 }}><DoneList items={done} /></Card>
            : q && data.doneWithProof.length ? noMatch('finished work') : (
              <EmptyState title="No finished work yet" testId="done-empty">Proof shows up here as your agents work.</EmptyState>
            )}
        </section>
      </div>

      <section aria-labelledby="team-title">
        <div className="cc-section-head">
          <h2 className="app-h2" id="team-title">Your team</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <StopAllButton stopped={stopped} canAct={canAct} onChanged={refresh} />
            <Button variant="secondary" href={LIBRARY}>Browse library</Button>
            <Button href={NEW_AGENT}>Build a custom agent</Button>
          </div>
        </div>
        {team.length ? <TeamTable agents={team} />
          : q && data.team.length ? noMatch('agents') : (
            <EmptyState title="No agents yet" testId="team-empty" action={<Button variant="secondary" href={LIBRARY}>Browse library</Button>}>
              Switch one on from the library or build your own; it shows up here with what it is doing.
            </EmptyState>
          )}
      </section>

      {chat && <TeamChat key={chat.agentId ?? 'team'} target={chat} workspace={data.workspace} onClose={closeChat} onChanged={refresh} />}
    </div>
  )
}
