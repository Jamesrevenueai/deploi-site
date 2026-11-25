'use client'
/**
 * Talk to your team: a text and voice conversation with all agents (GET/POST /api/app/chat), or with one agent
 * (/api/app/agents/:id/chat) when opened from its "Reply". Voice is the browser's own speech recognition
 * (components/team/useVoice.ts): only the transcribed text reaches Deploi. Escape or the close button closes it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage, Workspace } from '@/lib/app/contract'
import { storeFetch, StoreApiError } from '@/components/store/api'
import { useVoice } from '@/components/team/useVoice'
import { Button } from '@/components/app/ui'
import { decide } from './NeedsYouCard'

export type ChatTarget = { agentId: string | null; name: string }

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
export { MicIcon }

export function TeamChat({ target, workspace, onClose, onChanged }: { target: ChatTarget; workspace: Workspace; onClose: () => void; onChanged: () => void }) {
  const base = target.agentId ? `/api/app/agents/${encodeURIComponent(target.agentId)}/chat` : '/api/app/chat'
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const log = useRef<HTMLDivElement | null>(null)

  const send = async (t: string) => {
    const body = t.trim()
    if (!body || busy) return
    setBusy(true); setError(null)
    try {
      const r = await storeFetch<{ messages: ChatMessage[] }>(base, { method: 'POST', body: target.agentId ? { text: body } : { text: body, workspace } })
      setMessages(m => [...m, ...r.messages]); setText('')
      const reply = [...r.messages].reverse().find(x => x.role === 'agent')
      if (reply) voice.speak(reply.text)
    } catch (e) { setError(e instanceof StoreApiError ? e.message : 'Could not send. Try again.') } finally { setBusy(false) }
  }
  const voice = useVoice(t => { void send(t) })

  useEffect(() => {
    let live = true
    storeFetch<{ messages: ChatMessage[] }>(base).then(r => { if (live) setMessages(r.messages) }).catch(() => { if (live) setMessages([]) })
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { live = false; window.removeEventListener('keydown', onKey) }
  }, [base, onClose])
  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }) }, [messages])

  const act = async (needsYouId: string, decision: 'approve' | 'decline') => {
    setError(null)
    try { await decide(needsYouId, decision); onChanged(); setMessages(m => [...m, { role: 'agent', text: decision === 'approve' ? 'Done. It is on its way.' : 'Declined. Nothing was changed.' }]) } catch (e) { setError(e instanceof StoreApiError ? e.message : 'That did not go through.') }
  }

  const submit = (e: FormEvent) => { e.preventDefault(); void send(text) }
  const title = target.agentId ? `Talk to ${target.name}` : 'Talk to your team'
  return (
    <div className="app-chat" role="dialog" aria-modal="false" aria-labelledby="chat-title" data-testid="team-chat">
      <div className="app-chat-head">
        <h2 className="app-h2" id="chat-title" style={{ fontSize: 17 }}>{title}</h2>
        <button type="button" className="app-icon-btn" onClick={onClose} aria-label="Close the conversation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="app-chat-log" ref={log} aria-live="polite">
        {messages.length === 0 && <p className="app-muted" style={{ fontSize: 14 }}>Ask what they are doing, what happened today or what needs you.</p>}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`app-chat-msg ${m.role}`}>
            {m.text}
            {m.actions && m.actions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {m.actions.map(a => <Button key={`${a.needsYouId}:${a.decision}`} variant={a.decision === 'approve' ? 'primary' : 'secondary'} onClick={() => void act(a.needsYouId, a.decision)}>{a.label}</Button>)}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p role="alert" className="cc-need-error" style={{ padding: '0 16px' }}>{error}</p>}
      <form className="app-chat-form" onSubmit={submit}>
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <input id="chat-input" ref={input} className="app-input" value={text} onChange={e => setText(e.target.value)} placeholder="Type a message" autoComplete="off" maxLength={1000} />
        <button type="button" className="app-icon-btn" aria-pressed={voice.listening} disabled={!voice.supported}
          aria-label={voice.supported ? (voice.listening ? 'Stop listening' : 'Speak your message') : 'Voice is not available in this browser'}
          onClick={() => (voice.listening ? voice.stop() : voice.start())}><MicIcon /></button>
        <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
      </form>
    </div>
  )
}
