/**
 * Read-only smoke check of a deployment. Five GET requests, no cookies, no credentials, nothing written:
 *
 *   1. health        GET /api/health answers 200 with ok: true (database reachable); reports dead jobs and the queue age
 *   2. auth redirect GET /store without a session is redirected to /login
 *   3. public page   GET /login answers 200 with HTML
 *   4. CSP header    /login carries a Content-Security-Policy (or -Report-Only) with a script nonce
 *   5. cron refusal  GET /api/cron/jobs without the cron secret answers 401 (a refused call runs nothing)
 *
 *   npx tsx scripts/smoke-check.ts https://<deployment>        (exit code 0 when every check passes)
 *
 * It never sends CRON_SECRET or any other secret, and never follows a redirect off the deployment.
 */

export type Check = { name: string; ok: boolean; detail: string }
type Fetch = (url: string, init: RequestInit) => Promise<Response>

export function normalizeBase(raw: string): string {
  const u = new URL(raw)
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('use an https URL (http is allowed for localhost only)')
  return `${u.protocol}//${u.host}`
}

export async function smokeCheck(baseUrl: string, fetchImpl: Fetch = fetch, timeoutMs = 15_000): Promise<Check[]> {
  const base = normalizeBase(baseUrl)
  const get = (path: string) => fetchImpl(`${base}${path}`, { method: 'GET', redirect: 'manual', headers: { accept: path.startsWith('/api/') ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(timeoutMs) })
  const out: Check[] = []
  const run = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try { out.push({ name, ...(await fn()) }) } catch (e) { out.push({ name, ok: false, detail: `request failed: ${(e as Error).message.slice(0, 120)}` }) }
  }

  await run('health', async () => {
    const r = await get('/api/health')
    const j = (await r.json().catch(() => null)) as { ok?: boolean; queue?: { dead?: number; oldestDueAgeSec?: number }; db?: { latencyMs?: number } } | null
    if (r.status !== 200 || !j?.ok) return { ok: false, detail: `HTTP ${r.status}, ok=${String(j?.ok)}` }
    return { ok: true, detail: `db ${j.db?.latencyMs ?? '?'} ms, dead jobs ${j.queue?.dead ?? '?'}, oldest due ${j.queue?.oldestDueAgeSec ?? '?'} s` }
  })
  await run('auth redirect', async () => {
    const r = await get('/store')
    const loc = r.headers.get('location') ?? ''
    const target = loc ? new URL(loc, base) : null
    const ok = r.status >= 300 && r.status < 400 && Boolean(target && target.origin === base && target.pathname === '/login')
    return { ok, detail: ok ? `HTTP ${r.status} -> /login` : `HTTP ${r.status}${loc ? ` -> ${loc.slice(0, 120)}` : ' (no redirect)'}` }
  })
  let csp: string | null = null
  await run('public page', async () => {
    const r = await get('/login')
    csp = r.headers.get('content-security-policy') ?? r.headers.get('content-security-policy-report-only')
    const type = r.headers.get('content-type') ?? ''
    const ok = r.status === 200 && type.includes('text/html')
    return { ok, detail: `HTTP ${r.status} ${type.split(';')[0]}` }
  })
  await run('CSP header', async () => {
    const policy: string = csp ?? ''
    const ok = /script-src[^;]*'nonce-[A-Za-z0-9+/=_-]+'/.test(policy)
    return { ok, detail: ok ? 'script-src with a nonce' : policy ? `no script nonce: ${policy.slice(0, 120)}` : 'missing' }
  })
  await run('cron refusal', async () => {
    const r = await get('/api/cron/jobs')
    return { ok: r.status === 401, detail: `HTTP ${r.status} without the cron secret${r.status === 401 ? '' : ' (expected 401)'}` }
  })
  return out
}

async function main() {
  const target = process.argv[2]
  if (!target) { console.error('usage: npx tsx scripts/smoke-check.ts https://<deployment>'); process.exit(2) }
  const checks = await smokeCheck(target)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(14)} ${c.detail}`)
  const failed = checks.filter(c => !c.ok).length
  console.log(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
if (process.argv[1] && /smoke-check\.ts$/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(1) })
