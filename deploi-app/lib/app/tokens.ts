/** Design tokens for the logged-in app (approved redesign 2026-11-06). The CSS custom properties in styles/app-tokens.css mirror these. */
export const tokens = {
  font: { body: 'Inter', heading: 'Space Grotesk' },
  backdrop: { base: '#07070D', glowTopLeft: '#2A3BFF', glowTopRight: '#FF4D9D', glowBottomRight: '#FF8A3D' },
  surface: { bg: '#FFFFFF', maxWidth: 1392, radius: 22, shadow: '0 30px 80px rgba(10,10,40,.45)', padX: 28, padY: 24 },
  text: { primary: '#14141F', secondary: '#5C5C70', body: '#2A2A3A' },
  border: { card: '#ECECF2', input: '#E3E3EC', divider: '#F2F2F6' },
  fill: { subtle: '#FAFAFC' },
  button: { primaryBg: '#14141F', primaryText: '#FFFFFF', radius: 12, minHeight: 44 },
  card: { radius: 16, radiusLg: 18 },
  status: {
    working: { bg: '#E6EAFF', text: '#2333A8', label: 'Working' },
    waiting: { bg: '#FFE7D6', text: '#8A3300', label: 'Waiting on you' },
    watching: { bg: '#ECF7F1', text: '#17663F', label: 'Watching' },
    off: { bg: '#F2F2F6', text: '#5C5C70', label: 'Off' },
  },
  proofChip: { bg: '#EEF0FF', text: '#2A35B0' },
  usageBar: 'linear-gradient(90deg, #3A4BE0, #FF4D9D, #FF8A3D)',
  hero: { bg: '#0E0E1A', radius: 20, live: '#5EE6A8', waitingStat: '#FFB27A' },
} as const
