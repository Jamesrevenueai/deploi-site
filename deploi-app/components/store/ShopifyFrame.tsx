'use client'
/**
 * Embedded Shopify admin frame. Before any /api/store call it:
 *  1. checks that the app is configured (SHOPIFY_API_KEY) and that App Bridge loaded (window.shopify),
 *  2. gets an App Bridge id token and POSTs /api/shopify/session with it (completes installation via
 *     token exchange on the server),
 *  3. switches storeFetch to bearer-token mode.
 * Outside the Shopify admin it shows "Open this app from your Shopify admin" instead of failing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Banner } from '@/components/ui/Banner'
import { Icon } from '@/components/ui/Icon'
import { setEmbeddedTokenSource } from './api'
import { StoreProvider } from './bits'
import { embeddedCredentials, installPreviewBypass } from '@/lib/client/preview-bypass'

// Preview deployments only: carry the Vercel bypass from the launch URL on same-origin calls.
installPreviewBypass()

type State = { kind: 'checking' } | { kind: 'outside'; why: 'not_configured' | 'no_app_bridge' } | { kind: 'error'; message: string } | { kind: 'ready' }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitForAppBridge(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (typeof window !== 'undefined' && window.shopify?.idToken) return window.shopify
    await sleep(50)
  }
  return null
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))])
}

export function ShopifyFrame({ configured, children }: { configured: boolean; children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const router = useRouter()

  // App Bridge menu links dispatch shopify:navigate; route them through the Next router.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const href = (e.target as HTMLElement | null)?.getAttribute?.('href')
      if (href && href.startsWith('/shopify')) router.push(href)
    }
    document.addEventListener('shopify:navigate', onNavigate)
    return () => document.removeEventListener('shopify:navigate', onNavigate)
  }, [router])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!configured) { setState({ kind: 'outside', why: 'not_configured' }); return }
      const bridge = await waitForAppBridge(2500)
      if (cancelled) return
      if (!bridge) { setState({ kind: 'outside', why: 'no_app_bridge' }); return }
      const token = () => withTimeout(bridge.idToken(), 10_000, 'Shopify session token')
      try {
        const res = await fetch('/api/shopify/session', { method: 'POST', headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' }, credentials: embeddedCredentials, cache: 'no-store' })
        let json: { ok?: boolean; error?: string; message?: string } | null = null
        try { json = await res.json() } catch { json = null }
        if (cancelled) return
        if (!res.ok || !json?.ok) {
          setState({ kind: 'error', message: json?.message ?? json?.error ?? `installation could not be completed (${res.status})` })
          return
        }
        setEmbeddedTokenSource(token)
        setState({ kind: 'ready' })
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: (e as Error).message })
      }
    })()
    return () => { cancelled = true }
  }, [configured, attempt])

  useEffect(() => () => setEmbeddedTokenSource(null), [])

  if (state.kind === 'ready') return <StoreProvider base="/shopify">{children}</StoreProvider>
  if (state.kind === 'checking') {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-3 py-10 text-grey">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-grey-h border-t-white" aria-hidden="true" />
        Connecting to your Shopify store…
      </div>
    )
  }
  if (state.kind === 'outside') {
    return (
      <div className="mx-auto max-w-lg py-12 fade-up">
        <div className="wordmark mb-8">deploi <span className="text-grey-h">ai</span></div>
        <div className="metal rounded-[20px] p-6 md:p-8">
          <div className="relative flex flex-col gap-3">
            <h1 className="text-[1.6rem]">Open this app from your Shopify admin</h1>
            <p className="text-[15px] text-grey">
              This page is the Deploi app inside Shopify. It only works when Shopify opens it: in your Shopify admin, go to Apps and choose Deploi.
            </p>
            {state.why === 'not_configured' && <p className="text-[13px] text-grey-h">This Deploi environment has no Shopify app key configured.</p>}
            <p className="text-[14px] text-grey-h">Using Deploi in a browser instead? <a href="/login"><span className="text-ink underline">Sign in to the Deploi web app</span></a>.</p>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="py-8 fade-up" role="alert">
      <Banner tone="warn"><strong>Could not connect to your store.</strong> {state.message}. Reload the app from your Shopify admin; if this keeps happening, reinstall the app.</Banner>
      <button type="button" className="btn ghost sm mt-3" onClick={() => { setState({ kind: 'checking' }); setAttempt(a => a + 1) }}><Icon name="bolt" size={15} />Try again</button>
    </div>
  )
}
