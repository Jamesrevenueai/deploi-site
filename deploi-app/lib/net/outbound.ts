/**
 * Outbound request boundary. Every network call the app makes to a third party goes through
 * assertApprovedHost() first, so a misconfigured URL cannot send data to an unapproved provider.
 */

/** Providers the app may talk to, by purpose. Adding a provider is a code change, not a config change. */
export const APPROVED_HOSTS: Record<'email' | 'supabase_mgmt' | 'shopify' | 'amazon' | 'woocommerce' | 'competitor_public', string[]> = {
  shopify: [], // <shop>.myshopify.com only, checked by suffix below
  amazon: ['api.amazon.com', 'sellingpartnerapi-na.amazon.com', 'sellingpartnerapi-eu.amazon.com', 'sellingpartnerapi-fe.amazon.com'],
  woocommerce: [], // the merchant's own https host; never a private address
  email: ['api.resend.com'],
  supabase_mgmt: ['api.supabase.com'],
  competitor_public: [], // a public https store the merchant chose to monitor; never a private address or an IP, and never a provider above
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
  if (purpose === 'shopify') ok = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host) && url.startsWith('https://')
  else if (purpose === 'woocommerce') ok = url.startsWith('https://') && !isPrivateHost(host) && host.includes('.')
  else if (purpose === 'competitor_public') ok = url.startsWith('https://') && !isPrivateHost(host) && host.includes('.') && !/^[\d.]+$/.test(host) && !host.includes(':')
    && !Object.values(APPROVED_HOSTS).flat().includes(host) && !host.endsWith('.supabase.co')
  else ok = APPROVED_HOSTS[purpose].includes(host)
  if (!ok) throw new OutboundBlocked(host || url, purpose)
  return host
}
