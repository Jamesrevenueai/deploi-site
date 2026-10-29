/**
 * Shopify requires the App Bridge script tag "before any other script tags". Next.js/React always
 * emit their own async chunk scripts at the top of <head>, so the embedded document is post-processed:
 * the shopify-api-key meta and the App Bridge script are moved to the very start of <head>.
 * Pure string work; safe on any HTML (returns it unchanged when there is nothing to move).
 */
export const APP_BRIDGE_SRC = 'https://cdn.shopify.com/shopifycloud/app-bridge.js'

const SCRIPT = /<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>/
const META = /<meta name="shopify-api-key" content="[^"<>]*"\/?>/

export function appBridgeFirst(html: string): string {
  const script = html.match(SCRIPT)?.[0]
  const head = html.match(/<head(\s[^>]*)?>/)
  if (!script || !head || head.index === undefined) return html
  const meta = html.match(META)?.[0] ?? ''
  const rest = html.replace(SCRIPT, '').replace(META, '')
  const at = rest.indexOf(head[0]) + head[0].length
  // keep <meta charset> first if it is the first thing in <head> (it must be in the first 1024 bytes anyway)
  const charset = rest.slice(at).match(/^<meta charSet="[^"]*"\/>/i)?.[0] ?? ''
  const insertAt = at + charset.length
  return rest.slice(0, insertAt) + meta + script + rest.slice(insertAt)
}
