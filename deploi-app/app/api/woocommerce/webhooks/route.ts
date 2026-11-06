/** WooCommerce webhooks endpoint (see lib/connectors/woocommerce/webhooks.ts). */
import { after } from 'next/server'
import { handleWooWebhook } from '@/lib/connectors/woocommerce/webhooks'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

/** Valid deliveries are never limited; only signature rejections count toward a per-IP ceiling. */
export async function POST(req: Request) {
  return limitRejectedWebhook(req, await handleWooWebhook(req, fn => after(fn)))
}
