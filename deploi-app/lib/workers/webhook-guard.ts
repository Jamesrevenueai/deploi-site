/**
 * Provider webhooks fail closed in production: a missing secret is a 503 ("webhook secret not configured"),
 * never an open door. Outside production a missing secret means "accept unsigned" so local dev and tests work.
 * Pure function so the rule is unit-tested without touching NODE_ENV.
 */
import { NextResponse } from 'next/server'
import { log } from '../log'

export const SECRET_NOT_CONFIGURED = 'webhook secret not configured'

export type GuardResult = { ok: true; verify: boolean } | { ok: false; status: 503; error: string }

export function webhookSecretGuard(name: string, secret: string | null | undefined, isProd: boolean): GuardResult {
  const present = Boolean(secret && secret.trim())
  if (present) return { ok: true, verify: true }
  if (isProd) return { ok: false, status: 503, error: SECRET_NOT_CONFIGURED }
  return { ok: true, verify: false }
}

/** Route-handler helper: returns a response to send when the guard refuses, else null. Logs the refusal (no payload). */
export function guardResponse(name: string, result: GuardResult): NextResponse | null {
  if (result.ok) {
    if (!result.verify) log.warn('webhook.unsigned', { webhook: name })
    return null
  }
  log.error('webhook.secret.missing', { webhook: name })
  return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
}
