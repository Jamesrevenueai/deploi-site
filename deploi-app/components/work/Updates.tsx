'use client'
/**
 * Settings → How you get updates: your own channels for agent updates (email on by default; text message and
 * voice note off until you add a phone number) and the daily digest option. Updates go to owners and admins.
 * Text and voice are simulated in this build (nothing is sent) until a provider is set up: the panel says so.
 */
import { useState } from 'react'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type Prefs = { email: boolean; text: boolean; voice: boolean; phone: string | null; digest: 'off' | 'daily'; role: string | null; receivesUpdates: boolean }
const API = '/api/store/settings/notifications'

function Toggle({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 py-2">
      <input id={id} type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="min-w-0"><span className="font-semibold text-ink">{label}</span><span className="block text-[13px] text-grey">{hint}</span></span>
    </label>
  )
}

export function UpdatesPanel() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ ok: true; prefs: Prefs; smsProvider: string }>(API), 'notify-prefs')
  const [draft, setDraft] = useState<Partial<Prefs>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null)
  if (loading && !data) return <Loading label="Loading your update settings" rows={2} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (!data) return null
  const p = { ...data.prefs, ...draft }
  const viewer = data.prefs.role === 'viewer'
  const set = (k: keyof Prefs, v: unknown) => setDraft(d => ({ ...d, [k]: v }))
  async function save() {
    setBusy(true); setNote(null)
    try {
      await storeFetch(API, { method: 'POST', body: { email: p.email, text: p.text, voice: p.voice, phone: p.phone ?? '', digest: p.digest } })
      setDraft({}); setNote({ tone: 'info', text: 'Saved.' }); await reload()
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(false) }
  }
  return (
    <div className="panel flex flex-col gap-3 p-4" data-testid="updates-prefs">
      <div aria-live="polite">{note && <Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner>}</div>
      {!data.prefs.receivesUpdates && <p className="text-[13px] text-grey-h">Agent updates go to owners and admins. Your role is {data.prefs.role}.</p>}
      <div className="flex flex-col">
        <Toggle id="pref-email" label="Email" hint="A clear email after each thing an agent does: what happened, what it did, the proof, and an undo when it can be undone." checked={p.email} disabled={viewer} onChange={v => set('email', v)} />
        <Toggle id="pref-text" label="Text message" hint="A short text with a link to the details." checked={p.text} disabled={viewer} onChange={v => set('text', v)} />
        <Toggle id="pref-voice" label="Voice note" hint="A short spoken summary, for updates you should hear about." checked={p.voice} disabled={viewer} onChange={v => set('voice', v)} />
        <Toggle id="pref-digest" label="Daily digest" hint="Keep routine updates for the morning report. Anything that needs you still comes straight away." checked={p.digest === 'daily'} disabled={viewer} onChange={v => set('digest', v ? 'daily' : 'off')} />
      </div>
      {(p.text || p.voice) && (
        <Field label="Phone number" htmlFor="pref-phone" hint="International form, for example +15551234567.">
          <Input id="pref-phone" type="tel" value={p.phone ?? ''} disabled={viewer} onChange={e => set('phone', e.target.value)} placeholder="+15551234567" />
        </Field>
      )}
      {data.smsProvider === 'simulated' && (p.text || p.voice) && (
        <p className="text-[13px] text-grey-h"><Badge tone="muted">Simulated</Badge> Text messages and voice notes are recorded in Deploi but not sent yet.</p>
      )}
      {!viewer && <div><Button size="sm" onClick={() => void save()} disabled={busy || !Object.keys(draft).length}>{busy ? 'Saving…' : 'Save'}</Button></div>}
    </div>
  )
}
