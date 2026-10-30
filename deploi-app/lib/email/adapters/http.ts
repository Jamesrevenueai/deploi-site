/** HTTP for provider adapters: one fetch override for tests, timeouts, and status -> outcome mapping. */
import type { SendResult } from '../types'

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let override: Fetch | null = null
/** tests only: route provider HTTP through a fake */
export function setEmailFetch(f: Fetch | null) { override = f }
export const emailFetch: Fetch = (url, init) => (override ?? fetch)(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })

export async function formPost(url: string, form: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await emailFetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

const retryAfter = (res: Response) => { const v = Number(res.headers.get('retry-after')); return Number.isFinite(v) && v > 0 ? Math.min(v, 3600) : 60 }

/** Map a send attempt's HTTP result. A 5xx or a lost response is never treated as "not sent". */
export async function sendOutcome(run: () => Promise<Response>, onOk: (res: Response) => Promise<SendResult>): Promise<SendResult> {
  let res: Response
  try { res = await run() } catch (e) {
    return { outcome: 'uncertain', code: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network', message: 'no response from the provider' }
  }
  if (res.ok) return onOk(res)
  const body = await res.text().catch(() => '')
  const reason = providerReason(body)
  if (res.status === 429) return { outcome: 'throttled', retryAfterSec: retryAfter(res), code: 'rate_limited' }
  if (res.status === 401) return { outcome: 'rejected', code: 'auth', message: 'the provider rejected the connection; reconnect the account', auth: true }
  if (res.status === 403 && /rate ?limit|quota/i.test(reason)) return { outcome: 'throttled', retryAfterSec: retryAfter(res), code: 'quota' }
  if (res.status === 403) return { outcome: 'rejected', code: 'forbidden', message: `the provider refused: ${reason || 'permission missing'}`, auth: /scope|permission|consent/i.test(reason) }
  if (res.status >= 500) return { outcome: 'uncertain', code: `http_${res.status}`, message: 'the provider had an error; the message may or may not have been sent' }
  return { outcome: 'rejected', code: `http_${res.status}`, message: `the provider refused the message: ${reason || res.statusText}` }
}

/** Short, content-free reason from a provider error body (never echoes the message itself). */
function providerReason(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; code?: string; status?: string } | string; error_description?: string }
    const m = typeof j.error === 'string' ? (j.error_description ?? j.error) : (j.error?.message ?? j.error?.code ?? j.error?.status ?? '')
    return String(m).slice(0, 160)
  } catch { return '' }
}
