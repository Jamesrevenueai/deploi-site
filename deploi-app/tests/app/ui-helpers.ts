/**
 * Helpers for the redesigned app's component tests (jsdom): the browser's fetch is answered by the real
 * /api/app route handlers, authenticated as the embedded Shopify session of an organization (no cookies outside a
 * Next request), so a click goes UI -> route -> database exactly as in the app.
 */
import { vi } from 'vitest'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { POST as wsPost, GET as wsGet } from '../../app/api/app/workspace/route'
import { GET as ccGet } from '../../app/api/app/command-center/route'
import { POST as needsPost } from '../../app/api/app/needs-you/[id]/route'
import { GET as chatGet, POST as chatPost } from '../../app/api/app/chat/route'

export type Call = { method: string; path: string; body: unknown }

/** Route the component's fetches to the real handlers as the shop `domain`; every call is recorded. */
export function routeFetch(domain: string) {
  const calls: Call[] = []
  const token = () => signSessionToken({ dest: `https://${domain}`, sub: '7' }, process.env.SHOPIFY_API_SECRET!, process.env.SHOPIFY_API_KEY!)
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const req = new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(init.body ? { body: init.body as string } : {}) })
    const url = new URL(req.url)
    const needs = url.pathname.match(/^\/api\/app\/needs-you\/(.+)$/)
    if (url.pathname === '/api/app/workspace') return method === 'POST' ? wsPost(req) : wsGet(req)
    if (url.pathname === '/api/app/command-center') return ccGet(req)
    if (url.pathname === '/api/app/chat') return method === 'POST' ? chatPost(req) : chatGet(req)
    if (needs && method === 'POST') return needsPost(req, { params: Promise.resolve({ id: needs[1] }) })
    return new Response(JSON.stringify({ ok: false, error: 'not_found', message: `no test route for ${method} ${path}` }), { status: 404 })
  })
  return { fetchMock, calls, token }
}

/** The command-center read over HTTP, as the page would get it. */
export async function commandCenterOver(token: () => string, workspace?: 'store' | 'office') {
  const r = await ccGet(new Request(`http://localhost/api/app/command-center${workspace ? `?workspace=${workspace}` : ''}`, { headers: { authorization: `Bearer ${token()}` } }))
  return r.json()
}
