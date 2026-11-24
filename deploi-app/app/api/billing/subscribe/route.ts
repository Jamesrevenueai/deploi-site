import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { createOfficeCheckout, startShopifySubscription } from '@/lib/billing/v2'
import { isOfficePlan, isStorePlan } from '@/lib/pricing'
import { requireAgreements } from '@/lib/legal'
import { engineConfig } from '@/lib/engine/config'

export const dynamic = 'force-dynamic'

/**
 * { plan, interval: 'month'|'year', capCents?, setup? } — the published plans (lib/pricing/catalog.json).
 * Store plans (starter, growth, pro) go through the Shopify Billing API and return Shopify's confirmation URL;
 * Office plans (solo, team, business) return a Stripe Checkout URL. Owners and admins only.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot start billing for a merchant')
    await assertCan(actor, actor.orgId, 'billing')
    const body = await readJson(req)
    if (isStorePlan(body.plan)) {
      // Free at launch: while BILLING_REQUIRED is off no Store merchant is charged, so no Shopify subscription is started
      if (!engineConfig.billingRequired) throw new HttpError(409, 'free_at_launch', 'Deploi is free for Shopify stores during launch: there is nothing to buy yet')
      await requireAgreements(actor, 'commerce')
      const conn = await admin(db => db.one<{ id: string }>(`select id from store_connections where org_id = $1 and platform = 'shopify' and status = 'active' order by created_at limit 1`, [actor.orgId]))
      if (!conn) throw new HttpError(409, 'no_store', 'connect your Shopify store first: Store plans are billed through Shopify')
      const capCents = typeof body.capCents === 'number' ? body.capCents : undefined
      const r = await admin(db => startShopifySubscription(db, { orgId: actor.orgId, connectionId: conn.id, plan: body.plan, interval: body.interval, capCents, returnUrl: `${env.appUrl.replace(/\/$/, '')}/store/billing?shopify=returned`, actor: actor.label }))
      return NextResponse.json({ ok: true, provider: 'shopify', url: r.confirmationUrl, ...r })
    }
    if (isOfficePlan(body.plan)) {
      await requireAgreements(actor, 'office')
      const email = actor.kind === 'profile' ? actor.session.email : null
      const r = await admin(db => createOfficeCheckout(db, { orgId: actor.orgId, plan: body.plan, interval: body.interval, setup: body.setup === true, email, appUrl: env.appUrl, actor: actor.label }))
      return NextResponse.json({ ok: true, provider: 'stripe', ...r })
    }
    throw new HttpError(400, 'invalid_input', 'plan must be one of starter, growth, pro, solo, team, business')
  } catch (e) { return errorResponse(e) }
}
