/**
 * Turning a store's public feed into observations. The feed is untrusted: every field is coerced to the
 * shape and length we expect, unknown fields are dropped, and text is kept as plain text (never HTML,
 * never instructions). A value we cannot read becomes null ("not observed"), never a guess.
 */
import type { ObservedProduct, ObservedVariant } from './types'

const MAX_TEXT = 300

/** Plain text: control characters and tags removed, whitespace collapsed, length capped. */
export function plainText(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  return String(v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** A money amount as the store printed it ("12.00", 12, "1,299.00"), or null. Never negative, never NaN. */
export function money(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/,/g, '').trim() : ''
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(s)) return null
  return Math.round(Number(s) * 100) / 100
}

const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null)
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)
const handleOf = (v: unknown) => (typeof v === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,254}$/u.test(v) ? v : null)

export const ISO_CURRENCY = /^[A-Z]{3}$/
export const currencyOf = (v: unknown) => (typeof v === 'string' && ISO_CURRENCY.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null)

function variantOf(v: Record<string, unknown>): ObservedVariant | null {
  const vid = id(v.id)
  if (!vid) return null
  return {
    id: vid,
    title: plainText(v.title, 120) || 'Default',
    price: money(v.price),
    compareAt: money(v.compare_at_price),
    available: typeof v.available === 'boolean' ? v.available : null,
  }
}

/** One product from /products.json, or null when it lacks an id or handle. */
export function productOf(raw: unknown, origin: string): ObservedProduct | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const pid = id(p.id), handle = handleOf(p.handle)
  if (!pid || !handle) return null
  const tags = (Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',') : []).map(t => plainText(t, 60).toLowerCase()).filter(Boolean).slice(0, 50)
  const variants = (Array.isArray(p.variants) ? p.variants : []).slice(0, 100).map(v => (v && typeof v === 'object' ? variantOf(v as Record<string, unknown>) : null)).filter((v): v is ObservedVariant => Boolean(v))
  return {
    externalId: pid,
    handle,
    title: plainText(p.title, 200) || handle,
    productType: plainText(p.product_type, 80).toLowerCase(),
    vendor: plainText(p.vendor, 80),
    tags,
    publishedAt: iso(p.published_at),
    createdAt: iso(p.created_at),
    url: `${origin}/products/${encodeURIComponent(handle)}`,
    variants,
  }
}

/** Lowest and highest observed price, whether any variant shows a compare-at above its price, and availability counts. */
export function productSummary(variants: ObservedVariant[]) {
  const prices = variants.map(v => v.price).filter((x): x is number => x !== null)
  const onSale = variants.some(v => v.price !== null && v.compareAt !== null && v.compareAt > v.price)
  const known = variants.filter(v => v.available !== null)
  return {
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    onSale,
    availableCount: known.filter(v => v.available).length,
    availabilityKnown: known.length,
    variantCount: variants.length,
  }
}

/** Lowercased word tokens of a product, for keyword matching. */
export function productText(p: Pick<ObservedProduct, 'title' | 'productType' | 'tags'>): string {
  return ` ${[p.title, p.productType, ...p.tags].join(' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
}

/** Does a product mention this keyword or phrase (whole words; a trailing "s" plural also matches)? */
export function matchesKeyword(text: string, keyword: string): boolean {
  const k = keyword.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!k) return false
  return text.includes(` ${k} `) || text.includes(` ${k}s `) || (k.endsWith('s') && text.includes(` ${k.slice(0, -1)} `))
}
