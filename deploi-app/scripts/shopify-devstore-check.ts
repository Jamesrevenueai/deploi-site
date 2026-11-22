/**
 * Read-only smoke test against a Shopify DEVELOPMENT store: install status, granted scopes, one page of
 * variants (with query cost) and the app's sales channels. It sends queries only, refuses any store
 * Shopify does not report as a development store, and writes nothing to Shopify or to the database.
 *
 *   SHOPIFY_DEVSTORE_SHOP=<store>.myshopify.com SHOPIFY_DEVSTORE_TOKEN=<offline access token> \
 *     npx tsx scripts/shopify-devstore-check.ts
 *
 * Or read the token Deploi stored at install (needs DATABASE_URL and CREDENTIALS_ENCRYPTION_KEY of that environment):
 *
 *   SHOPIFY_DEVSTORE_SHOP=<store>.myshopify.com npx tsx scripts/shopify-devstore-check.ts --from-db
 *
 * An expired token stored by Deploi is NOT refreshed here (refreshing rotates the refresh token, which is a
 * write); open the app in the store admin first so Deploi refreshes it, then run the check.
 * Exit codes: 0 pass, 1 fail, 2 refused or bad input.
 */
import 'dotenv/config'
import { runDevstoreCheck, formatReport } from '../lib/connectors/shopify/devstore-check'
import { normalizeShop } from '../lib/connectors/shopify/auth'

async function tokenFromDb(shop: string): Promise<string> {
  const { admin } = await import('../lib/db')
  const { loadCredential } = await import('../lib/connectors/credentials')
  return admin(async db => {
    const c = await db.one<{ id: string; status: string }>(`select id, status from store_connections where platform = 'shopify' and external_id = $1 and is_synthetic = false`, [shop])
    if (!c) throw new Error(`no Shopify connection for ${shop} in this database (install the app first)`)
    if (c.status !== 'active') throw new Error(`the connection is ${c.status}; open the app in the store admin to reinstall or reauthorize`)
    const cred = await loadCredential(db, c.id)
    if (!cred) throw new Error('no stored token; open the app in the store admin')
    if (cred.expiresAt && new Date(cred.expiresAt).getTime() < Date.now() + 60e3) throw new Error('the stored token has expired; open the app in the store admin (Deploi refreshes it), then run this again')
    return cred.secret
  })
}

async function main() {
  const shop = normalizeShop(process.env.SHOPIFY_DEVSTORE_SHOP)
  if (!shop) { console.error('SHOPIFY_DEVSTORE_SHOP must be <store>.myshopify.com'); process.exit(2) }
  let token = (process.env.SHOPIFY_DEVSTORE_TOKEN ?? '').trim()
  if (process.argv.includes('--from-db')) {
    try { token = await tokenFromDb(shop) } catch (e) { console.error((e as Error).message); process.exit(2) }
  }
  if (!token) { console.error('give SHOPIFY_DEVSTORE_TOKEN, or --from-db'); process.exit(2) }
  const r = await runDevstoreCheck({ shop, accessToken: token, apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10' })
  console.log(formatReport(r))
  process.exit(r.refused ? 2 : r.ok ? 0 : 1)
}

main().catch(e => { console.error((e as Error).message); process.exit(1) })
