import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { MAX_COMPETITOR_STORES, normalizeStoreUrl, storeKey } from '@/lib/competitors/url'
import { probeStore, type ProbeResult } from '@/lib/competitors/collect'
import { PoliteFetcher } from '@/lib/competitors/fetch'
import { isSyntheticHost, syntheticAllowed, syntheticTransport } from '@/lib/competitors/synthetic'

export const dynamic = 'force-dynamic'

/**
 * Body { urls: string[], probe?: boolean }. Validates and normalizes competitor store addresses; with
 * probe, also checks each one's robots.txt and public product feed (two requests per store) and says
 * whether Deploi can monitor it. Saves nothing and grants nothing.
 */
export async function POST(req: Request) {
  try {
    await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const urls = Array.isArray(body.urls) ? body.urls.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 300)) : []
    if (!urls.length) throw new HttpError(400, 'invalid_input', 'enter at least one store address')
    if (urls.length > MAX_COMPETITOR_STORES) throw new HttpError(400, 'invalid_input', `at most ${MAX_COMPETITOR_STORES} stores`)
    const seen = new Set<string>()
    const stores = urls.map(u => {
      const n = normalizeStoreUrl(u)
      if (!n.ok) return { input: u, ok: false as const, reason: n.reason }
      if (seen.has(storeKey(n.host))) return { input: u, ok: false as const, reason: 'listed twice' }
      seen.add(storeKey(n.host))
      return { input: u, ok: true as const, url: n.url, host: n.host }
    })
    const probes: (ProbeResult | null)[] = body.probe === true
      ? await Promise.all(stores.map(st => !st.ok ? null
        : isSyntheticHost(st.host) ? (syntheticAllowed() ? probeStore(st.url, new PoliteFetcher(syntheticTransport(0))) : Promise.resolve({ status: 'unreachable' as const, reason: 'synthetic demo stores are not available here' }))
        : probeStore(st.url)))
      : stores.map(() => null)
    return NextResponse.json({ ok: true, stores: stores.map((st, i) => ({ ...st, probe: probes[i] })) })
  } catch (e) { return errorResponse(e) }
}
