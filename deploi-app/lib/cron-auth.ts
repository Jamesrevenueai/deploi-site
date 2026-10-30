/**
 * Cron authentication. Vercel sends `Authorization: Bearer ${CRON_SECRET}`. Without a CRON_SECRET, cron routes
 * are open only on a developer machine: any Vercel deployment (production or preview) or DEPLOI_ENV=production
 * refuses, so a missing secret fails closed instead of exposing the jobs.
 */
import { timingSafeEqual } from 'node:crypto'
import { isProductionDeployment } from './auth-guard'

export function cronAuthorized(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  const secret = (env.CRON_SECRET ?? '').trim()
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (secret) {
    const a = Buffer.from(got), b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  return !isProductionDeployment(env) && !(env.VERCEL_ENV ?? '').trim()
}
