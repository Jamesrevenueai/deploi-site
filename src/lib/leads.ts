import { env } from './env'

export type LeadSource = 'site' | 'evv-page' | 'chat'

export type LeadPayload = {
  name: string
  email: string
  agency_name: string
  phone?: string
  message?: string
  source: LeadSource
}

export type LeadTarget = { kind: 'app'; url: string } | { kind: 'formspree'; url: string } | { kind: 'none' }

/** Pick where a lead goes: the app API when configured, Formspree otherwise. */
export function resolveLeadTarget(cfg: { appApiUrl: string; formspreeEndpoint: string } = env): LeadTarget {
  if (cfg.appApiUrl) return { kind: 'app', url: `${cfg.appApiUrl}/api/public/lead` }
  if (cfg.formspreeEndpoint) return { kind: 'formspree', url: cfg.formspreeEndpoint }
  return { kind: 'none' }
}

export function validateLead(p: LeadPayload): string | null {
  if (!p.name.trim()) return 'Please enter your name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) return 'Please enter a valid email.'
  if (!p.agency_name.trim()) return 'Please enter your agency name.'
  return null
}

export async function submitLead(
  payload: LeadPayload,
  opts: { fetchImpl?: typeof fetch; target?: LeadTarget } = {},
): Promise<{ ok: true; id?: string }> {
  const target = opts.target ?? resolveLeadTarget()
  const fetchImpl = opts.fetchImpl ?? fetch
  if (target.kind === 'none') {
    throw new Error('Form backend is not configured yet. Set VITE_APP_API_URL or VITE_FORMSPREE_ENDPOINT.')
  }
  const body =
    target.kind === 'app'
      ? payload
      : { ...payload, _subject: `Deploi AI lead (${payload.source})` }
  const res = await fetchImpl(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `Request failed (${res.status})`)
  }
  if (target.kind === 'app') {
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string }
    if (json.ok === false) throw new Error('The server rejected the request.')
    return { ok: true, id: json.id }
  }
  return { ok: true }
}
