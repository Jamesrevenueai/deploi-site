/**
 * Discovery detector: supplier exceptions on the organization's imported purchase orders (the only POs Deploi
 * has: Shopify and WooCommerce have no PO API). Reads the PO records only, finds exceptions with the same
 * deterministic rules the Supplier Coordinator uses, and recommends that agent. With no PO imported it finds
 * nothing and says what it needs; it never invents a PO.
 */
import { admin } from '../../db'
import { registerDetector, type Detector } from '../registry'
import { findSupplierExceptions, toFinding, EXCEPTION_LABEL, type ExceptionType } from '../../commerce/supplier-exceptions'

export const SUPPLIER_EXCEPTIONS_DETECTOR = 'commerce.supplier_exceptions'

export const supplierExceptionsDetector: Detector = {
  key: SUPPLIER_EXCEPTIONS_DETECTOR,
  suite: 'commerce',
  sourceApp: 'import',
  async available(db, orgId) {
    return Boolean(await db.one('select 1 from purchase_orders where org_id = $1 limit 1', [orgId]))
  },
  async detect(ctx) {
    const { pos, exceptions } = await admin(db => findSupplierExceptions(db, ctx.orgId, ctx.now))
    if (!pos) {
      return { findings: [], sourcesRead: [], notes: ['No purchase orders are imported: Shopify and WooCommerce have no purchase-order API, so Deploi needs your purchase orders as a CSV.'],
        recommendation: { template: 'supplier_coordinator', suite: 'commerce', name: 'Supplier Coordinator', reason: 'Deploi can watch your purchase orders for missing confirmations, short or partial deliveries, late deliveries and price changes once they are imported.', needs: ['your purchase orders (CSV)'] } }
    }
    const byType = new Map<ExceptionType, number>()
    for (const x of exceptions) byType.set(x.type, (byType.get(x.type) ?? 0) + 1)
    const counts = [...byType].map(([t, n]) => `${n} × ${EXCEPTION_LABEL[t].toLowerCase()}`).join(', ')
    const suppliers = [...new Set(exceptions.map(x => x.po.supplier_email))]
    return {
      findings: exceptions.map(toFinding),
      sourcesRead: ['purchase_orders (import)'],
      recommendation: exceptions.length ? {
        template: 'supplier_coordinator', suite: 'commerce', name: 'Supplier Coordinator',
        reason: `${exceptions.length} exception${exceptions.length === 1 ? '' : 's'} on ${new Set(exceptions.map(x => x.po.id)).size} of your ${pos} imported purchase order${pos === 1 ? '' : 's'}: ${counts}.`,
        needs: [`grant writing to the supplier${suppliers.length === 1 ? '' : 's'} on those orders (${suppliers.slice(0, 5).join(', ')}${suppliers.length > 5 ? ', ...' : ''})`],
      } : null,
    }
  },
}

registerDetector(supplierExceptionsDetector)
