/** TypeScript mirror of deploi-app/styles/tokens.css (charts, inline SVG, the OG image). A test keeps them equal. */
export const TOKENS = {
  color: {
    ground: '#FFFFFF', panel: '#F5F7FF', border: '#E0E7FF', divider: '#EEF2FF',
    inkHeading: '#1E1B4B', inkBody: '#3730A3', inkLabel: '#4F46E5', inkSecondary: '#312E81',
    accent: '#4F46E5', accentHover: '#4338CA', violet: '#7C6BFF',
    chip1: '#EEF2FF', chip2: '#E0E7FF', chip3: '#C7D2FE',
    coral: '#E8734A', coralText: '#9A3412', coralTint: '#FFF1EB',
  },
  font: { ui: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif", mono: "'JetBrains Mono', ui-monospace, monospace" },
  radius: { card: 18, cardSm: 16, hero: 24, button: 12, pill: 999 },
  touch: 44,
} as const
