/** All public config comes from Vite env vars. Nothing personal is hardcoded. */
function read(key: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** Default home of the Deploi app. Override with VITE_APP_URL (no trailing slash). */
export const DEFAULT_APP_URL = 'https://app.getdeploi.com'

export const env = {
  /** Base URL of deploi-app, e.g. https://app.getdeploi.com (no trailing slash). */
  appApiUrl: read('VITE_APP_API_URL').replace(/\/+$/, ''),
  /** Where "Sign in" and "Get started" send people. Defaults to app.getdeploi.com. */
  appUrl: (read('VITE_APP_URL') || DEFAULT_APP_URL).replace(/\/+$/, ''),
  /** Calendar booking link. When empty, CTAs scroll to the on-page form. */
  bookingUrl: read('VITE_BOOKING_URL'),
  /** Formspree endpoint, used only when VITE_APP_API_URL is empty. */
  formspreeEndpoint: read('VITE_FORMSPREE_ENDPOINT'),
  legalEntity: read('VITE_LEGAL_ENTITY') || 'Deploi AI',
  legalReviewed: read('VITE_LEGAL_REVIEWED') === 'true',
}

/** App entry points used by the marketing site. */
export function appLinks(base: string = env.appUrl) {
  const b = (base || DEFAULT_APP_URL).replace(/\/+$/, '')
  return { signIn: `${b}/login`, getStarted: `${b}/signup` }
}
