/**
 * The drawn bot for each agent, shared by the app and the website (no imports, so both builds can use it).
 * One body plan for every agent; each agent differs by its hue, head shape and the emblem on its chest.
 * Output is an SVG string built only from the library config (never from user input).
 */
export type BotSpec = { key: string; hue: number; shape: 'round' | 'square' }

const S = 'fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'

/** Chest emblems, drawn around (32, 49) in roughly a 12 x 10 box. */
const EMBLEMS: Record<string, string> = {
  order_tracker: `<path ${S} d="M26.5 45.5 32 43l5.5 2.5v6.5L32 54.5 26.5 52z M26.5 45.5 32 48l5.5-2.5 M32 48v6.5"/>`,
  returns: `<path ${S} d="M29 45.5h5a3.5 3.5 0 0 1 0 7h-6 M31 43.5l-2 2 2 2"/>`,
  listing_writer: `<path ${S} d="M27.5 53.5l1-3.5 6.5-6.5 2.5 2.5-6.5 6.5z M34 44.5l2.5 2.5"/>`,
  inventory_watcher: `<path ${S} d="M26 49s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="32" cy="49" r="1.6" fill="#fff"/>`,
  supplier_chaser: `<path ${S} d="M26.5 45h11v8h-11z M26.5 45.5 32 49.5l5.5-4"/>`,
  customer_care: `<path ${S} d="M27 44.5h10a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5h-5l-3 2.5V52H27a1.5 1.5 0 0 1-1.5-1.5V46a1.5 1.5 0 0 1 1.5-1.5z"/>`,
  campaign: `<path ${S} d="M26.5 47.5h3l6-3v10l-6-3h-3z M29.5 51.5l1 3"/>`,
  promo_manager: `<path ${S} d="M26.5 45h6l5 4.5-5 4.5h-6z"/><circle cx="29.5" cy="49.5" r="1.1" fill="#fff"/>`,
  weekly_insights: `<path ${S} d="M27 54v-4 M31 54v-7 M35 54v-9 M26 54.5h12"/>`,
  payout_fees_checker: `<path ${S} d="M28 43.5h8v11l-2-1.2-2 1.2-2-1.2-2 1.2z M30 47h4 M30 50h4"/>`,
  store_health_checker: `<path ${S} d="M30.2 44.5h3.6v3.2H37v3.6h-3.2v3.2h-3.6v-3.2H27v-3.6h3.2z"/>`,
  ai_visibility: `<path ${S} d="M32 43.5l1.6 4 4 1.5-4 1.5-1.6 4-1.6-4-4-1.5 4-1.5z"/>`,
}
const CUSTOM = `<path ${S} d="M35.5 44.5a3 3 0 0 0-3.9 3.9l-4.6 4.6 1.5 1.5 4.6-4.6a3 3 0 0 0 3.9-3.9l-1.8 1.8-1.5-1.5z"/>`

export function botSvg({ key, hue, shape }: BotSpec): string {
  const h = Math.round(((hue % 360) + 360) % 360)
  const ink = `hsl(${h} 55% 28%)`, body = `hsl(${h} 82% 56%)`, bodyDark = `hsl(${h} 70% 44%)`, light = `hsl(${h} 95% 74%)`
  const rx = shape === 'round' ? 15 : 7
  const antenna = shape === 'round'
    ? `<path d="M32 10V5" stroke="${ink}" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="4" r="2.6" fill="${body}" stroke="${ink}" stroke-width="1.5"/>`
    : `<path d="M26 10l-3-5 M38 10l3-5" stroke="${ink}" stroke-width="2" stroke-linecap="round"/><circle cx="23" cy="4.5" r="2" fill="${body}"/><circle cx="41" cy="4.5" r="2" fill="${body}"/>`
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`
    + antenna
    + `<rect x="10.5" y="20" width="4" height="9" rx="2" fill="${bodyDark}"/><rect x="49.5" y="20" width="4" height="9" rx="2" fill="${bodyDark}"/>`
    + `<rect x="14" y="10" width="36" height="28" rx="${rx}" fill="#fff" stroke="${ink}" stroke-width="2"/>`
    + `<rect x="19" y="16.5" width="26" height="14" rx="7" fill="#0B1020"/>`
    + `<rect class="eye" x="24" y="20.5" width="4.2" height="6" rx="2.1" fill="${light}"/><rect class="eye" x="35.8" y="20.5" width="4.2" height="6" rx="2.1" fill="${light}"/>`
    + `<path d="M29 34.2q3 1.8 6 0" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
    + `<rect x="29" y="38" width="6" height="3" fill="${ink}"/>`
    + `<rect x="18" y="40.5" width="28" height="19" rx="${shape === 'round' ? 9 : 5}" fill="${body}" stroke="${ink}" stroke-width="2"/>`
    + (EMBLEMS[key] ?? CUSTOM)
    + `</svg>`
}
