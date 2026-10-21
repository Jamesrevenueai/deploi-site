import { env } from './env'

export type LeadSource = 'site' | 'evv-page' | 'chat'

export type ServiceInterest = 'operations' | 'website_improvement'

export type AccessStatus = 'have_login' | 'need_to_find' | 'agency_managed' | 'unknown'

export const ACCESS_STATUSES: { value: AccessStatus; label: string }[] = [
  { value: 'have_login', label: 'I have the login' },
  { value: 'need_to_find', label: 'I need to find it' },
  { value: 'agency_managed', label: 'An agency manages it' },
  { value: 'unknown', label: 'Not sure' },
]

export const WEBSITE_PLATFORMS = ['Squarespace', 'Wix', 'WordPress', 'GoDaddy', 'Weebly', 'Other/unknown'] as const
export type WebsitePlatform = (typeof WEBSITE_PLATFORMS)[number]

export const MAX_WEBSITE_PAGES = 3

export type LeadPayload = {
  name: string
  email: string
  agency_name: string
  phone?: string
  message?: string
  source: LeadSource
  /** Honeypot. Humans never see the field; a filled value marks the lead as a bot. */
  website?: string
  /** Optional fields accepted by the lead API for a website-improvement inquiry. */
  service_interest?: ServiceInterest
  website_url?: string
  website_platform?: WebsitePlatform
  website_goal?: string
  website_pages?: string[]
  website_changes?: string
  website_issues?: string
  access_status?: AccessStatus
  /** Name and email of the person who approves the preview. Not yet stored by the API; sent anyway. */
  approval_contact?: string
}

export type LeadTarget = { kind: 'app'; url: string } | { kind: 'formspree'; url: string } | { kind: 'none' }

/** Pick where a lead goes: the app API when configured, Formspree otherwise. */
export function resolveLeadTarget(cfg: { appApiUrl: string; formspreeEndpoint: string } = env): LeadTarget {
  if (cfg.appApiUrl) return { kind: 'app', url: `${cfg.appApiUrl}/api/public/lead` }
  if (cfg.formspreeEndpoint) return { kind: 'formspree', url: cfg.formspreeEndpoint }
  return { kind: 'none' }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** True for an absolute http(s) URL with a host. */
export function isHttpUrl(value: string): boolean {
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    return false
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')
}

/** Drops empty strings, trims, and keeps at most MAX_WEBSITE_PAGES entries. */
export function cleanPages(pages: readonly (string | null | undefined)[]): string[] {
  return pages
    .map(p => (p ?? '').trim())
    .filter(p => p.length > 0)
    .slice(0, MAX_WEBSITE_PAGES)
}

export function validateLead(p: LeadPayload): string | null {
  if (!p.name.trim()) return 'Please enter your name.'
  if (!EMAIL_RE.test(p.email.trim())) return 'Please enter a valid email.'
  if (!p.agency_name.trim()) return 'Please enter your agency name.'
  if (p.service_interest === 'website_improvement') {
    if (!p.website_url || !p.website_url.trim()) return 'Please enter your website address.'
    if (!isHttpUrl(p.website_url)) return 'Please enter a full website address starting with http:// or https://.'
    if (!p.website_platform || !WEBSITE_PLATFORMS.includes(p.website_platform)) return 'Please choose the platform your website runs on.'
    if (!p.website_goal || !p.website_goal.trim()) return 'Please tell us your main business goal for the website.'
    if (!p.website_changes || !p.website_changes.trim()) return 'Please describe the changes you would like.'
    if (!p.access_status || !ACCESS_STATUSES.some(a => a.value === p.access_status)) return 'Please tell us whether you have access to the website.'
    if (p.website_pages && p.website_pages.length > MAX_WEBSITE_PAGES) return `Please list at most ${MAX_WEBSITE_PAGES} pages.`
  } else if (p.website_url && !isHttpUrl(p.website_url)) {
    return 'Please enter a full website address starting with http:// or https://.'
  }
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
