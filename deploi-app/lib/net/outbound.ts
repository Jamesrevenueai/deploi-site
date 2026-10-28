/**
 * Outbound request boundary. Every network call the app makes to a third party goes through
 * assertApprovedHost() first, so a misconfigured URL cannot send data to an unapproved provider.
 * The PHI lane (Ollama) is additionally restricted to private / loopback hosts unless
 * OLLAMA_ALLOWED_HOSTS names the host explicitly.
 */
const e = (k: string) => (process.env[k] ?? '').trim()

/** Providers the app may talk to, by purpose. Adding a provider is a code change, not a config change. */
export const APPROVED_HOSTS: Record<'email' | 'sms' | 'cloud_llm' | 'supabase_mgmt' | 'storage' | 'shopify' | 'amazon' | 'woocommerce', string[]> = {
  shopify: [], // <shop>.myshopify.com only, checked by suffix below
  amazon: ['api.amazon.com', 'sellingpartnerapi-na.amazon.com', 'sellingpartnerapi-eu.amazon.com', 'sellingpartnerapi-fe.amazon.com'],
  woocommerce: [], // the merchant's own https host; never a private address
  email: ['api.resend.com'],
  sms: ['api.twilio.com', 'messaging.twilio.com'],
  cloud_llm: ['api.openai.com', 'api.anthropic.com'],
  supabase_mgmt: ['api.supabase.com'],
  storage: [], // *.supabase.co, checked by suffix below
}

export class OutboundBlocked extends Error { constructor(public host: string, public purpose: string) { super(`outbound request to ${host} is not approved for ${purpose}`); this.name = 'OutboundBlocked' } }

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function isPrivateHost(host: string): boolean {
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return host.endsWith('.local') || host.endsWith('.internal')
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Throws unless `url` points at a host approved for `purpose`. Returns the host. */
export function assertApprovedHost(url: string, purpose: keyof typeof APPROVED_HOSTS): string {
  const host = hostOf(url)
  let ok: boolean
  if (purpose === 'storage') ok = host.endsWith('.supabase.co') || host.endsWith('.supabase.in')
  else if (purpose === 'shopify') ok = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host) && url.startsWith('https://')
  else if (purpose === 'woocommerce') ok = url.startsWith('https://') && !isPrivateHost(host) && host.includes('.')
  else ok = APPROVED_HOSTS[purpose].includes(host)
  if (!ok) throw new OutboundBlocked(host || url, purpose)
  return host
}

/**
 * The local LLM lane may only reach a private host, or a host named in OLLAMA_ALLOWED_HOSTS
 * (comma-separated; for a self-hosted Ollama behind a private DNS name). Never a public API.
 */
export function assertLocalLlmHost(url: string): string {
  const host = hostOf(url)
  const allowed = e('OLLAMA_ALLOWED_HOSTS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (isPrivateHost(host) || allowed.includes(host)) {
    if (APPROVED_HOSTS.cloud_llm.includes(host)) throw new OutboundBlocked(host, 'local_llm')
    return host
  }
  throw new OutboundBlocked(host || url, 'local_llm')
}
