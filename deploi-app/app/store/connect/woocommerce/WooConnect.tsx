'use client'
/**
 * Connect a WooCommerce store: enter the store address, then either approve Deploi in your WooCommerce
 * admin (WooCommerce's own key-approval screen) or paste a Read/Write API key pair. Shows the connection
 * status and lets the merchant disconnect. Keys are sent once to the server and never shown again.
 */
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Facts, Loading, Panel, Section, SyntheticBadge } from '@/components/store/bits'
import { fmtAgo, fmtTime } from '@/components/store/format'

type WooConn = { id: string; site_url: string; display_name: string | null; status: string; scopes: string[]; currency: string | null; is_synthetic: boolean; installed_at: string | null; last_scan_at: string | null; connected_via: string | null; wc_version: string | null; webhooks: number; webhooks_error: string | null; has_credential: boolean }
type Status = { connections: WooConn[]; lastAttempt: { site_url: string; status: string; status_reason: string | null; created_at: string } | null; canConnect: boolean; authorizeAvailable: boolean }

const RESULT: Record<string, { tone: 'info' | 'warn'; text: string }> = {
  connected: { tone: 'info', text: 'Connected. Deploi is reading your store; issues appear after the first scan.' },
  pending: { tone: 'info', text: 'WooCommerce sent the key; Deploi is checking it. Refresh in a moment.' },
  declined: { tone: 'warn', text: 'The approval was cancelled in WooCommerce. Nothing was connected.' },
  failed: { tone: 'warn', text: 'The store could not be connected. See the reason below and try again.' },
  unknown: { tone: 'warn', text: 'This approval could not be matched to your account. Start again from this page.' },
}

