/**
 * Content-Security-Policy (security review F-06). Pure and edge-safe: the middleware builds it per request.
 *
 *  - script-src: a fresh nonce per response plus 'strict-dynamic' (Next.js puts the nonce on every script
 *    it emits once it finds one in the request's CSP header; scripts those load are trusted transitively).
 *    No 'unsafe-inline' and, in production, no 'unsafe-eval'. 'self' (and cdn.shopify.com on /shopify)
 *    are only a fallback for browsers without 'strict-dynamic', which ignore it otherwise. App Bridge is
 *    loaded with the nonce (app/layout.tsx). `next dev` needs eval for React's dev tooling, so dev adds
 *    'unsafe-eval' and the HMR websocket.
 *  - object-src 'none', base-uri 'self'.
 *  - connect-src: the app's own origin (its API) and the Supabase project (auth); on /shopify also Shopify
 *    (App Bridge talks to the admin and reports telemetry).
 *  - frame-ancestors: unchanged (see frameAncestors in middleware.ts).
 * Styles, images and fonts are not restricted (no default-src): this is a script policy.
 *
 * Mode: CSP_MODE=report-only sends the script policy as Content-Security-Policy-Report-Only (browsers then
 * only report). frame-ancestors is ignored in a report-only policy, so it always stays in the enforced header.
 */
export type CspMode = 'enforce' | 'report-only'

export const cspMode = (env: Record<string, string | undefined> = process.env): CspMode =>
  (env.CSP_MODE ?? '').trim().toLowerCase() === 'report-only' ? 'report-only' : 'enforce'

export function newNonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function origin(url: string | undefined): string | null {
  try { return url ? new URL(url).origin : null } catch { return null }
}

export function scriptPolicy(o: { nonce: string; embedded: boolean; dev: boolean; supabaseUrl?: string; reportUri?: string }): string {
  const script = ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(o.embedded ? ['https://cdn.shopify.com'] : []), ...(o.dev ? ["'unsafe-eval'"] : [])]
  const sb = origin(o.supabaseUrl)
  const connect = ["'self'", ...(sb ? [sb, sb.replace(/^http/, 'ws')] : []), ...(o.embedded ? ['https://*.shopify.com', 'https://*.shopifysvc.com', 'https://*.shopifycloud.com'] : []), ...(o.dev ? ['ws:'] : [])]
  return [
    `script-src ${script.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    `connect-src ${connect.join(' ')}`,
    ...(o.reportUri ? [`report-uri ${o.reportUri}`] : []),
  ].join('; ') + ';'
}

/** The response (and request) headers for one page: [name, value] pairs. */
export function cspHeaders(o: { nonce: string; embedded: boolean; frameAncestors: string; mode?: CspMode; dev?: boolean; supabaseUrl?: string; reportUri?: string }): [string, string][] {
  const scripts = scriptPolicy({ nonce: o.nonce, embedded: o.embedded, dev: Boolean(o.dev), supabaseUrl: o.supabaseUrl, reportUri: o.reportUri })
  return (o.mode ?? 'enforce') === 'enforce'
    ? [['Content-Security-Policy', `${scripts} ${o.frameAncestors}`]]
    : [['Content-Security-Policy', o.frameAncestors], ['Content-Security-Policy-Report-Only', scripts]]
}
