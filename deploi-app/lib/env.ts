/** Central env access. Every provider is optional; empty means "mock". */
const e = (k: string, d = '') => (process.env[k] ?? d).trim()

export const env = {
  get databaseUrl() { return e('DATABASE_URL') },
  get supabaseUrl() { return e('NEXT_PUBLIC_SUPABASE_URL') },
  get supabaseAnonKey() { return e('NEXT_PUBLIC_SUPABASE_ANON_KEY') },
  get supabaseServiceKey() { return e('SUPABASE_SERVICE_ROLE_KEY') },
  get hasSupabase() { return Boolean(this.supabaseUrl && this.supabaseAnonKey) },
  /** Vercel sets VERCEL_ENV to production | preview | development. Empty off Vercel. */
  get vercelEnv() { return e('VERCEL_ENV') },
  get isVercelProduction() { return this.vercelEnv === 'production' },
  /**
   * The dev role picker only exists when ALLOW_DEV_LOGIN=true (default off), and never
   * on a Vercel production deployment, whatever the env says.
   */
  get allowDevLogin() { return e('ALLOW_DEV_LOGIN') === 'true' && !this.isVercelProduction },
  /**
   * dev: the role picker. Only when allowed AND (Supabase is not configured OR AUTH_MODE=dev).
   * supabase: real magic-link auth. If Supabase is not configured either, sign-in is closed
   * (authReady false) rather than falling open.
   */
  get authMode(): 'supabase' | 'dev' {
    if (this.allowDevLogin && (e('AUTH_MODE') === 'dev' || !this.hasSupabase)) return 'dev'
    return 'supabase'
  },
  /** False when supabase mode is selected but the Supabase URL/anon key are missing. */
  get authReady() { return this.authMode === 'dev' || this.hasSupabase },
  get appSecret() { return e('APP_SECRET', 'dev-secret') },
  get staffEmails() { return e('STAFF_EMAILS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) },
  get appUrl() { return e('NEXT_PUBLIC_APP_URL', 'http://localhost:3000') },
  get siteUrl() { return e('NEXT_PUBLIC_SITE_URL', 'https://getdeploi.com') },
  get bookingUrl() { return e('BOOKING_URL') },
  get allowedOrigins() { return e('PUBLIC_API_ALLOWED_ORIGINS', 'https://getdeploi.com,https://www.getdeploi.com').split(',').map(s => s.trim()).filter(Boolean) },
  get resendKey() { return e('RESEND_API_KEY') },
  get staffNotifyEmail() { return e('STAFF_NOTIFY_EMAIL', 'hello@getdeploi.com') },
  get twilio() { return { sid: e('TWILIO_ACCOUNT_SID'), token: e('TWILIO_AUTH_TOKEN'), from: e('TWILIO_FROM_NUMBER') } },
  get ollamaUrl() { return e('OLLAMA_URL', 'http://localhost:11434') },
  get ollamaModel() { return e('OLLAMA_MODEL', 'llama3.1:8b') },
  get cloud() { return { provider: e('LLM_CLOUD_PROVIDER'), apiKey: e('LLM_CLOUD_API_KEY'), model: e('LLM_CLOUD_MODEL') } },
  get llmMock() { return e('LLM_MOCK') === '1' },
  get smartleadSecret() { return e('SMARTLEAD_WEBHOOK_SECRET') },
  get cronSecret() { return e('CRON_SECRET') },
  get pricing() {
    return {
      assessment: e('ASSESSMENT_PRICE', '$1,500–2,500'),
      build: e('BUILD_PRICE_RANGE', '$3,000–7,000 per door'),
      retainer: e('RETAINER_RANGE', '$500–1,500 / mo'),
    }
  },
  get evvWindows(): Record<string, number> {
    try { return { OH: 60, ...JSON.parse(e('EVV_CORRECTION_WINDOWS', '{}')) } } catch { return { OH: 60 } }
  },
  get evvToleranceMin() { return Number(e('EVV_DURATION_TOLERANCE_MIN', '15')) || 15 },
  get storageBucket() { return e('STORAGE_BUCKET', 'reports') },
  get isProd() { return process.env.NODE_ENV === 'production' },
}

export const COMPANY_EMAIL = 'hello@getdeploi.com'
export const COMPANY_NAME = 'Deploi AI'
