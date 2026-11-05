'use client'
/**
 * The help menu on every customer page: "Get help" (a support request to Deploi staff, with a category, the
 * message and, optionally, the case it is about) and "My support requests" (/store/support). On a case page the
 * case reference is filled in.
 */
import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'

export const HELP_CATEGORIES: [string, string][] = [
  ['question', 'A question'], ['problem', 'Something is not working'], ['agent', 'An agent did something unexpected'],
  ['billing', 'Billing'], ['account', 'My account or team'], ['other', 'Something else'],
]

export function HelpMenu() {
  const path = usePathname() ?? ''
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const caseFromPath = /^\/store\/work\/(DC-\d+)/i.exec(decodeURIComponent(path))?.[1]?.toUpperCase() ?? ''
  const [category, setCategory] = useState('question')
  const [message, setMessage] = useState('')
  const [caseRef, setCaseRef] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [err, setErr] = useState('')
  const [ref, setRef] = useState<{ ref: string; id: string } | null>(null)

  function start() { setMenu(false); setOpen(true); setState('idle'); setErr(''); setCaseRef(caseFromPath) }
  async function send() {
    setState('sending'); setErr('')
    try {
      const r = await storeFetch<{ ticket: { ref: string; id: string } }>('/api/store/support', { method: 'POST', body: { action: 'create', category, message, caseRef: caseRef.trim() || undefined, page: path } })
      setRef({ ref: r.ticket.ref, id: r.ticket.id }); setState('sent'); setMessage('')
    } catch (e) { setErr(asApiError(e).message); setState('error') }
  }
  return (
    <>
      <div className="au-help">
        <button type="button" className="au-feedback !static" onClick={() => setMenu(m => !m)} aria-haspopup="menu" aria-expanded={menu} aria-controls="help-menu"><Icon name="alert" size={15} />Help</button>
        {menu && (
          <div id="help-menu" role="menu" aria-label="Help" className="au-help-menu panel">
            <button type="button" role="menuitem" className="rail-link w-full" onClick={start}><Icon name="chat" size={15} />Get help</button>
            <Link role="menuitem" href="/store/support" className="rail-link" onClick={() => setMenu(false)}><Icon name="inbox" size={15} />My support requests</Link>
          </div>
        )}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="Get help">
        {state === 'sent' && ref ? (
          <div className="flex flex-col gap-3" data-testid="help-sent">
            <p className="text-[15px] text-grey">Thank you. Your request is <strong className="text-ink">{ref.ref}</strong>. Deploi support replies by email and in <Link className="link" href={`/store/support?ticket=${ref.id}`} onClick={() => setOpen(false)}>your support requests</Link>.</p>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void send() }}>
            <Field label="What is it about?" htmlFor="help-category"><Select id="help-category" value={category} onChange={e => setCategory(e.target.value)}>{HELP_CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            <Field label="How can we help?" htmlFor="help-message"><Textarea id="help-message" required rows={5} maxLength={8000} value={message} onChange={e => setMessage(e.target.value)} /></Field>
            <Field label="Case reference (optional)" htmlFor="help-case" hint="For example DC-000123, shown on every case."><Input id="help-case" value={caseRef} maxLength={20} onChange={e => setCaseRef(e.target.value)} placeholder="DC-000123" /></Field>
            {state === 'error' && <p className="text-[13px] text-warn" role="alert">{err}</p>}
            <Button type="submit" disabled={state === 'sending' || !message.trim()}>{state === 'sending' ? 'Sending…' : 'Send to Deploi support'}</Button>
            <p className="text-[12px] text-grey-h">Never include passwords or access keys. The page you are on ({path}) is attached.</p>
          </form>
        )}
      </Sheet>
    </>
  )
}
