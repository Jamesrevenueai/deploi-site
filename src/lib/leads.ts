import { env } from './env'

export type LeadSource = 'site'

export type ServiceInterest = 'early_access'

export type Platform = 'shopify' | 'woocommerce' | 'amazon'

export const PLATFORMS: { value: Platform; label: string; planned: boolean }[] = [
  { value: 'shopify', label: 'Shopify', planned: false },
  { value: 'woocommerce', label: 'WooCommerce', planned: true },
  { value: 'amazon', label: 'Amazon Seller Central', planned: true },
]

export type CatalogSize = 'under_100' | '100_1000' | '1000_10000' | 'over_10000'

export const CATALOG_SIZES: { value: CatalogSize; label: string }[] = [
  { value: 'under_100', label: 'Under 100' },
  { value: '100_1000', label: '100–1,000' },
  { value: '1000_10000', label: '1,000–10,000' },
  { value: 'over_10000', label: 'More than 10,000' },
]

/**
 * The early access application, exactly as the app lead API receives it.
 * No password or API key field exists, by design.
 */
export type LeadPayload = {
  name: string
  email: string
  /** The store or company name. */
  store_name: string
  source: LeadSource
  service_interest: ServiceInterest
  store_url: string
  platforms: Platform[]
  catalog_size?: CatalogSize
  /** The stock or listing problem the merchant most wants solved. */
  message?: string
  /** Honeypot. Humans never see the field; a filled value marks the lead as a bot. */
  website: string
  /** Milliseconds the form was open before submitting; a near-instant submission marks a bot. */
  elapsed_ms?: number
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

const PLATFORM_VALUES = PLATFORMS.map(p => p.value)
const CATALOG_SIZE_VALUES = CATALOG_SIZES.map(s => s.value)

export function isPlatform(v: string): v is Platform {
  return (PLATFORM_VALUES as string[]).includes(v)
}

export function isCatalogSize(v: string): v is CatalogSize {
  return (CATALOG_SIZE_VALUES as string[]).includes(v)
}

export function validateLead(p: LeadPayload): string | null {
  if (!p.name.trim()) return 'Please enter your name.'
  if (!EMAIL_RE.test(p.email.trim())) return 'Please enter a valid work email.'
  if (!p.store_name.trim()) return 'Please enter your store or company name.'
  if (!p.store_url.trim()) return 'Please enter your store URL.'
  if (!isHttpUrl(p.store_url)) return 'Please enter a full store URL starting with http:// or https://.'
  if (p.platforms.length === 0) return 'Please choose at least one platform.'
  if (!p.platforms.every(isPlatform)) return 'Please choose platforms from the list.'
  if (p.catalog_size !== undefined && !isCatalogSize(p.catalog_size)) return 'Please choose a product count from the list.'
  return null
}

/** Builds the payload from the early access form. Exported so tests can check the mapping without a browser. */
export function earlyAccessPayload(fd: FormData): LeadPayload {
  const str = (k: string) => String(fd.get(k) ?? '').trim()
  const size = str('catalog_size')
  const message = str('message')
  const platforms = fd.getAll('platforms').map(v => String(v)).filter(isPlatform)
  return {
    name: str('name'),
    email: str('email'),
    store_name: str('store_name'),
    source: 'site',
    service_interest: 'early_access',
    store_url: str('store_url'),
    // Keep the order of PLATFORMS regardless of click order.
    platforms: PLATFORM_VALUES.filter(p => platforms.includes(p)),
    catalog_size: size && isCatalogSize(size) ? size : undefined,
    message: message || undefined,
    website: String(fd.get('website') ?? ''),
  }
}

/** Plain-text summary for the mail-client fallback when no backend is configured. */
export function leadMailBody(p: LeadPayload): string {
  const platformLabels = p.platforms.map(v => PLATFORMS.find(x => x.value === v)?.label ?? v)
  const size = CATALOG_SIZES.find(s => s.value === p.catalog_size)?.label ?? ''
  return [
    `Name: ${p.name}`,
    `Work email: ${p.email}`,
    `Store or company: ${p.store_name}`,
    `Store URL: ${p.store_url}`,
    `Platforms: ${platformLabels.join(', ')}`,
    `Approximate number of products: ${size}`,
    '',
    `Problem to solve: ${p.message ?? ''}`,
  ].join('\n')
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
      : { ...payload, _subject: `Deploi AI early access application (${payload.source})` }
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