export function WooConnectScreen() {
  const params = useSearchParams()
  const result = params.get('result')
  const { data, error, loading, reload } = useLoad(() => storeFetch<Status>('/api/woocommerce/status'), 'woo-connect')
  const [site, setSite] = useState('')
  const [mode, setMode] = useState<'authorize' | 'keys'>('authorize')
  const [ck, setCk] = useState('')
  const [cs, setCs] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [note, setNote] = useState<string | null>(null)

  if (loading && !data) return <><PageHeader title="WooCommerce" /><Loading label="Loading WooCommerce connection" /></>
  if (error && !data) return <><PageHeader title="WooCommerce" /><ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const active = data.connections.filter(c => c.status === 'active')
  const useKeys = mode === 'keys' || !data.authorizeAvailable

  async function authorize() {
    setBusy('authorize'); setErr(null); setNote(null)
    try {
      const r = await storeFetch<{ authorizeUrl: string }>('/api/woocommerce/connect', { method: 'POST', body: { siteUrl: site } })
      window.location.assign(r.authorizeUrl)
    } catch (e) { setErr(asApiError(e)); setBusy(null) }
  }
  async function pasteKeys() {
    setBusy('keys'); setErr(null); setNote(null)
    try {
      const r = await storeFetch<{ webhooksError: string | null }>('/api/woocommerce/keys', { method: 'POST', body: { siteUrl: site, consumerKey: ck, consumerSecret: cs } })
      setCk(''); setCs('')
      setNote(r.webhooksError ? `Connected. Webhooks are not active (${r.webhooksError}); changes are picked up on each scan.` : 'Connected. Deploi is reading your store.')
      await reload()
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  async function disconnect(id: string) {
    setBusy(`disconnect:${id}`); setErr(null); setNote(null)
    try {
      await storeFetch('/api/woocommerce/disconnect', { method: 'POST', body: { connectionId: id } })
      setNote('Disconnected. Deploi deleted its copy of the key and its webhooks. To revoke the key itself, delete it in WooCommerce → Settings → Advanced → REST API.')
      await reload()
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  return (
    <>
      <PageHeader title="WooCommerce" sub="Connect your WooCommerce store. Deploi reads products and stock, and changes only what you or an agent you authorized approve." />
      <div aria-live="polite" className="flex flex-col gap-3">
        {result && RESULT[result] && <Banner tone={RESULT[result].tone}>{RESULT[result].text}</Banner>}
        {note && <Banner icon="check">{note}</Banner>}
        {err && <ErrorState error={err} />}
        {data.lastAttempt?.status === 'failed' && data.lastAttempt.status_reason && result === 'failed' && <Banner tone="warn"><strong>Reason:</strong> {data.lastAttempt.status_reason}</Banner>}
      </div>

      {data.connections.map(c => (
        <Panel key={c.id} className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink font-medium break-all">{c.display_name ?? c.site_url}</span>
            <Badge tone={c.status === 'active' ? 'ok' : 'warn'}>{c.status === 'active' ? 'Connected' : 'Disconnected'}</Badge>
            {c.is_synthetic && <SyntheticBadge />}
          </div>
          <div className="mt-3">
            <Facts items={[
              ['Store address', <span key="u" className="break-all">{c.site_url}</span>],
              ['WooCommerce', c.wc_version ?? 'Not reported'],
              ['Key permission', c.scopes.length ? c.scopes.join(' + ') : 'none'],
              ['Connected via', c.connected_via === 'manual' ? 'API keys pasted' : c.connected_via === 'authorize' ? 'Approved in WooCommerce' : c.connected_via ?? '—'],
              ['Webhooks', c.webhooks ? `${c.webhooks} active` : c.webhooks_error ?? 'none'],
              ['Connected', fmtTime(c.installed_at)],
              ['Last scan', c.last_scan_at ? fmtAgo(c.last_scan_at) : 'Not scanned yet'],
            ]} />
          </div>
          {c.status === 'active' && data.canConnect && !c.is_synthetic && (
            <Button className="mt-4" variant="ghost" size="sm" disabled={busy !== null} onClick={() => disconnect(c.id)} aria-label={`Disconnect ${c.site_url}`}>
              {busy === `disconnect:${c.id}` ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          )}
        </Panel>
      ))}

      {data.canConnect && (
        <Section title={active.length ? 'Connect another WooCommerce store' : 'Connect your WooCommerce store'}
          sub="Your store must use https. You need to be an administrator or shop manager in WooCommerce.">
          <Panel>
            <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void (useKeys ? pasteKeys() : authorize()) }}>
              <Field label="Store address" htmlFor="woo-site" hint="For example https://shop.example.com (include the folder if WordPress lives in one).">
                <Input id="woo-site" type="url" inputMode="url" autoComplete="url" required placeholder="https://" value={site} onChange={e => setSite(e.target.value)} />
              </Field>
              {data.authorizeAvailable && (
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How to connect">
                  <Button type="button" size="sm" variant={mode === 'authorize' ? 'primary' : 'ghost'} aria-pressed={mode === 'authorize'} onClick={() => setMode('authorize')}>Approve in WooCommerce</Button>
                  <Button type="button" size="sm" variant={mode === 'keys' ? 'primary' : 'ghost'} aria-pressed={mode === 'keys'} onClick={() => setMode('keys')}>Paste API keys</Button>
                </div>
              )}
              {useKeys ? (
                <>
                  <p className="text-[14px] text-grey">In WordPress, open WooCommerce → Settings → Advanced → REST API → Add key. Choose <strong>Read/Write</strong> permission, generate it, and paste both values here. Deploi checks the key with a read before saving it, stores it encrypted, and never shows it again.</p>
                  <Field label="Consumer key" htmlFor="woo-ck"><Input id="woo-ck" required autoComplete="off" spellCheck={false} placeholder="ck_…" value={ck} onChange={e => setCk(e.target.value)} /></Field>
                  <Field label="Consumer secret" htmlFor="woo-cs"><Input id="woo-cs" type="password" required autoComplete="off" spellCheck={false} placeholder="cs_…" value={cs} onChange={e => setCs(e.target.value)} /></Field>
                  <div><Button type="submit" disabled={busy !== null || !site || !ck || !cs}>{busy === 'keys' ? 'Checking the key…' : 'Connect with these keys'}</Button></div>
                </>
              ) : (
                <>
                  <p className="text-[14px] text-grey">You will be sent to your store&rsquo;s WooCommerce approval screen. Approve <strong>Read/Write</strong> access for Deploi; WooCommerce then creates a key just for Deploi and sends it to Deploi directly. You come back here when it is done.</p>
                  <div><Button type="submit" disabled={busy !== null || !site}>{busy === 'authorize' ? 'Opening WooCommerce…' : 'Continue to WooCommerce'}</Button></div>
                </>
              )}
            </form>
          </Panel>
          <p className="pt-3 text-[13px] text-grey-h">Deploi reads products, variations, stock settings and the WooCommerce version, and registers webhooks for product and order changes. It writes only approved changes, one field at a time: backorders, regular or sale price, SKU, and draft ↔ published. It never changes stock counts, customers or orders.</p>
        </Section>
      )}
    </>
  )
}
