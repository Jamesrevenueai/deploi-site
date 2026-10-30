/**
 * Competitor store addresses. Only a public https website can be monitored: no IP addresses, no
 * private or local hosts, no credentials in the URL. Whatever the merchant pastes (a product page,
 * a collection, "www." or not), the store is identified by its origin.
 */
import { isPrivateHost } from '../net/outbound'

export const MAX_COMPETITOR_STORES = 10

export type NormalizedStore = { ok: true; url: string; host: string } | { ok: false; input: string; reason: string }

export function normalizeStoreUrl(raw: string): NormalizedStore {
  const input = raw.trim()
  if (!input) return { ok: false, input, reason: 'enter the store address' }
  let u: URL
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`) } catch { return { ok: false, input, reason: 'not a web address' } }
  if (u.protocol === 'http:') u = new URL(u.toString().replace(/^http:/, 'https:'))
  if (u.protocol !== 'https:') return { ok: false, input, reason: 'only web addresses (https) can be monitored' }
  if (u.username || u.password) return { ok: false, input, reason: 'remove the user name or password from the address' }
  if (u.port && u.port !== '443') return { ok: false, input, reason: 'only standard web addresses can be monitored (no port numbers)' }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host.startsWith('[')) return { ok: false, input, reason: 'use the store\'s domain name, not an IP address' }
  if (isPrivateHost(host) || !host.includes('.')) return { ok: false, input, reason: 'this is not a public website' }
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(l => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return { ok: false, input, reason: 'not a valid domain name' }
  return { ok: true, url: `https://${host}`, host }
}

/** Two addresses for the same store (with and without "www.") count once. */
export const storeKey = (host: string) => host.replace(/^www\./, '')
