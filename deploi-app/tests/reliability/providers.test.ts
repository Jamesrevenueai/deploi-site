/**
 * Reliability campaign: provider errors. Fake HTTP layers only (the documented request and response shapes);
 * no real host is called.
 *   - the model provider behind the AI gateway (http provider): 429 storms, 5xx, timeouts, malformed JSON, wrong
 *     content types; each is one provider error with no retry storm, the runaway guard stops a storm, and the
 *     AI-assisted step falls back to its rules;
 *   - the Office provider client (HubSpot shape): 429 storms with bounded Retry-After backoff, 5xx on reads and
 *     writes, network loss, wrong content types and truncated (partial) pages.
 * Defect reproduced and fixed in place:
 *   R-3  a 2xx from an Office provider whose body was not JSON read as an empty object: a search page looked
 *        like "no more results" and a write looked done with no id -> lib/office/http.ts treats it as a server error
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { z } from 'zod'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW } from '../merchant/helpers'
import { aiComplete } from '../../lib/ai/gateway'
import { aiAssist } from '../../lib/ai/assist'
import { officeRequest, OfficeHttpError, setOfficeFetch, setOfficeSleep } from '../../lib/office/http'
import { hubspotClient } from '../../lib/office/hubspot'

const ready = await prepareDb()
const AI_ENV: Record<string, string> = {
  AI_PROVIDER: 'http', AI_ENDPOINT: 'https://models.example.com/v1/messages', AI_API_KEY: 'test-only-not-a-key', AI_TIMEOUT_MS: '1000',
  AI_MODEL_ROUTINE: 'routine-test', AI_MODEL_COMPLEX: 'complex-test', AI_PRICES: JSON.stringify({ 'routine-test': { input: 1, output: 2 }, 'complex-test': { input: 1, output: 2 } }),
}
const KEYS = [...Object.keys(AI_ENV), 'AI_MAX_CALLS_PER_AGENT_HOUR']
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
const restore = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
const usage = () => admin(db => db.query<{ outcome: string; reason: string | null; cost_usd: string }>(`select outcome, reason, cost_usd::text from ai_usage where org_id = $1 and agent_ref like 'test:%' order by id`, [NW.org]))
const base = { orgId: NW.org, agentRef: 'test:providers', purpose: 'test.providers', tier: 'routine' as const, input: 'Ships on 12 November.' }

let fetches: { url: string; init: RequestInit }[] = []
const respond = (fn: (init: RequestInit) => Promise<Response> | Response) => vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { fetches.push({ url, init }); return fn(init) })

describe.skipIf(!ready)('model provider errors (AI gateway, http provider)', () => {
  beforeEach(async () => { restore(); for (const [k, v] of Object.entries(AI_ENV)) process.env[k] = v; fetches = []; await admin(db => db.query(`delete from ai_usage where org_id = $1 and agent_ref like 'test:%'`, [NW.org])) })
  afterEach(() => { vi.unstubAllGlobals(); restore() })
  afterAll(async () => { if (ready) await admin(db => db.query(`delete from ai_usage where org_id = $1 and agent_ref like 'test:%'`, [NW.org])) })

  it('sends the documented request shape and reads the documented reply', async () => {
    respond(() => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 12, output_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const r = await aiComplete({ ...base, schema: z.object({ ok: z.boolean() }) })
    expect(r).toMatchObject({ ok: true, data: { ok: true }, inputTokens: 12, outputTokens: 3, model: 'routine-test' })
    const body = JSON.parse(String(fetches[0].init.body))
    expect(body).toMatchObject({ model: 'routine-test', max_tokens: expect.any(Number), system: expect.any(String), messages: [{ role: 'user', content: base.input }] })
    expect(new Headers(fetches[0].init.headers).get('x-api-key')).toBe('test-only-not-a-key')
    expect(fetches[0].init.redirect).toBe('error')
  })

  it('a 429 storm: one request per call (no amplification), each a provider error costing nothing; the runaway guard then stops calling', async () => {
    process.env.AI_MAX_CALLS_PER_AGENT_HOUR = '5'
    respond(() => new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } }))
    const out = []
    for (let k = 0; k < 8; k++) out.push(await aiComplete(base))
    expect(out.slice(0, 5).map(r => !r.ok && r.code)).toEqual(Array(5).fill('provider_error'))
    expect(out.slice(5).map(r => !r.ok && r.code)).toEqual(Array(3).fill('runaway_agent'))
    expect(fetches).toHaveLength(5)
    const u = await usage()
    expect(u.filter(x => x.outcome === 'provider_error').every(x => x.cost_usd === '0.000000' && /429/.test(x.reason ?? ''))).toBe(true)
  })

  it('5xx, malformed JSON, a wrong content type and a timeout are provider errors; the assisted step falls back to its rules', async () => {
    const cases: [string, () => Promise<Response> | Response, RegExp][] = [
      ['5xx', () => new Response('{"error":"overloaded"}', { status: 529 }), /answered 529/],
      ['malformed', () => new Response('{"content": [{"text": "half', { status: 200, headers: { 'content-type': 'application/json' } }), /unexpected shape/],
      ['html', () => new Response('<html><body>Bad gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), /unexpected shape/],
      ['wrong shape', () => new Response(JSON.stringify({ result: 'ok' }), { status: 200 }), /unexpected shape/],
    ]
    for (const [name, fn, why] of cases) {
      respond(fn)
      const r = await aiComplete(base)
      expect(r.ok, name).toBe(false)
      expect(!r.ok && r.code, name).toBe('provider_error')
      expect(!r.ok && r.reason, name).toMatch(why)
    }
    // a provider that never answers: aborted at AI_TIMEOUT_MS
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))) }))
    const t0 = Date.now()
    const a = await aiAssist({ ...base, caseId: null, schema: z.object({ ok: z.boolean() }) })
    expect(a).toMatchObject({ path: 'rules', fallback: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('Office provider errors (HubSpot shapes)', () => {
  let replies: (Response | Error | (() => Response))[] = []
  let calls: { url: string; method: string }[] = []
  const waits: number[] = []
  beforeEach(() => {
    replies = []; calls = []; waits.length = 0
    setOfficeFetch(async (url, init) => { calls.push({ url, method: String(init.method) }); const r = replies.length > 1 ? replies.shift() : replies[0]; if (!r) throw new Error('no reply'); if (r instanceof Error) throw r; return typeof r === 'function' ? r() : r })
    setOfficeSleep(async ms => { waits.push(ms) })
  })
  afterEach(() => { setOfficeFetch(null); setOfficeSleep(null) })
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const hs = () => hubspotClient(async () => 'hs-token')

  it('a 429 storm is retried a bounded number of times with Retry-After (capped), then reported as rate limited', async () => {
    for (let k = 0; k < 10; k++) replies.push(json(429, { category: 'RATE_LIMITS' }, { 'retry-after': k === 0 ? '2' : '600' }))
    const e = await officeRequest('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts/1').catch(x => x)
    expect(e).toBeInstanceOf(OfficeHttpError)
    expect(e).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(calls).toHaveLength(4)
    expect(waits).toEqual([2000, 10_000, 10_000])
  })

  it('5xx: a read that allows it is retried; a write is never retried and is uncertain (reconciled, not repeated)', async () => {
    replies.push(json(503, {}), json(503, {}), json(200, { id: '1', properties: {} }))
    expect((await officeRequest('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts/1', { retryServer: true })).body).toMatchObject({ id: '1' })
    expect(calls).toHaveLength(3)
    calls = []; replies = [json(502, {})]
    const e = await hs().createNote({ contactId: '5', body: 'x', timestamp: new Date() }).catch(x => x)
    expect(e).toMatchObject({ code: 'server', uncertain: true })
    expect(calls).toHaveLength(1)
    // a lost answer to a write (network) is uncertain too, and not retried
    calls = []; replies = [new TypeError('fetch failed')]
    expect(await hs().createNote({ contactId: '5', body: 'x', timestamp: new Date() }).catch(x => x)).toMatchObject({ code: 'network', uncertain: true })
    expect(calls).toHaveLength(1)
  })

  it('R-3: a wrong content type or a truncated page is an error, never an empty page or a silent success', async () => {
    replies.push(() => new Response('<html>Proxy error</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const e = await hs().searchLeads({ since: new Date('2026-11-01T00:00:00Z'), limit: 10 }).catch(x => x)
    expect(e).toBeInstanceOf(OfficeHttpError)
    expect(e).toMatchObject({ code: 'server', uncertain: true, message: expect.stringMatching(/not JSON/) })
    // a page cut off mid-body on a read that allows retries: retried, then reported
    replies = [() => new Response('{"results": [{"id": "1", "proper', { status: 200 })]
    calls = []
    const e2 = await officeRequest('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts/1', { retryServer: true }).catch(x => x)
    expect(e2).toMatchObject({ code: 'server' })
    expect(calls).toHaveLength(4)
    // an empty 2xx body is still fine (HubSpot answers 204 or an empty body to some writes)
    replies = [() => new Response('', { status: 200 })]
    expect((await officeRequest('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts/1')).body).toEqual({})
    // a full page is read as before, and the next cursor drives paging
    replies = [json(200, { results: [{ id: '1', properties: { email: 'a@b.example', lifecyclestage: 'lead' } }], paging: { next: { after: '1' } } })]
    expect(await hs().searchLeads({ since: new Date('2026-11-01T00:00:00Z'), limit: 1 })).toMatchObject({ next: '1', contacts: [{ id: '1' }] })
  })
})
