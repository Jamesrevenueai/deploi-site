/** Email connector configuration from the environment. Nothing here has a secret default. */
const e = (k: string) => (process.env[k] ?? '').trim()

export const emailConfig = {
  get googleClientId() { return e('GOOGLE_OAUTH_CLIENT_ID') },
  get googleClientSecret() { return e('GOOGLE_OAUTH_CLIENT_SECRET') },
  get microsoftClientId() { return e('MICROSOFT_OAUTH_CLIENT_ID') },
  get microsoftClientSecret() { return e('MICROSOFT_OAUTH_CLIENT_SECRET') },
  /** "common" accepts work, school and personal Microsoft accounts */
  get microsoftTenant() { return e('MICROSOFT_OAUTH_TENANT') || 'common' },
  get redirectUrl() { return e('EMAIL_OAUTH_REDIRECT_URL') || `${(e('APP_URL') || e('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000').replace(/\/$/, '')}/api/email/oauth/callback` },
  /**
   * Real sends are off unless explicitly enabled: "off" (default), "allowlist" (only to
   * EMAIL_TEST_RECIPIENTS addresses or @domains) or "all" (production). Synthetic accounts never send.
   */
  get liveSends(): 'off' | 'allowlist' | 'all' { const v = e('EMAIL_LIVE_SENDS'); return v === 'all' || v === 'allowlist' ? v : 'off' },
  get testRecipients() { return e('EMAIL_TEST_RECIPIENTS').split(',').map(x => x.trim().toLowerCase()).filter(Boolean) },
  /** synthetic accounts can be connected (demo and tests); never in production unless demo controls are on */
  get syntheticAllowed() { return e('NODE_ENV') !== 'production' || e('DEMO_CONTROLS') === 'true' || e('VERCEL_ENV') === 'preview' },
  /**
   * Gmail and Microsoft 365 connectors are kept in the code but are NOT live-verified and are off by
   * default: they appear only when EMAIL_OAUTH_PROVIDERS=on (and their OAuth clients are configured).
   */
  get oauthProvidersEnabled() { return e('EMAIL_OAUTH_PROVIDERS') === 'on' },
  /** Agent mailboxes: each agent gets <name>.<code>@AGENT_MAIL_DOMAIN, sent through Resend. */
  get agentMailDomain() { return e('AGENT_MAIL_DOMAIN').toLowerCase().replace(/^@/, '') },
  get resendKey() { return e('RESEND_API_KEY') },
  /** svix signing secret of the Resend webhook that delivers email.received for the agent mail domain */
  get agentMailWebhookSecret() { return e('AGENT_MAIL_WEBHOOK_SECRET') },
  maxMessageBytes: 3_000_000,
  maxAttempts: 4,
  reconcileWindowMs: 30 * 60e3,
}

/** Would a real provider send to these recipients be allowed in this environment? */
export function liveSendAllowed(recipients: string[]): { ok: true } | { ok: false; reason: string } {
  const mode = emailConfig.liveSends
  if (mode === 'all') return { ok: true }
  if (mode === 'off') return { ok: false, reason: 'real email sending is turned off in this environment (EMAIL_LIVE_SENDS)' }
  const allow = emailConfig.testRecipients
  const bad = recipients.filter(r => { const a = r.toLowerCase(); return !allow.includes(a) && !allow.includes('@' + (a.split('@')[1] ?? '')) })
  return bad.length ? { ok: false, reason: `only test recipients may receive email in this environment; not allowed: ${bad.length} recipient(s)` } : { ok: true }
}
