/**
 * Synthetic competitor stores for tests and the local demo. They live on the reserved ".example"
 * domain (RFC 2606), so no real store is ever contacted, and they answer like a Shopify storefront:
 * robots.txt, /products.json, /collections.json and /collections/<handle>/products.json.
 * Each store has numbered snapshots; the collector asks for the snapshot matching how many times the
 * store has been checked, so a demo shows a baseline followed by real changes. Never used in production.
 */
import { isProductionDeployment } from '../auth-guard'
import type { Transport } from './fetch'

type Variant = { price: string; compare_at_price?: string | null; available: boolean }
type Prod = { handle: string; title: string; product_type: string; vendor: string; tags: string[]; published_at: string; variants: Variant[] }
type Snap = { products: Prod[]; collections: { handle: string; title: string; keys: string[] }[] }
type Store = { robots: string; supported: boolean; snapshots: Snap[] }

const SHOPIFY_ROBOTS = `# synthetic storefront
User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkout
Disallow: /account
Disallow: /collections/*sort_by*
Disallow: /search
`
const v = (price: string, extra: Partial<Variant> = {}): Variant => ({ price, compare_at_price: null, available: true, ...extra })
const p = (handle: string, title: string, type: string, price: string | Variant[], published = '2026-09-01T09:00:00Z', tags: string[] = []): Prod =>
  ({ handle, title, product_type: type, vendor: 'Synthetic', tags, published_at: published, variants: typeof price === 'string' ? [v(price)] : price })

const loom0: Prod[] = [
  p('linen-throw-blanket', 'Linen Throw Blanket', 'Throws', '89.00'),
  p('waffle-bath-towel', 'Waffle Bath Towel', 'Bath', '32.00'),
  p('linen-napkins-set-of-4', 'Linen Napkins, Set of 4', 'Table linen', '28.00'),
  p('stonewashed-linen-duvet-cover', 'Stonewashed Linen Duvet Cover', 'Bedding', '210.00'),
  p('herringbone-throw-pillow', 'Herringbone Throw Pillow', 'Cushions', '45.00'),
]
const harbor0: Prod[] = [
  p('stoneware-mug', 'Stoneware Mug', 'Kitchen', '18.00'),
  p('walnut-serving-board', 'Walnut Serving Board', 'Kitchen', '64.00'),
  p('beeswax-food-wraps', 'Beeswax Food Wraps', 'Kitchen', '16.00'),
  p('glass-storage-jar-set', 'Glass Storage Jar Set', 'Kitchen', [v('35.00', { available: false })]),
  p('linen-apron', 'Linen Apron', 'Kitchen', '38.00'),
]
const oak0: Prod[] = [
  p('hand-poured-soy-candle', 'Hand-poured Soy Candle', 'Candles', '32.00'),
  p('linen-room-spray', 'Linen Room Spray', 'Home fragrance', '22.00'),
  p('olive-wood-spoon-set', 'Olive Wood Spoon Set', 'Kitchen', '20.00'),
  p('linen-blend-throw', 'Linen Blend Throw', 'Throws', '72.00'),
]

