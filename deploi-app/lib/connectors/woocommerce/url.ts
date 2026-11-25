/**
 * The merchant types their store address; it becomes the connection's identity (external_id) and the
 * only host the connector ever talks to. Normalised to `https://host[/path]` (WordPress may live in a
 * sub-directory), lower-case host, no trailing slash, no query, no fragment, no credentials, port 443 only.
 * Plain http, IP literals, single-label names and special-use names (localhost, .local, .internal,
 * .test, .example, ...) are refused here; the transport additionally refuses any host that resolves to
 * a private, loopback or otherwise non-public address (lib/net/safe-fetch.ts address rules).
 */
import { isIP } from 'node:net'

export type SiteUrl = { ok: true; siteUrl: string; host: string } | { ok: false; reason: string }

const SPECIAL = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example|localdomain|arpa)$/

export function normalizeSiteUrl(input: unknown): SiteUrl {
  if (typeof input !== 'string') return { ok: false, reason: 'enter your store address' }
  let raw = input.trim()
  if (!raw) return { ok: false, reason: 'enter your store address' }
  if (raw.length > 300) return { ok: false, reason: 'the address is too long' }
  if (/^http:\/\//i.test(raw)) return { ok: false, reason: 'the store must use https (WooCommerce only sends API keys to https stores, and Deploi never sends them over plain http)' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'not a web address' } }
  if (u.protocol !== 'https:') return { ok: false, reason: 'the store must use https' }
  if (u.username || u.password) return { ok: false, reason: 'addresses with a username or password are not allowed' }
  if (u.port && u.port !== '443') return { ok: false, reason: 'only the standard https port is allowed' }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'use the store’s domain name, not an IP address' }
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return { ok: false, reason: 'not a public domain name' }
  if (SPECIAL.test(host)) return { ok: false, reason: 'not a public domain name' }
  // keep a WordPress sub-directory install, drop wp-admin / REST paths people paste by accident
  let path = decodeURI(u.pathname).replace(/\/+$/, '')
  path = path.replace(/\/(wp-admin|wp-json|wp-login\.php|shop|cart|checkout|my-account)(\/.*)?$/i, '')
  if (path && !/^(\/[a-z0-9._~-]+){1,4}$/i.test(path)) return { ok: false, reason: 'the store address has an unexpected path' }
  return { ok: true, siteUrl: `https://${host}${path.toLowerCase()}`, host }
}
