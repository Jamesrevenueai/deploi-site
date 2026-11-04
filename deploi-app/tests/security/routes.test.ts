/**
 * Static sweep of every API route: each one is classified, and each class must show its guard in the
 * source. Merchant routes resolve the organization from the session (resolveActor) in every handler and
 * never take an organization id from the request; webhooks verify a signature; cron routes check the cron
 * secret. A new route that fits no class fails until it is classified here.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const API = join(ROOT, 'app', 'api')

function routes(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) routes(p, out)
    else if (n === 'route.ts') out.push(relative(ROOT, p))
  }
  return out
}
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')
/** The body of each exported HTTP handler. */
function handlers(text: string): { method: string; body: string }[] {
  const re = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g
  const marks = [...text.matchAll(re)]
  return marks.map((m, i) => ({ method: m[1], body: text.slice(m.index!, i + 1 < marks.length ? marks[i + 1].index : text.length) }))
}

/** Webhook routes and the signature check each must reach. */
const WEBHOOKS: Record<string, { evidence: RegExp; lib?: { file: string; evidence: RegExp } }> = {
  'app/api/shopify/webhooks/route.ts': { evidence: /handleShopifyWebhook/, lib: { file: 'lib/connectors/shopify/webhooks.ts', evidence: /verifyWebhookHmac\(raw/ } },
  'app/api/webhooks/agent-mail/route.ts': { evidence: /verifySvix\(/ },
  'app/api/billing/stripe/webhook/route.ts': { evidence: /verifyStripeSignature\(raw, req\.headers\.get\('stripe-signature'\)/ },
}
/** Routes that are deliberately outside the merchant session, with the guard each must show. */
const OTHER: Record<string, { why: string; evidence: RegExp }> = {
  'app/api/cron/agents/route.ts': { why: 'Vercel cron', evidence: /cronAuthorized\(req\)/ },
  'app/api/cron/library/route.ts': { why: 'Vercel cron', evidence: /cronAuthorized\(req\)/ },
  'app/api/cron/weekly-summary/route.ts': { why: 'Vercel cron', evidence: /cronAuthorized\(req\)/ },
  'app/api/admin/devstore/route.ts': { why: 'dev-store harness, unreachable in production', evidence: /isProductionDeployment/ },
  'app/api/health/route.ts': { why: 'health check, no data', evidence: /export/ },
  'app/api/public/lead/route.ts': { why: 'early-access form via the anon definer function, CORS-limited', evidence: /public_create_(early_access|lead)/ },
  'app/api/shopify/auth/start/route.ts': { why: 'OAuth start: random state cookie', evidence: /randomBytes\(16\)/ },
  'app/api/shopify/auth/callback/route.ts': { why: 'OAuth callback: HMAC + state + shop verified', evidence: /verifyQueryHmac/ },
  'app/api/shopify/session/route.ts': { why: 'embedded app install: Shopify session token verified', evidence: /verifyShopifyBearer\(req\)/ },
  'app/api/email/oauth/callback/route.ts': { why: 'mailbox OAuth callback: session + state', evidence: /resolveActor/ },
  'app/api/email/oauth/synthetic/route.ts': { why: 'synthetic consent page, off unless synthetic mail is allowed', evidence: /syntheticAllowed/ },
}

describe('API route sweep', () => {
  const all = routes(API)

  it('every route is a merchant route, a webhook, or a classified exception', () => {
    const unclassified = all.filter(f => !f.startsWith('app/api/store/') && !f.startsWith('app/api/billing/') && !WEBHOOKS[f] && !OTHER[f])
    expect(unclassified).toEqual([])
    for (const k of [...Object.keys(WEBHOOKS), ...Object.keys(OTHER)]) expect(all, `stale entry ${k}`).toContain(k)
  })

  it('every merchant and billing handler resolves the organization from the session', () => {
    const bad: string[] = []
    for (const f of all.filter(f => (f.startsWith('app/api/store/') || f.startsWith('app/api/billing/')) && !WEBHOOKS[f])) {
      const text = src(f)
      const hs = handlers(text)
      if (!hs.length) bad.push(`${f}: no handler found`)
      // a local helper that resolves the actor counts when the handler calls it with the request
      const helpers = [...text.matchAll(/(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(req[^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].filter(m => /resolveActor\(req/.test(m[2])).map(m => m[1])
      for (const h of hs) if (!/resolveActor\(req/.test(h.body) && !helpers.some(n => new RegExp(`\\b${n}\\(req\\b`).test(h.body))) bad.push(`${f} ${h.method}`)
    }
    expect(bad).toEqual([])
  })

  it('no merchant route takes an organization id from the query or the body', () => {
    const bad: string[] = []
    for (const f of all.filter(f => f.startsWith('app/api/store/') || f.startsWith('app/api/billing/'))) {
      const t = src(f)
      if (/searchParams\.get\(['"](org|orgId|org_id|agencyId|agency_id)['"]\)|body\.(orgId|org_id|agencyId|agency_id)\b/.test(t)) bad.push(f)
    }
    expect(bad).toEqual([])
  })

  it('state-changing merchant handlers pass mutating (CSRF origin check)', () => {
    const bad: string[] = []
    for (const f of all.filter(f => f.startsWith('app/api/store/') || (f.startsWith('app/api/billing/') && !WEBHOOKS[f]))) {
      for (const h of handlers(src(f))) if (h.method !== 'GET' && !/resolveActor\(req, \{ mutating: true \}\)/.test(h.body)) bad.push(`${f} ${h.method}`)
    }
    // reviewed: passes mutating=true through its visibleConnection(req, id, true) helper
    const KNOWN: string[] = ['app/api/store/access/route.ts POST']
    expect(bad.filter(b => !KNOWN.includes(b))).toEqual([])
  })

  it('every webhook verifies a signature before doing anything', () => {
    for (const [f, w] of Object.entries(WEBHOOKS)) {
      expect(src(f), f).toMatch(w.evidence)
      if (w.lib) expect(src(w.lib.file), w.lib.file).toMatch(w.lib.evidence)
    }
    // the Stripe route checks the signature before parsing the body
    const stripe = src('app/api/billing/stripe/webhook/route.ts')
    expect(stripe.indexOf('verifyStripeSignature(raw')).toBeLessThan(stripe.indexOf('JSON.parse(raw)'))
  })

  it('every classified exception shows its guard', () => {
    for (const [f, o] of Object.entries(OTHER)) expect(src(f), `${f} (${o.why})`).toMatch(o.evidence)
  })
})
