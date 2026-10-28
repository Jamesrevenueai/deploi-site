/**
 * Production auth guard. Dev auth (the seeded-user picker and its signed cookie) must never be
 * reachable in production. Three layers, all fail closed:
 *  1. next.config.ts calls assertProductionAuth at build time, so a production build with dev
 *     auth configured fails and Vercel keeps serving the previous deployment.
 *  2. instrumentation.ts calls it again when the server starts.
 *  3. resolveAuthMode never returns 'dev' in production, so even if 1 and 2 were bypassed the
 *     picker is hidden, devSignIn refuses and dev cookies are ignored.
 *
 * "Production" is VERCEL_ENV=production (Vercel sets it at build and runtime) or
 * DEPLOI_ENV=production (any other host). NODE_ENV alone is not used: local e2e runs use
 * production builds with dev auth on purpose.
 */
type Env = Record<string, string | undefined>

const v = (e: Env, k: string) => (e[k] ?? '').trim()

export function isProductionDeployment(e: Env = process.env): boolean {
  return v(e, 'VERCEL_ENV') === 'production' || v(e, 'DEPLOI_ENV') === 'production'
}

/** Why dev auth is configured in this environment, or [] when it is not. */
export function devAuthSettings(e: Env = process.env): string[] {
  const out: string[] = []
  if (v(e, 'AUTH_MODE') === 'dev') out.push('AUTH_MODE=dev')
  if (v(e, 'ALLOW_DEV_LOGIN') === 'true') out.push('ALLOW_DEV_LOGIN=true')
  return out
}

export class ProductionAuthError extends Error {
  constructor(settings: string[]) {
    super(`Refusing to run: ${settings.join(' and ')} set in a production environment. Remove ${settings.length > 1 ? 'them' : 'it'} from the Production environment variables and redeploy. Dev sign-in lets anyone pick a user without a password.`)
    this.name = 'ProductionAuthError'
  }
}

/** Throws in production when any dev-auth setting is present. */
export function assertProductionAuth(e: Env = process.env): void {
  if (!isProductionDeployment(e)) return
  const bad = devAuthSettings(e)
  if (bad.length) throw new ProductionAuthError(bad)
}

/** The auth mode the app uses. Never 'dev' in production, whatever the env says. */
export function resolveAuthMode(e: Env = process.env): 'supabase' | 'dev' {
  if (isProductionDeployment(e)) return 'supabase'
  const allowDev = v(e, 'ALLOW_DEV_LOGIN') === 'true'
  const hasSupabase = Boolean(v(e, 'NEXT_PUBLIC_SUPABASE_URL') && v(e, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'))
  if (allowDev && (v(e, 'AUTH_MODE') === 'dev' || !hasSupabase)) return 'dev'
  return 'supabase'
}