export const SYNTHETIC_STORES: Record<string, Store> = {
  'linen-and-loom.example': { robots: SHOPIFY_ROBOTS, supported: true, snapshots: [
    { products: loom0, collections: [
      { handle: 'best-sellers', title: 'Best Sellers', keys: ['stonewashed-linen-duvet-cover', 'linen-throw-blanket', 'linen-napkins-set-of-4'] },
      { handle: 'new-arrivals', title: 'New Arrivals', keys: ['herringbone-throw-pillow'] }] },
    { products: [
      p('linen-throw-blanket', 'Linen Throw Blanket', 'Throws', '74.00'),
      p('waffle-bath-towel', 'Waffle Bath Towel', 'Bath', [v('32.00', { available: false })]),
      loom0[2], loom0[3], loom0[4],
      p('ceramic-olive-oil-pourer', 'Ceramic Olive Oil Pourer', 'Kitchen', '24.00', '2026-10-28T15:00:00Z'),
    ], collections: [
      { handle: 'best-sellers', title: 'Best Sellers', keys: ['linen-throw-blanket', 'stonewashed-linen-duvet-cover', 'ceramic-olive-oil-pourer'] },
      { handle: 'new-arrivals', title: 'New Arrivals', keys: ['ceramic-olive-oil-pourer', 'herringbone-throw-pillow'] }] },
  ] },
  'harbor-home.example': { robots: SHOPIFY_ROBOTS, supported: true, snapshots: [
    { products: harbor0, collections: [{ handle: 'best-sellers', title: 'Best Sellers', keys: ['walnut-serving-board', 'stoneware-mug', 'glass-storage-jar-set'] }, { handle: 'sale', title: 'Sale', keys: [] }] },
    { products: [
      harbor0[0], harbor0[1],
      p('beeswax-food-wraps', 'Beeswax Food Wraps', 'Kitchen', [v('12.80', { compare_at_price: '16.00' })]),
      p('glass-storage-jar-set', 'Glass Storage Jar Set', 'Kitchen', '35.00'),
      harbor0[4],
      p('stoneware-oil-pourer', 'Stoneware Oil Pourer', 'Kitchen', '29.00', '2026-10-27T10:00:00Z'),
    ], collections: [
      { handle: 'best-sellers', title: 'Best Sellers', keys: ['stoneware-mug', 'glass-storage-jar-set', 'walnut-serving-board'] },
      { handle: 'sale', title: 'Sale', keys: ['beeswax-food-wraps', 'stoneware-oil-pourer'] }] },
  ] },
  'oak-and-ember.example': { robots: SHOPIFY_ROBOTS, supported: true, snapshots: [
    { products: oak0, collections: [{ handle: 'best-selling', title: 'Best Selling', keys: ['hand-poured-soy-candle', 'linen-blend-throw'] }] },
    { products: [
      p('hand-poured-soy-candle', 'Hand-poured Soy Candle', 'Candles', '36.00'),
      oak0[1], oak0[2], oak0[3],
      p('ceramic-oil-pourer-glazed', 'Ceramic Oil Pourer, Glazed', 'Kitchen', '27.00', '2026-10-28T08:00:00Z'),
    ], collections: [{ handle: 'best-selling', title: 'Best Selling', keys: ['hand-poured-soy-candle', 'ceramic-oil-pourer-glazed', 'linen-blend-throw'] }] },
  ] },
  // a store with no public product feed (not Shopify): reported as unsupported, nothing guessed
  'plain-boutique.example': { robots: 'User-agent: *\nAllow: /\n', supported: false, snapshots: [{ products: [], collections: [] }] },
  // a store whose robots.txt asks crawlers to stay away: never read
  'private-label.example': { robots: 'User-agent: *\nDisallow: /\n', supported: true, snapshots: [{ products: [p('secret-item', 'Secret Item', 'Other', '10.00')], collections: [] }] },
}

/** Synthetic stores answer only outside production, in tests and when demo controls are on. */
export function syntheticAllowed(e: NodeJS.ProcessEnv = process.env): boolean {
  if (isProductionDeployment(e)) return false
  return e.NODE_ENV === 'test' || e.VITEST === 'true' || e.DEMO_CONTROLS === 'true' || e.COMPETITOR_SYNTHETIC === 'on'
}
export const isSyntheticHost = (host: string) => host.endsWith('.example') && host in SYNTHETIC_STORES

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** A transport that answers like the synthetic store at the given snapshot (clamped to the last one). */
export function syntheticTransport(step: number): Transport {
  return async (url) => {
    const u = new URL(url)
    const store = SYNTHETIC_STORES[u.hostname]
    if (!store) return new Response('not found', { status: 404 })
    const snap = store.snapshots[Math.min(Math.max(0, step), store.snapshots.length - 1)]
    if (u.pathname === '/robots.txt') return new Response(store.robots, { status: 200, headers: { 'content-type': 'text/plain' } })
    if (!store.supported) return new Response('<!doctype html><title>Boutique</title><p>Welcome</p>', { status: 200, headers: { 'content-type': 'text/html' } })
    if (u.pathname === '/products.json') return json({ products: Number(u.searchParams.get('page') ?? 1) > 1 ? [] : snap.products })
    if (u.pathname === '/collections.json') return json({ collections: snap.collections.map(c => ({ handle: c.handle, title: c.title })) })
    const m = /^\/collections\/([^/]+)\/products\.json$/.exec(u.pathname)
    if (m) {
      const c = snap.collections.find(x => x.handle === m[1])
      if (!c) return new Response('not found', { status: 404 })
      return json({ products: c.keys.map(k => snap.products.find(x => x.handle === k)).filter(Boolean) })
    }
    return new Response('not found', { status: 404 })
  }
}
