'use client'
/**
 * Starting an email provider's consent flow from either app.
 *  - standalone (/store): a full-page redirect to the provider; the OAuth callback finishes the
 *    connection with the session cookie and comes back with ?email=connected (or ?email=<code>).
 *  - embedded (/shopify): providers refuse to be framed, so consent opens in a popup. The popup's
 *    return page posts { type: 'deploi-email-oauth', state, code, error } back to this window (same
 *    origin only), and this window completes the connection with its own session token.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { asApiError, isEmbedded, storeFetch, type StoreApiError } from './api'
import type { EmailConnectResponse } from './types'

export type ConnectNotice = { kind: 'connected'; address: string | null } | { kind: 'error'; e: StoreApiError } | { kind: 'popup_blocked' } | null

const POPUP = 'deploi-email-oauth'

export function useEmailConnect(onConnected: () => void | Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<ConnectNotice>(null)
  const popup = useRef<Window | null>(null)
  const done = useRef(onConnected)
  done.current = onConnected

  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data as { type?: string; state?: string | null; code?: string | null; error?: string | null } | null
      if (!d || d.type !== 'deploi-email-oauth') return
      if (popup.current && e.source && e.source !== popup.current) return
      setBusy('complete')
      try {
        const r = await storeFetch<{ account: { address: string } }>('/api/store/email/oauth/complete', { method: 'POST', body: { state: d.state ?? '', code: d.code ?? null, error: d.error ?? null } })
        setNotice({ kind: 'connected', address: r.account.address })
        await done.current()
      } catch (err) { setNotice({ kind: 'error', e: asApiError(err) }) } finally { setBusy(null); popup.current = null }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /** `key` names the button that started it; `getUrl` asks Deploi for the provider consent URL. */
  const start = useCallback(async (key: string, getUrl: () => Promise<EmailConnectResponse>) => {
    setNotice(null)
    const embedded = isEmbedded()
    // open the popup inside the click so browsers do not block it; it is pointed at the provider once Deploi answers
    const w = embedded ? window.open('', POPUP, 'popup,width=520,height=720') : null
    if (embedded && !w) { setNotice({ kind: 'popup_blocked' }); return }
    popup.current = w
    setBusy(key)
    try {
      const { url } = await getUrl()
      if (embedded && w) { w.location.href = url; setBusy(null) }
      else window.location.assign(url) // keeps the busy label until the browser leaves
    } catch (err) {
      w?.close()
      popup.current = null
      setNotice({ kind: 'error', e: asApiError(err) })
      setBusy(null)
    }
  }, [])

  return { busy, notice, setNotice, start }
}

/** Words for the ?email=<code> the OAuth callback returns with after a standalone redirect. */
export function returnNotice(code: string): { ok: boolean; text: string } {
  if (code === 'connected') return { ok: true, text: 'Email account connected. No agent can use it until you grant that agent permission.' }
  const why: Record<string, string> = {
    expired: 'The connection attempt expired or was already used. Start again.',
    forbidden: 'The connection attempt was started by someone else, or from another organization. Start again from this page.',
    invalid_input: 'Nothing was connected: access was not granted, the provider did not return an authorization, or you signed in as a different account.',
    not_operational: 'This provider is not available in this environment yet.',
    not_found: 'The account to reconnect was not found.',
  }
  return { ok: false, text: why[code] ?? 'Nothing was connected. Try again; if it keeps failing, check the account at the provider.' }
}
