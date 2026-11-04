/**
 * Which Deploi products an organization uses. Commerce = store agents (Shopify, WooCommerce);
 * Office = CRM, calendar and lead follow-up agents. Writes run as the service role after the caller's
 * organization has been checked; reads may run as the user (RLS limits them to their organization).
 */
import type { Db } from '../db'
import { EngineError } from '../engine/errors'

export const PRODUCTS = ['commerce', 'office'] as const
export type Product = (typeof PRODUCTS)[number]
export const isProduct = (v: unknown): v is Product => typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v)

export async function enabledProducts(db: Db, orgId: string): Promise<Product[]> {
  const rows = await db.query<{ product: Product }>(`select product from org_products where org_id = $1 and status = 'active' order by product`, [orgId])
  return rows.map(r => r.product)
}

export async function hasProduct(db: Db, orgId: string, product: Product) {
  return (await enabledProducts(db, orgId)).includes(product)
}

/** Enable a product for an organization (idempotent). `by` is the actor label written to the audit trail. */
export async function enableProduct(db: Db, orgId: string, product: Product, by: string) {
  if (!isProduct(product)) throw new EngineError('invalid_input', 'unknown product')
  await db.query(
    `insert into org_products (org_id, product, enabled_by) values ($1, $2, $3)
     on conflict (org_id, product) do update set status = 'active', disabled_at = null, enabled_by = excluded.enabled_by`,
    [orgId, product, by])
}

export async function disableProduct(db: Db, orgId: string, product: Product) {
  await db.query(`update org_products set status = 'disabled', disabled_at = now() where org_id = $1 and product = $2`, [orgId, product])
}

/** Throws unless the organization has the product enabled. Use at the top of product-specific APIs. */
export async function assertProduct(db: Db, orgId: string, product: Product) {
  if (!(await hasProduct(db, orgId, product))) throw new EngineError('forbidden', `${product === 'office' ? 'Deploi Office' : 'Deploi Commerce'} is not enabled for this organization`)
}
