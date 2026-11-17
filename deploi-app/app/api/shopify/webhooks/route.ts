/** Shopify webhooks endpoint (see lib/connectors/shopify/webhooks.ts). */
import { after } from 'next/server'
import { handleShopifyWebhook } from '@/lib/connectors/shopify/webhooks'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'

/** Valid deliveries are never limited; only signature rejections count toward a per-IP ceiling. */
export async function POST(req: Request) {
  return limitRejectedWebhook(req, await handleShopifyWebhook(req, fn => after(fn)))
}
