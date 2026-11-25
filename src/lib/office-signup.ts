import { env } from './env'

/** Service-business sign-up, exactly as the app's /api/public/office-signup receives it. No password or key field. */
export type BusinessType = 'home_services' | 'property_manager' | 'real_estate_agent' | 'leasing_agent' | 'office'
export type Trade = 'hvac' | 'construction' | 'landscaping' | 'roofing' | 'cleaning' | 'general'
export type Tool = 'outlook' | 'google' | 'quickbooks' | 'hubspot' | 'salesforce' | 'pipedrive' | 'zoho' | 'buildium' | 'other'

/** What a visitor picks: one choice sets the business type and, for the trades, the trade. */
export const BUSINESS_CHOICES: { value: string; label: string; type: BusinessType; trade?: Trade }[] = [
  { value: 'hvac', label: 'HVAC', type: 'home_services', trade: 'hvac' },
  { value: 'construction', label: 'Construction or remodeling', type: 'home_services', trade: 'construction' },
  { value: 'landscaping', label: 'Landscaping', type: 'home_services', trade: 'landscaping' },
  { value: 'roofing', label: 'Roofing', type: 'home_services', trade: 'roofing' },
  { value: 'cleaning', label: 'Cleaning', type: 'home_services', trade: 'cleaning' },
  { value: 'trades_other', label: 'Another trade', type: 'home_services', trade: 'general' },
  { value: 'property_manager', label: 'Property management', type: 'property_manager' },
  { value: 'real_estate_agent', label: 'Real estate agent', type: 'real_estate_agent' },
  { value: 'leasing_agent', label: 'Leasing or apartment locating', type: 'leasing_agent' },
  { value: 'office', label: 'Other office or service business', type: 'office' },
]
export const TOOLS: { value: Tool; label: string }[] = [
  { value: 'outlook', label: 'Outlook / Microsoft 365' },
  { value: 'google', label: 'Gmail / Google Calendar' },
  { value: 'quickbooks', label: 'QuickBooks' },
  { value: 'hubspot', label: 'HubSpot' },
  { value: 'salesforce', label: 'Salesforce' },
  { value: 'pipedrive', label: 'Pipedrive' },
  { value: 'zoho', label: 'Zoho CRM' },
  { value: 'buildium', label: 'Buildium' },
  { value: 'other', label: 'Something else' },
]

export type OfficeSignupPayload = {
  name: string; email: string; company: string; phone: string | null
  business_type: BusinessType; trade: Trade | null; tools: Tool[]; message?: string
  website: string; elapsed_ms?: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function officeSignupPayload(fd: FormData): OfficeSignupPayload | { error: string } {
  const s = (k: string) => String(fd.get(k) ?? '').trim()
  const choice = BUSINESS_CHOICES.find(c => c.value === s('business'))
  const tools = TOOLS.map(t => t.value).filter(v => fd.getAll('tools').map(String).includes(v))
  if (!s('name')) return { error: 'Please enter your name.' }
  if (!EMAIL_RE.test(s('email'))) return { error: 'Please enter a valid work email.' }
  if (!s('company')) return { error: 'Please enter your business name.' }
  if (!choice) return { error: 'Please choose what kind of business you run.' }
  const phone = s('phone').replace(/[\s\-().]/g, '')
  if (phone && !/^\+?[1-9][0-9]{6,14}$/.test(phone)) return { error: 'Please enter your mobile number with the country code, for example +1 555 010 0100.' }
  return {
    name: s('name'), email: s('email'), company: s('company'), phone: phone ? (phone.startsWith('+') ? phone : `+${phone}`) : null,
    business_type: choice.type, trade: choice.trade ?? null, tools, message: s('message') || undefined, website: s('website'),
  }
}

export const officeSignupUrl = (cfg: { appApiUrl: string } = env) => (cfg.appApiUrl ? `${cfg.appApiUrl}/api/public/office-signup` : '')

export async function submitOfficeSignup(p: OfficeSignupPayload, opts: { fetchImpl?: typeof fetch; url?: string } = {}): Promise<{ ok: true }> {
  const url = opts.url ?? officeSignupUrl()
  if (!url) throw new Error('Sign-up is not available yet. Please email us instead.')
  const res = await (opts.fetchImpl ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) })
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many attempts. Please try again in a few minutes.' : 'We could not send that. Please try again, or email us.')
  return { ok: true }
}
