/**
 * WooCommerce sends the merchant's browser back here (?success=1|0&user_id=<state token>). The state is
 * finalized if the callback's background step has not done it yet, then the browser goes to the
 * WooCommerce connect page with the outcome. Nothing about another organization's state is revealed.
 */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { parseStateToken, finalizeAuthorization } from '@/lib/connectors/woocommerce/auth'
import { getSession } from '@/lib/auth'
import '@/lib/connectors'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const page = new URL('/store/connect/woocommerce', env.appUrl)
  const parsed = parseStateToken(q.get('user_id'))
  const session = await getSession().catch(() => null)
  const state = parsed ? await admin(db => db.one<{ org_id: string }>('select org_id from woo_auth_states where id = $1', [parsed.id])) : null
  if (!parsed || !state || !session || session.agencyId !== state.org_id) { page.searchParams.set('result', 'unknown'); return NextResponse.redirect(page) }
  if (q.get('success') !== '1') { page.searchParams.set('result', 'declined'); return NextResponse.redirect(page) }
  const f = await finalizeAuthorization(parsed.id).catch(() => null)
  page.searchParams.set('result', f?.status ?? 'unknown')
  return NextResponse.redirect(page)
}
