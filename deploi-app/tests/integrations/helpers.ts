/** Integration hub tests: real-looking (non-synthetic) connections whose HTTP goes through fake layers, and cleanup. */
import '../merchant/env'
import { admin } from '../../lib/db'
import { encryptSecret } from '../../lib/connectors/credentials'
import { storeCredential } from '../../lib/connectors/credentials'
import { encodeCreds } from '../../lib/connectors/woocommerce/client'
import { saveOfficeTokens } from '../../lib/office/credentials'
import type { OfficeConnectionRow } from '../../lib/office/connections'
import type { EmailAccountRow } from '../../lib/email/accounts'
import { HUBSPOT_SCOPES } from '../../lib/office/hubspot'
import { NW, HB } from '../merchant/helpers'

export { NW, HB }
export const ORGS = [NW.org, HB.org]

/** A non-synthetic Office connection with a stored token that does not expire soon (no refresh call). */
export async function realOffice(orgId: string, provider: 'hubspot' | 'google_calendar' | 'quickbooks', external = provider === 'quickbooks' ? '9130355' : provider === 'hubspot' ? '4711' : 'owner@example.com') {
  return admin(async db => {
    const row = (await db.one<OfficeConnectionRow>(`insert into office_connections (org_id, provider, is_synthetic, external_account_id, display_name, scopes, calendar_id, timezone, connected_by) values ($1,$2,false,$3,$4,$5,$6,'UTC','test') returning *`,
      [orgId, provider, external, `${provider} test`, provider === 'hubspot' ? [...HUBSPOT_SCOPES] : [], provider === 'google_calendar' ? 'primary' : null]))!
    await saveOfficeTokens(db, row.id, orgId, { accessToken: `${provider}-access-token`, refreshToken: `${provider}-refresh-token`, expiresIn: 3600, scopes: row.scopes })
    return row
  })
}

/** A non-synthetic Gmail or Microsoft account with a stored token. */
export async function realMailbox(orgId: string, provider: 'gmail' | 'microsoft', address: string) {
  return admin(async db => {
    const acc = (await db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1,$2,$3,'active',$4,true,false,false,'test') returning *`,
      [orgId, provider, address, provider === 'gmail' ? ['https://www.googleapis.com/auth/gmail.send'] : ['Mail.Send']]))!
    const enc = encryptSecret(`${provider}-mail-token`, `email-account:${acc.id}:access`)
    await db.query(`insert into email_credentials (account_id, org_id, key_id, ciphertext, scopes, expires_at) values ($1,$2,$3,$4,$5, now() + interval '1 hour')`, [acc.id, orgId, enc.keyId, enc.ciphertext, acc.granted_scopes])
    return acc
  })
}

/** A non-synthetic store connection (its HTTP is routed through a transport override in each test). */
export async function realStore(orgId: string, platform: 'shopify' | 'woocommerce', external: string) {
  return admin(async db => {
    const c = (await db.one<{ id: string }>(`insert into store_connections (org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, installed_at) values ($1,$2,$3,$4,'active',$5,$6,false,now()) returning id`,
      [orgId, platform, external, `${platform} probe store`, platform === 'shopify' ? ['read_products', 'read_inventory', 'read_locations'] : ['read', 'write'], platform === 'shopify' ? '2026-10' : 'wc/v3']))!
    if (platform === 'woocommerce') {
      await db.query(`insert into woo_connections (connection_id, org_id, site_url, auth_mode, connected_via, wc_version, webhook_ids) values ($1,$2,$3,'basic','manual','8.9.1','{11,12,13}')`, [c.id, orgId, external])
      await storeCredential(db, { connectionId: c.id, orgId, secret: encodeCreds({ consumerKey: 'ck_' + 'a'.repeat(40), consumerSecret: 'cs_' + 'b'.repeat(40) }), tokenKind: 'api_key_pair', scopes: ['read', 'write'], actor: 'test' })
    } else {
      await storeCredential(db, { connectionId: c.id, orgId, secret: 'shpat_test_token', tokenKind: 'offline', scopes: ['read_products'], actor: 'test' })
    }
    return c.id
  })
}

/** Remove what these tests created: health rows, the test connections and mailboxes, counters. Seeded rows are kept. */
export async function cleanIntegrations() {
  await admin(async db => {
    await db.query('delete from connection_health where org_id = any($1::uuid[])', [ORGS])
    await db.query('delete from connection_health_state where org_id = any($1::uuid[])', [ORGS])
    await db.query(`delete from store_connections where org_id = any($1::uuid[]) and (external_id like '%probe%' or external_id like '%.integration.example%')`, [ORGS])
    await db.query(`delete from email_accounts where org_id = any($1::uuid[]) and address like '%@integrations.example'`, [ORGS])
    await db.query(`delete from billing_customers where org_id = any($1::uuid[]) and external_id like 'cus_probe%'`, [ORGS])
    await db.query(`delete from workflow_costs where org_id = any($1::uuid[])`, [ORGS])
    await db.query(`update store_connections set status = 'active', status_reason = null, reauth_required_at = null where id = any($1::uuid[])`, [[NW.conn, HB.conn]])
  })
}

/** A fetch fake that records requests and answers from a handler (provider shapes per test). */
export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = []
  const f = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    const h: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { h[k] = v })
    calls.push({ url: u, method: (init.method ?? 'GET').toUpperCase(), headers: h, body: typeof init.body === 'string' ? init.body : null })
    return handler(u, init)
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
