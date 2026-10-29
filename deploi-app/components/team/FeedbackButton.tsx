'use client'
/** The private-beta feedback button: a floating button on every merchant screen; the message goes to Deploi staff with the page and a mood. */
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Field, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'

export function FeedbackButton() {
  const path = usePathname()
  const [open, setOpen] = useState(false)
  const [mood, setMood] = useState<'happy' | 'neutral' | 'unhappy' | null>(null)
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState('')
  async function send() {
    setState('sending'); setErr('')
    try { await storeFetch('/api/store/feedback', { method: 'POST', body: { page: path, mood, message } }); setState('sent'); setMessage('') } catch (e) { setErr(asApiError(e).message); setState('error') }
  }
  return (
    <>
      <button type="button" className="au-feedback" onClick={() => { setOpen(true); setState('idle') }} aria-haspopup="dialog"><Icon name="chat" size={15} />Feedback</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Tell us what you think">
        {state === 'sent' ? <p className="text-[15px] text-grey">Thank you. We read every message during the private beta.</p> : (
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void send() }}>
            <div className="flex gap-2" role="group" aria-label="How is it going?">{([['happy', '🙂 Good'], ['neutral', '😐 Okay'], ['unhappy', '🙁 Not great']] as const).map(([k, l]) => <button key={k} type="button" className={`badge ${mood === k ? '' : 'muted'}`} style={{ padding: '6px 12px', cursor: 'pointer' }} aria-pressed={mood === k} onClick={() => setMood(k)}>{l}</button>)}</div>
            <Field label="What happened, or what would help?" htmlFor="feedback-message"><Textarea id="feedback-message" required rows={4} maxLength={4000} value={message} onChange={e => setMessage(e.target.value)} /></Field>
            {state === 'error' && <p className="text-[13px] text-warn">{err}</p>}
            <Button type="submit" disabled={state === 'sending' || !message.trim()}>{state === 'sending' ? 'Sending…' : 'Send feedback'}</Button>
            <p className="text-[12px] text-grey-h">Sent with the page you are on ({path}). No store data is attached.</p>
          </form>
        )}
      </Sheet>
    </>
  )
}
