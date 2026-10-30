/** Central env access. Every provider is optional; empty means "mock". */
import { resolveAuthMode } from './auth-guard'

const e = (k: string, d = '') => (process.env[k] ?? d).trim()

export const env = {
  get databaseUrl() { return e('DATABASE_URL') },
  get supabaseUrl() { return e('NEXT_PUBLIC_SUPABASE_URL') },
  get supabaseAnonKey() { return e('NEXT_PUBLIC_SUPABASE_ANON_KEY') },
  get supabaseServiceKey() { return e('SUPABASE_SERVICE_ROLE_KEY') },
  get hasSupabase() { return Boolean(this.supabaseUrl && this.supabaseAnonKey) },
  /** The dev role picker only exists when ALLOW_DEV_LOGIN=true (default off), and never in production (lib/auth-guard.ts). */
  get allowDevLogin() { return e('ALLOW_DEV_LOGIN') === 'true' },
  get authMode(): 'supabase' | 'dev' { return resolveAuthMode(process.env) },
  /** No default: dev sessions refuse to sign or verify without a strong APP_SECRET (lib/auth.ts). */
  get appSecret() { return e('APP_SECRET') },
  get staffEmails() { return e('STAFF_EMAILS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) },
  get appUrl() { return e('NEXT_PUBLIC_APP_URL', 'http://localhost:3000') },
  get siteUrl() { return e('NEXT_PUBLIC_SITE_URL', 'https://getdeploi.com') },
  get allowedOrigins() { return e('PUBLIC_API_ALLOWED_ORIGINS', 'https://getdeploi.com,https://www.getdeploi.com').split(',').map(s => s.trim()).filter(Boolean) },
  get resendKey() { return e('RESEND_API_KEY') },
  get cronSecret() { return e('CRON_SECRET') },
  get isProd() { return process.env.NODE_ENV === 'production' },
}

export const COMPANY_EMAIL = 'hello@getdeploi.com'
export const COMPANY_NAME = 'Deploi AI'
