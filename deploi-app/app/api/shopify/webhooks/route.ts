/** Shopify webhooks endpoint (see lib/connectors/shopify/webhooks.ts). */
import { after } from 'next/server'
import { handleShopifyWebhook } from '@/lib/connectors/shopify/webhooks'

export const dynamic = 'force-dynamic'

export function POST(req: Request) {
  return handleShopifyWebhook(req, fn => after(fn))
}
