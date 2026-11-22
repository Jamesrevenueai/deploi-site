'use client'
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { ChatAction, ChatMessage, TeamAgent } from '@/lib/app/contract'
import { useVoice } from '@/components/team/useVoice'
import { BotAvatar } from '@/components/app/BotAvatar'
import { Button, Card, MicIcon, SendIcon } from './bits'

const ICON_BTN = { width: 44, height: 44, minWidth: 44, padding: 0, flex: 'none' } as const

export type ChatHandle = { call: () => void }
type Ops = { send: (text: string) => Promise<ChatMessage[]>; decide: (a: ChatAction) => Promise<void> }

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

  const send = async (raw: string) => {
    const t = raw.trim()
    if (!t || sending) return
    setSending(true); setError(null)
    try {
      const msgs = await ops.send(t)
      setLines(ls => [...ls, ...msgs.map(keyed)])
      setText('')
      const reply = [...msgs].reverse().find(m => m.role === 'agent')
      if (reply) voiceRef.current.speak(reply.text)
    } catch (e) { setError((e as Error).message) } finally { setSending(false) }
  }
  const voice = useVoice(t => { void send(t) })
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

  return (
    <Card title={`Talk to ${agent.name}`} titleId={titleId} className="flex flex-col">
      <div ref={log} role="log" aria-live="polite" aria-labelledby={titleId} className="flex max-h-[460px] min-h-[260px] flex-col gap-3 overflow-y-auto rounded-[14px] bg-[#FAFAFC] p-4">
        {lines.length === 0 && (
          <div className="flex items-end gap-2">
            <BotAvatar color={agent.color} size={28} />
            <p className="m-0 max-w-[85%] rounded-[14px_14px_14px_4px] border border-[#ECECF2] bg-white px-4 py-3 text-[14px] text-[#2A2A3A]" data-greeting="true">{greetingFor(agent)}</p>
          </div>
        )}
        {lines.map(l => l.role === 'owner' ? (
          <div key={l.key} className="flex justify-end">
            <p className="m-0 max-w-[85%] whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] bg-[#14141F] px-4 py-3 text-[14px] text-white"><span className="sr-only">You: </span>{l.text}</p>
          </div>
        ) : (
          <div key={l.key} className="flex items-end gap-2">
            <BotAvatar color={agent.color} size={28} />
            <div className="max-w-[85%] rounded-[14px_14px_14px_4px] border border-[#ECECF2] bg-white px-4 py-3 text-[14px] text-[#2A2A3A]">
              <p className="m-0 whitespace-pre-wrap break-words">{!l.text.startsWith(`${agent.name}:`) && <span className="sr-only">{agent.name}: </span>}{l.text}</p>
              {l.actions && l.actions.length > 0 && (decided[l.key]
                ? <p className="mb-0 mt-2 text-[13px] font-semibold text-[#17663F]">{decided[l.key]}</p>
                : <div className="mt-2 flex flex-wrap gap-2">{l.actions.map((a, i) => (
                    <Button key={`${a.needsYouId}-${a.decision}`} variant={a.decision === 'approve' && i === 0 ? 'primary' : 'secondary'} onClick={() => void decide(l, a)}>{a.label}</Button>
                  ))}</div>)}
            </div>
          </div>
        ))}
        {sending && <p className="m-0 text-[13px] text-[#5C5C70]">{agent.name} is answering…</p>}
      </div>
      {note && <p role="status" className="mb-0 mt-2 text-[13px] text-[#5C5C70]">{note}</p>}
      {error && <p role="alert" className="mb-0 mt-2 text-[13px] font-semibold text-[#B42318]">{error}</p>}
      <form className="mt-3 flex items-center gap-2" onSubmit={e => { e.preventDefault(); void send(text) }}>
        <label htmlFor={inputId} className="sr-only">Message {agent.name}</label>
        <input id={inputId} ref={input} value={text} onChange={e => setText(e.target.value)} maxLength={1000} autoComplete="off" placeholder={`Message ${agent.name}`}
          className="h-[44px] min-w-0 flex-1 rounded-[12px] border border-[#E3E3EC] bg-white px-4 text-[14px] text-[#14141F] placeholder:text-[#6B6B80]" />
        <Button variant="secondary" style={ICON_BTN} aria-label={voice.listening ? 'Stop listening' : `Speak to ${agent.name}`} aria-pressed={voice.listening}
          onClick={() => (voice.listening ? voice.stop() : startVoice())}><MicIcon /></Button>
        <Button type="submit" variant="primary" style={ICON_BTN} aria-label="Send message" disabled={sending || !text.trim()}><SendIcon /></Button>
      </form>
    </Card>
  )
}
