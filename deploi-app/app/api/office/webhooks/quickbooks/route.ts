/**
 * Intuit QuickBooks Online webhook (optional). Fails closed: without QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN every
 * delivery is refused (503); with it, only deliveries whose `intuit-signature` matches are processed. A delivery
 * only makes the matching invoice cases due for a fresh QuickBooks read; it never changes a value or sends anything.
 */
import { NextResponse } from 'next/server'
import { log } from '@/lib/log'
import { handleQuickBooksWebhook } from '@/lib/office/quickbooks-webhook'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'
const MAX_BYTES = 512 * 1024

export async function POST(req: Request) {
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  try {
    const r = await handleQuickBooksWebhook(raw, req.headers.get('intuit-signature'))
    if (r.status === 401) { log.warn('office.quickbooks.webhook_rejected', { reason: 'signature' }); return limitRejectedWebhook(req, NextResponse.json(r.body, { status: 401 })) }
    return NextResponse.json(r.body, { status: r.status })
  } catch (e) {
    log.error('office.quickbooks.webhook_failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'processing_failed' }, { status: 500 })
  }
}
