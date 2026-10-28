/** All public config comes from Vite env vars. Nothing personal is hardcoded. */
function read(key: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  return typeof v === 'string' ? v.trim() : ''
}

export const env = {
  /** Base URL of deploi-app, e.g. https://app.getdeploi.com (no trailing slash). */
  appApiUrl: read('VITE_APP_API_URL').replace(/\/+$/, ''),
  /** Formspree endpoint, used only when VITE_APP_API_URL is empty. */
  formspreeEndpoint: read('VITE_FORMSPREE_ENDPOINT'),
  legalEntity: read('VITE_LEGAL_ENTITY') || 'Deploi AI',
  legalReviewed: read('VITE_LEGAL_REVIEWED') === 'true',
}
