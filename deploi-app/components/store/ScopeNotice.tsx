'use client'
/**
 * Shown when an authorization version may write something the store has not granted the app a scope for.
 * Inside the Shopify admin the merchant is asked through App Bridge (Shopify's own grant screen); the server
 * then re-reads the granted list from Shopify. Outside the admin there is nothing to click: the grant happens
 * only on Shopify's surfaces.
 */
import { useState } from 'react'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { storeFetch, asApiError } from './api'

const LABEL: Record<string, string> = { write_products: 'change product settings (write_products)', write_publications: 'publish and unpublish products (write_publications)', read_publications: 'read sales channels (read_publications)' }
const label = (s: string) => LABEL[s] ?? s

export function ScopeNotice({ missing, connectionId, version, onChanged }: { missing: string[]; connectionId: string; version: number; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  if (!missing.length) return null
  const embedded = typeof window !== 'undefined' && Boolean(window.shopify?.scopes)

  async function ask() {
    setBusy(true); setNote(null)
    try {
      const r = await window.shopify!.scopes!.request(missing)
      const sync = await storeFetch<{ granted: string[] }>('/api/store/scopes/sync', { method: 'POST', body: { connectionId } })
      const still = missing.filter(s => !sync.granted.includes(s))
      setNote(r.result === 'declined-all' ? 'You declined. This version keeps drafting; nothing is written until the store grants the permission.' : still.length ? `Shopify has not granted: ${still.join(', ')}.` : 'Shopify granted the permission. This version may now make the changes you approve.')
      await onChanged()
    } catch (e) { setNote(`Not granted: ${asApiError(e).message}`) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-3">
      <Banner tone="warn">
        <strong>Shopify has not given Deploi permission to {missing.map(label).join(' and ')}.</strong>{' '}
        Version {version} can still draft every change, but nothing is written to the store until the store grants it. Deploi asks only for this, only now, and never at install.
        {embedded ? (
          <span className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={ask} disabled={busy} aria-label={`Ask Shopify for permission: ${missing.join(', ')}`}>{busy ? 'Asking Shopify…' : 'Ask Shopify for this permission'}</Button>
            <span className="text-[13px] text-grey-h">Shopify shows its own grant screen; you can decline.</span>
          </span>
        ) : (
          <span className="mt-2 block text-[13px] text-grey-h">Open the app from your Shopify admin to grant it; the request is made through Shopify, not here.</span>
        )}
        {note && <span className="mt-2 block text-[14px] text-ink">{note}</span>}
      </Banner>
    </div>
  )
}
