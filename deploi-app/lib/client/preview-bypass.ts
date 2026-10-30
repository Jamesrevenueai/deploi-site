/**
 * Vercel preview deployments sit behind Vercel Authentication. Shopify opens the embedded app with
 * `x-vercel-protection-bypass` in the launch URL, which lets the first document through and sets a
 * bypass cookie. Inside the Shopify iframe that cookie is a third-party cookie: phone browsers drop it,
 * and the app's own API calls send no cookies on purpose (credentials: 'omit'). So every later
 * same-origin request would be stopped by Vercel.
 *
 * This forwards the value from the launch URL as the `x-vercel-protection-bypass` request header on
 * same-origin fetches, which Vercel accepts without cookies. It does nothing when the launch URL has
 * no such parameter (production, local dev), and the value is never part of the source or the build.
 */
const PARAM = 'x-vercel-protection-bypass'
const KEY = 'deploi.previewBypass'

export function previewBypassFrom(search: string, stored: string | null): string | null {
  const fromUrl = new URLSearchParams(search).get(PARAM)
  const v = (fromUrl ?? stored ?? '').trim()
  return /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : null
}

export function withPreviewBypass(input: RequestInfo | URL, init: RequestInit | undefined, origin: string, bypass: string): RequestInit | undefined {
  const url = typeof input === 'string' ? new URL(input, origin) : input instanceof URL ? input : new URL(input.url, origin)
  if (url.origin !== origin) return init
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!headers.has(PARAM)) headers.set(PARAM, bypass)
  return { ...init, headers }
}

let installed = false
export function installPreviewBypass() {
  if (installed || typeof window === 'undefined') return
  let stored: string | null = null
  try { stored = window.sessionStorage.getItem(KEY) } catch { stored = null }
  const bypass = previewBypassFrom(window.location.search, stored)
  if (!bypass) return
  try { window.sessionStorage.setItem(KEY, bypass) } catch { /* storage blocked: the URL still carries it this load */ }
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => original(input, withPreviewBypass(input, init, window.location.origin, bypass))
  installed = true
}
