'use client'
/**
 * The team room (/store/room): the agents talking to each other and to you, from what really happened (lib/app/room.ts).
 * You write into it as the team conversation: "<Agent name>, please ..." gives that agent a task; "status",
 * "what needs me" and the rest work as in "Talk to your team".
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { RoomMessage, TeamAgent, Workspace } from '@/lib/app/contract'
import { storeFetch, StoreApiError } from '@/components/store/api'
import { BotAvatar } from '@/components/app/BotAvatar'
import { Button, EmptyState } from '@/components/app/ui'

const KIND_LABEL: Record<RoomMessage['kind'], string> = {
  found: 'Found', did: 'Did', asked: 'Asked you', checked: 'Checked', handoff: 'Handed over', task: 'Task', picked_up: 'On it', note: 'Note', learned: 'Learned', chat: 'Chat', stuck: 'Stuck',
}

function Avatar({ m }: { m: RoomMessage }) {
  if (m.from.kind === 'agent' && m.from.color) return <BotAvatar color={m.from.color} size={36} />
  const letter = m.from.kind === 'owner' ? 'Y' : m.from.kind === 'deploi' ? 'D' : 'T'
  return <span aria-hidden="true" className={`room-avatar room-avatar--${m.from.kind}`}>{letter}</span>
}

export function TeamRoom({ messages, team, workspace, canAct }: { messages: RoomMessage[]; team: TeamAgent[]; workspace: Workspace; canAct: boolean }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const log = useRef<HTMLOListElement | null>(null)
  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }) }, [messages.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); setError(null)
    try { await storeFetch('/api/app/chat', { method: 'POST', body: { text: body, workspace } }); setText(''); router.refresh() }
    catch (err) { setError(err instanceof StoreApiError ? err.message : 'Something went wrong; nothing was sent.') }
    finally { setBusy(false) }
  }

  const side = workspace === 'office' ? 'Office' : 'Store'
  return (
    <div className="room" data-testid="team-room" data-workspace={workspace}>
      <header className="cc-head">
        <div>
          <p className="cc-date">{side} · {team.length} agent{team.length === 1 ? '' : 's'}</p>
          <h1 className="app-h1">Team room</h1>
          <p className="room-sub">Your agents tell each other what they found, hand work over and ask you when they need a yes. Everything here happened; nothing is made up.</p>
        </div>
      </header>
      {team.length > 0 && (
        <ul className="room-team" aria-label="Agents in the room">
          {team.map(a => <li key={a.id}><a href={`/agents/${encodeURIComponent(a.id)}`} className="room-chip"><BotAvatar color={a.color} size={22} /><span>{a.name}</span></a></li>)}
        </ul>
      )}
      {messages.length === 0 ? (
        <EmptyState title="The room is quiet" testId="room-empty">When you connect a system, Deploi reads your business and the agents start talking here: what they found, what they handed each other and what needs you.</EmptyState>
      ) : (
        <ol className="room-log" ref={log} aria-label="Team room messages">
          {messages.map(m => (
            <li key={m.id} className={`room-msg room-msg--${m.from.kind}`} data-testid="room-msg" data-kind={m.kind}>
              <Avatar m={m} />
              <div className="room-body">
                <p className="room-meta">
                  <strong>{m.from.name}</strong>{m.to && <> <span aria-hidden="true">→</span><span className="sr-only">to</span> <strong>{m.to.name}</strong></>}
                  <span className="room-kind">{KIND_LABEL[m.kind]}</span>
                  <time dateTime={m.at}>{m.ago}</time>
                </p>
                <p className="room-text">{m.text}</p>
                {m.href && m.caseRef && <a className="app-link room-link" href={m.href}>Case {m.caseRef}</a>}
                {m.href && !m.caseRef && <a className="app-link room-link" href={m.href}>See what was read</a>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {canAct && (
        <form className="room-compose" onSubmit={send}>
          <label htmlFor="room-input" className="sr-only">Message the team</label>
          <input id="room-input" className="app-input" value={text} onChange={e => setText(e.target.value)} maxLength={1000} autoComplete="off"
            placeholder={team[0] ? `Message the team, or "${team[0].name}, please …" to give a task` : 'Message the team'} />
          <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</Button>
        </form>
      )}
      {error && <p role="alert" className="room-error">{error}</p>}
    </div>
  )
}
