/**
 * Generated artwork for Black Glass cards and the hero. Pure SVG, no photos,
 * no external files: each theme is a dark mesh glow, a faint line motif and a
 * grain layer, returned as a CSS `url(...)` data URI.
 */
export type ArtTheme = 'trend' | 'grid' | 'rings' | 'bars' | 'rows' | 'peaks' | 'blocks' | 'cycle' | 'hero' | 'glow'

const W = 1600
const H = 900

const TINT: Record<ArtTheme, [string, string]> = {
  trend: ['#1B4F42', '#123630'],
  grid: ['#372D73', '#221D4E'],
  rings: ['#1C4169', '#14304F'],
  bars: ['#4C4026', '#2F2819'],
  rows: ['#183566', '#102447'],
  peaks: ['#30323A', '#1B1C22'],
  blocks: ['#264460', '#182C3E'],
  cycle: ['#234E3B', '#173228'],
  hero: ['#152A58', '#0E1A3A'],
  glow: ['#183566', '#102447'],
}

function motif(theme: ArtTheme): string {
  const s = 'stroke="rgba(255,255,255,0.10)" stroke-width="2" fill="none"'
  const sf = 'stroke="rgba(255,255,255,0.06)" stroke-width="1.5" fill="none"'
  switch (theme) {
    case 'trend': {
      const pts = [[120, 700], [380, 600], [620, 640], [860, 430], [1100, 470], [1340, 250], [1520, 300]]
      const line = pts.map(p => p.join(',')).join(' ')
      const dots = pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="rgba(255,255,255,0.22)"/><circle cx="${x}" cy="${y}" r="22" ${sf}/>`).join('')
      return `<polyline points="${line}" ${s}/>${dots}<path d="M120 780 H1520" ${sf}/>`
    }
    case 'grid': {
      let out = ''
      for (let r = 0; r < 5; r++) for (let c = 0; c < 10; c++) {
        const x = 200 + c * 130, y = 240 + r * 120
        const hot = (r * 7 + c * 3) % 9 === 0
        out += `<circle cx="${x}" cy="${y}" r="${hot ? 11 : 6}" fill="rgba(255,255,255,${hot ? 0.28 : 0.09})"/>`
      }
      return out + `<path d="M200 760 H1370" ${sf}/>`
    }
    case 'rings': {
      const rings = [120, 220, 330, 450].map(r => `<circle cx="1180" cy="430" r="${r}" ${sf}/>`).join('')
      return rings + `<path d="M140 720 C 420 520, 640 760, 900 480 S 1180 420, 1180 430" ${s} stroke-dasharray="10 14"/><circle cx="1180" cy="430" r="9" fill="rgba(255,255,255,0.3)"/><circle cx="140" cy="720" r="9" fill="rgba(255,255,255,0.3)"/>`
    }
    case 'bars': {
      const bars = [0, 1, 2, 3, 4].map(i => `<rect x="${220 + i * 240}" y="${640 - i * 70}" width="120" height="${120 + i * 70}" rx="10" fill="rgba(255,255,255,${0.05 + i * 0.02})"/>`).join('')
      return bars + `<path d="M180 780 H1420" ${sf}/>`
    }
    case 'rows': {
      let out = ''
      for (let i = 0; i < 4; i++) {
        const y = 230 + i * 130
        out += `<rect x="180" y="${y}" width="1240" height="90" rx="18" ${sf}/><rect x="210" y="${y + 30}" width="${260 + ((i * 193) % 400)}" height="28" rx="14" fill="rgba(255,255,255,0.10)"/><circle cx="1360" cy="${y + 45}" r="12" fill="rgba(255,255,255,${0.12 + i * 0.05})"/>`
      }
      return out
    }
    case 'peaks':
      return `<path d="M260 640 L560 360 L860 520 L1160 260 L1420 380" ${s}/><circle cx="560" cy="360" r="26" ${sf}/><circle cx="1160" cy="260" r="26" ${sf}/>`
    case 'blocks':
      return [0, 1, 2, 3, 4, 5].map(i => `<rect x="${260 + (i % 3) * 380}" y="${260 + Math.floor(i / 3) * 220}" width="300" height="160" rx="22" ${sf}/>`).join('') + `<path d="M560 340 H640 M940 340 H1020 M560 560 H640 M940 560 H1020" ${s}/>`
    case 'cycle':
      return `<circle cx="800" cy="450" r="260" ${sf}/><circle cx="800" cy="450" r="170" ${sf}/><path d="M800 190 A260 260 0 0 1 1060 450" ${s}/><circle cx="1060" cy="450" r="10" fill="rgba(255,255,255,0.3)"/>`
    case 'glow':
      return ''
    case 'hero':
      return [[120, 140], [340, 80], [720, 190], [1260, 120], [1480, 260], [980, 70], [1560, 640], [60, 560]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="rgba(255,255,255,0.35)"/>`).join('')
  }
}

export function artSvg(theme: ArtTheme): string {
  const [a, b] = TINT[theme]
  const glowA = theme === 'hero' ? 0.95 : 0.82
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<defs>
  <radialGradient id="g1" cx="22%" cy="8%" r="70%"><stop offset="0" stop-color="${a}" stop-opacity="${glowA}"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
  <radialGradient id="g2" cx="92%" cy="92%" r="65%"><stop offset="0" stop-color="${b}" stop-opacity="0.85"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.07"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0.04"/></linearGradient>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.06 0"/></filter>
  <pattern id="lines" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-14)"><rect width="6" height="1" fill="rgba(255,255,255,0.028)"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="#070707"/>
<rect width="${W}" height="${H}" fill="url(#g1)"/>
<rect width="${W}" height="${H}" fill="url(#g2)"/>
<rect width="${W}" height="${H}" fill="url(#lines)"/>
<rect width="${W}" height="${H}" fill="url(#sheen)"/>
${motif(theme)}
<rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>`
}

const cache = new Map<ArtTheme, string>()
/** CSS background value for a theme. */
export function art(theme: ArtTheme): string {
  let v = cache.get(theme)
  if (!v) {
    v = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSvg(theme)).replace(/'/g, '%27')}")`
    cache.set(theme, v)
  }
  return v
}
