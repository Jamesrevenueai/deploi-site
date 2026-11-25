'use client'
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { ChatAction, ChatMessage, TeamAgent } from '@/lib/app/contract'
import { useVoice } from '@/components/team/useVoice'
import { Button, MicIcon } from './bits'
import { css } from '@/components/dp/css'


export type ChatHandle = { call: () => void }
type Ops = { send: (text: string, via?: 'text' | 'voice') => Promise<ChatMessage[]>; decide: (a: ChatAction) => Promise<void> }

/** The greeting shown when there is no history: the agent's real status line, nothing invented. Not stored. */
export function greetingFor(agent: Pick<TeamAgent, 'name' | 'doingNow'>): string {
  const now = agent.doingNow.trim().replace(/[.!?]?$/, '.')
  return `Hi, I'm ${agent.name}. ${now} Ask me how things are, what I did today or what needs you, or tell me to pause.`
}

type Line = ChatMessage & { key: string }
let seq = 0
const keyed = (m: ChatMessage): Line => ({ ...m, key: m.id ?? `local-${++seq}` })

/** "Talk to <agent>": text or voice (browser speech only; nothing recorded), history loaded, inline decisions. */
export function ChatPanel({ agent, history, ops, ref }: { agent: TeamAgent; history: ChatMessage[]; ops: Ops; ref?: Ref<ChatHandle> }) {
  const [lines, setLines] = useState<Line[]>(() => history.map(keyed))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [decided, setDecided] = useState<Record<string, string>>({})
  const input = useRef<HTMLInputElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const inputId = useId()

  const send = async (raw: string, via: 'text' | 'voice' = 'text') => {
    const t = raw.trim()
    if (!t || sending) return
    setSending(true); setError(null)
    try {
      const msgs = await ops.send(t, via)
      setLines(ls => [...ls, ...msgs.map(keyed)])
      setText('')
      const reply = [...msgs].reverse().find(m => m.role === 'agent')
      if (reply) voiceRef.current.speak(reply.text)
    } catch (e) { setError((e as Error).message) } finally { setSending(false) }
  }
  const voice = useVoice(t => { void send(t, 'voice') })
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }) }, [lines.length])

  const startVoice = () => {
    if (!voice.supported) {
      setNote(`Voice is not available in this browser, so you can type to ${agent.name} instead.`)
      input.current?.focus()
      return
    }
    setNote(voice.canSpeak ? `Listening. ${agent.name} will answer out loud.` : 'Listening.')
    if (voice.canSpeak) voice.setSpeakReplies(true)
    voice.start()
  }
  useImperativeHandle(ref, () => ({ call: startVoice }))

  const decide = async (line: Line, a: ChatAction) => {
    setError(null)
    try { await ops.decide(a); setDecided(d => ({ ...d, [line.key]: a.decision === 'approve' ? `Approved: ${a.label}` : `Declined: ${a.label}` })) } catch (e) { setError((e as Error).message) }
  }

  const me = (m: Line) => css('max-width:80%;padding:12px 14px;border-radius:14px 14px 4px 14px;background:#4F46E5;color:#FFFFFF;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0;')
  const bot = css('max-width:80%;padding:12px 14px;border-radius:14px 14px 14px 4px;background:#F5F7FF;border:1px solid #E0E7FF;color:#1E1B4B;font-size:14px;line-height:1.5;')
  const meta = (l: Line, who: string) => `${l.at ? new Date(l.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'just now'} · ${who}${l.via === 'voice' ? ' · voice' : ''}`
  return (
    <section aria-labelledby={titleId} style={css('flex: 1 1 440px; min-width: 0; border: 1px solid #E0E7FF; border-radius: 18px; display: flex; flex-direction: column;')} data-testid="agent-chat">
      <div style={css('display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 20px; border-bottom: 1px solid #E0E7FF;')}>
        <h2 id={titleId} style={css('margin: 0; font-size: 17px; font-weight: 800; color: #1E1B4B;')}>Talk to {agent.name}</h2>
        <span style={css('font-size: 12px; font-weight: 600; color: #4F46E5;')}>Text or voice</span>
      </div>
      <div ref={log} role="log" aria-live="polite" aria-labelledby={titleId} tabIndex={0} style={css('padding: 20px; display: flex; flex-direction: column; gap: 14px; max-height: 460px; min-height: 220px; overflow-y: auto;')}>
        {lines.length === 0 && (
          <div style={css('display:flex;flex-direction:column;gap:4px;align-items:flex-start;')}>
            <p style={{ ...bot, margin: 0 }} data-greeting="true">{greetingFor(agent)}</p>
          </div>
        )}
        {lines.map(l => l.role === 'owner' ? (
          <div key={l.key} style={css('display:flex;flex-direction:column;gap:4px;align-items:flex-end;')}>
            <p style={me(l)}><span className="sr-only">You: </span>{l.text}</p>
            <span style={css("font-size: 11px; font-family: 'JetBrains Mono', monospace; color: #4F46E5;")}>{meta(l, 'You')}</span>
          </div>
        ) : (
          <div key={l.key} style={css('display:flex;flex-direction:column;gap:4px;align-items:flex-start;')}>
            <div style={bot}>
              <p style={css('margin: 0; white-space: pre-wrap; word-break: break-word;')}>{!l.text.startsWith(`${agent.name}:`) && <span className="sr-only">{agent.name}: </span>}{l.text}</p>
              {l.actions && l.actions.length > 0 && (decided[l.key]
                ? <p style={css('margin: 8px 0 0; font-size: 13px; font-weight: 600; color: #047857;')}>{decided[l.key]}</p>
                : <div style={css('margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px;')}>{l.actions.map((a, i) => (
                    <Button key={`${a.needsYouId}-${a.decision}`} variant={a.decision === 'approve' && i === 0 ? 'primary' : 'secondary'} onClick={() => void decide(l, a)}>{a.label}</Button>
                  ))}</div>)}
            </div>
            <span style={css("font-size: 11px; font-family: 'JetBrains Mono', monospace; color: #4F46E5;")}>{meta(l, agent.name)}</span>
          </div>
        ))}
        {sending && <p style={css('margin: 0; font-size: 13px; color: #3730A3;')}>{agent.name} is answering…</p>}
      </div>
      {note && <p role="status" style={css('margin: 0 20px 8px; font-size: 13px; color: #3730A3;')}>{note}</p>}
      {error && <p role="alert" style={css('margin: 0 20px 8px; font-size: 13px; font-weight: 600; color: #B42318;')}>{error}</p>}
      <form onSubmit={e => { e.preventDefault(); void send(text) }} style={css('margin: 0; padding: 14px 16px; border-top: 1px solid #E0E7FF; display: flex; gap: 10px; align-items: center;')}>
        <label htmlFor={inputId} className="sr-only">Message {agent.name}</label>
        <input id={inputId} ref={input} value={text} onChange={e => setText(e.target.value)} maxLength={1000} autoComplete="off" placeholder="Ask, or give a new instruction…"
          style={css('flex: 1; min-width: 0; min-height: 44px; box-sizing: border-box; padding: 0 14px; border: 1px solid #E0E7FF; border-radius: 12px; font: inherit; font-size: 14px; color: #1E1B4B; background: #FFFFFF;')} />
        <button type="button" aria-label={voice.listening ? 'Stop listening' : `Speak to ${agent.name}`} aria-pressed={voice.listening} onClick={() => (voice.listening ? voice.stop() : startVoice())}
          style={css(`width: 44px; height: 44px; flex: none; border-radius: 12px; border: 1px solid #C7D2FE; background: ${voice.listening ? '#EEF2FF' : '#FFFFFF'}; color: #4F46E5; display: flex; align-items: center; justify-content: center; cursor: pointer;`)}><MicIcon size={20} /></button>
        <button className="dp-btn" type="submit" aria-label="Send message" disabled={sending || !text.trim()} style={css('min-height: 44px; padding: 0 18px; border-radius: 12px; border: 0; background: #4F46E5; color: #FFFFFF; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;')}>Send</button>
      </form>
    </section>
  )
}
