'use client'
/**
 * Beta access for a real store. Nothing shows when the store is enabled. Otherwise the merchant sees
 * what still works (scanning and review), and can enter an invite code or ask Deploi for access.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { Panel } from './bits'
import { fmtTime } from './format'
import type { StoreAccessResponse } from './types'

export function StoreAccessCard({ connectionId, canAct }: { connectionId: string; canAct: boolean }) {
  const { data, reload } = useLoad(() => storeFetch<StoreAccessResponse>(`/api/store/access?connection=${encodeURIComponent(connectionId)}`), `access:${connectionId}`)
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'redeem' | 'request' | null>(null)
  const [error, setError] = useState<StoreApiError | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const a = data?.access
  if (!a) return null
  if (a.writesPaused && a.eligible) {
    return <div className="mb-6"><Banner tone="warn"><strong>Changes are paused.</strong> Deploi has paused all changes to live stores for now. Scans and reviews keep working; nothing is written until changes resume.</Banner></div>
  }
  if (a.eligible) return null

  async function act(action: 'redeem' | 'request') {
    setBusy(action); setError(null); setDone(null)
    try {
      const r = await storeFetch<StoreAccessResponse>('/api/store/access', { method: 'POST', body: action === 'redeem' ? { connection: connectionId, action, code } : { connection: connectionId, action, note } })
      setDone(r.access.eligible ? 'Your store is enabled. Approved changes can now be made.' : action === 'request' ? 'Request sent. We will email the store owner when your store is enabled.' : null)
      setCode('')
      await reload()
    } catch (e) { setError(asApiError(e)) } finally { setBusy(null) }
  }

  if (a.status === 'denied') {
    return <div className="mb-6"><Banner tone="warn"><strong>Changes are not enabled for this store.</strong> {a.reason}</Banner></div>
  }
  return (
    <section className="mb-6" aria-labelledby="access-title">
      <Panel tone="warn">
        <h2 id="access-title" className="text-[1.1rem] flex items-center gap-2"><Icon name="shield" size={16} />Deploi is in beta</h2>
        <p className="mt-2 text-[14px] text-grey">
          Your store is connected and scanned, and you can review everything Deploi finds and set up agents. Deploi will not change
          your store or send real email until your store is enabled. Development stores are enabled automatically.
        </p>
        {done && <p className="mt-3 text-[14px] text-ink" role="status">{done}</p>}
        {error && <p className="mt-3 text-[14px] text-danger" role="alert">{error.message}</p>}
        {canAct ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <form onSubmit={e => { e.preventDefault(); if (code.trim()) void act('redeem') }} className="flex flex-col gap-2">
              <Field label="Invite code" htmlFor="access-code" hint="From your Deploi invitation, for example DPL-ABCDE-FGHJK-LMNPQ.">
                <Input id="access-code" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false} maxLength={40} />
              </Field>
              <div><Button size="sm" type="submit" disabled={!code.trim() || busy !== null}>{busy === 'redeem' ? 'Checking…' : 'Use invite code'}</Button></div>
            </form>
            <form onSubmit={e => { e.preventDefault(); void act('request') }} className="flex flex-col gap-2">
              <Field label="No code? Request access" htmlFor="access-note" hint={a.requestedAt ? `Requested ${fmtTime(a.requestedAt)}. You can add a note and send it again.` : 'Optional: what you would like Deploi to help with.'}>
                <Textarea id="access-note" value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={2} />
              </Field>
              <div><Button size="sm" variant="ghost" type="submit" disabled={busy !== null}>{busy === 'request' ? 'Sending…' : a.requestedAt ? 'Send again' : 'Request access'}</Button></div>
            </form>
          </div>
        ) : <p className="mt-3 text-[13px] text-grey-h">Only the store&rsquo;s own users can enter a code or request access.</p>}
      </Panel>
    </section>
  )
}
