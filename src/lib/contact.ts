import { env } from './env'

export type ContactTopic = 'sales' | 'support' | 'partnership' | 'press' | 'other'
export const CONTACT_TOPICS: { value: ContactTopic; label: string }[] = [
  { value: 'sales', label: 'Sales or a pilot' },
  { value: 'support', label: 'Help with Deploi' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'press', label: 'Press' },
  { value: 'other', label: 'Something else' },
]

/** The contact message, exactly as the app's public contact API receives it. No password or key field exists. */
export type ContactPayload = { name: string; email: string; company?: string; topic: ContactTopic; message: string; website: string; elapsed_ms?: number }

/** The app's rate-limited public contact endpoint, or null when the site has no app API configured. */
export function contactEndpoint(cfg: { appApiUrl: string } = env): string | null {
  return cfg.appApiUrl ? `${cfg.appApiUrl}/api/public/contact` : null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function validateContact(p: ContactPayload): string | null {
  if (!p.name.trim()) return 'Please enter your name.'
  if (!EMAIL_RE.test(p.email.trim())) return 'Please enter a valid email.'
  if (!p.message.trim()) return 'Please write a message.'
  if (p.message.length > 4000) return 'Please keep the message under 4,000 characters.'
  return null
}

export async function submitContact(url: string, p: ContactPayload): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) })
  if (res.status === 429) throw new Error('Too many messages from here. Please try again in a few minutes, or email us.')
  if (!res.ok) throw new Error('We could not send your message. Please try again, or email us.')
}
