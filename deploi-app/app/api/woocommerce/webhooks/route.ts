/** WooCommerce webhooks endpoint (see lib/connectors/woocommerce/webhooks.ts). */
import { after } from 'next/server'
import { handleWooWebhook } from '@/lib/connectors/woocommerce/webhooks'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

export function POST(req: Request) {
  return handleWooWebhook(req, fn => after(fn))
}
