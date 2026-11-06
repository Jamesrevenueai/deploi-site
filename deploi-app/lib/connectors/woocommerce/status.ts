/** What the connect page shows: connections (no secrets) and the latest authorization attempt. */
import { admin } from '../../db'
import { callbackUrl } from './auth'

export type WooConnectionView = {
  id: string; site_url: string; display_name: string | null; status: string; scopes: string[]; currency: string | null; is_synthetic: boolean
  installed_at: string | null; last_scan_at: string | null; connected_via: string | null; wc_version: string | null; auth_mode: string | null
  webhooks: number; webhooks_error: string | null; has_credential: boolean
}

export async function wooStatusFor(orgId: string) {
  return admin(async db => {
    const connections = await db.query<WooConnectionView>(
      `select c.id, coalesce(w.site_url, c.external_id) as site_url, c.display_name, c.status, c.scopes, c.currency, c.is_synthetic, c.installed_at, c.last_scan_at,
         w.connected_via, w.wc_version, w.auth_mode, coalesce(cardinality(w.webhook_ids), 0) as webhooks, w.webhooks_error,
         exists (select 1 from store_credentials k where k.connection_id = c.id) as has_credential
       from store_connections c left join woo_connections w on w.connection_id = c.id
       where c.org_id = $1 and c.platform = 'woocommerce' order by c.created_at`, [orgId])
    const last = await db.one<{ site_url: string; status: string; status_reason: string | null; created_at: string }>(
      `select site_url, status, status_reason, created_at from woo_auth_states where org_id = $1 order by created_at desc limit 1`, [orgId])
    return { connections, lastAttempt: last, authorizeAvailable: callbackUrl().startsWith('https://') }
  })
}
