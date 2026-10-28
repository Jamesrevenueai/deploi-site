import { describe, it, expect } from 'vitest'
import { wooBackordersCheck, wooOversoldCheck, wooResourceId, type WooStockRecord } from '../../lib/connectors/woocommerce/checks'
import { amazonListingErrorsCheck, type AmazonListingRecord } from '../../lib/connectors/amazon/checks'
import { plannedConnectors } from '../../lib/connectors/planned'
import { NotOperational } from '../../lib/engine/types'

const woo = (p: Partial<WooStockRecord>): WooStockRecord => ({ resourceType: 'woo_stock_object', resourceId: wooResourceId(p.productId ?? 1, p.variationId ?? null), fetchedAt: 't', productId: 1, variationId: null, name: 'Mug', sku: 'M-1', type: 'simple', status: 'publish', tags: [], manageStock: true, stockQuantity: 0, stockStatus: 'onbackorder', backorders: 'notify', storeManageStock: true, dateModifiedGmt: null, ...p })
const CFG = wooBackordersCheck.parseConfig({})

describe('planned platforms: detection logic (connectors not operational)', () => {
  it('WooCommerce: backorders at zero are flagged only when stock is managed, published, not exempt and stock management is on store-wide', () => {
    const f = wooBackordersCheck.detect(woo({}), CFG, { ruleVersion: 1 })!
    expect(f.correction).toMatchObject({ change: { field: 'backorders', from: 'notify', to: 'no' }, params: { path: '/products/1' } })
    expect(wooBackordersCheck.detect(woo({ variationId: 7 }), CFG, { ruleVersion: 1 })!.correction!.params).toEqual({ path: '/products/1/variations/7' })
    for (const p of [{ stockQuantity: 3 }, { backorders: 'no' }, { status: 'draft' }, { manageStock: 'parent' as const }, { storeManageStock: false }, { tags: ['Pre-Order'] }, { productId: 5 }])
      expect(wooBackordersCheck.detect(woo(p), wooBackordersCheck.parseConfig({ exemptProductIds: [5] }), { ruleVersion: 1 }), JSON.stringify(p)).toBeNull()
    expect(wooBackordersCheck.defaultEnabled).toBe(false)
  })
  it('WooCommerce: negative stock with backorders off goes to a person, never a stock change', () => {
    const f = wooOversoldCheck.detect(woo({ backorders: 'no', stockQuantity: -2 }), {}, { ruleVersion: 1 })!
    expect(f.kind).toBe('needs_person')
    expect(f.correction).toBeUndefined()
  })
  it('Amazon: only errors Amazon itself reports are flagged; suppression or non-buyable raises severity', () => {
    const base: AmazonListingRecord = { resourceType: 'amazon_listing', resourceId: 'sku:A1@ATVPDKIKX0DER', fetchedAt: 't', sellerId: 'S', marketplaceId: 'ATVPDKIKX0DER', sku: 'A1', asin: 'B0TEST', title: 'Lamp', status: ['BUYABLE', 'DISCOVERABLE'], issues: [] }
    expect(amazonListingErrorsCheck.detect({ ...base, issues: [{ code: '90220', message: 'warn', severity: 'WARNING' }] }, {}, { ruleVersion: 1 })).toBeNull()
    expect(amazonListingErrorsCheck.detect({ ...base, issues: [{ code: '90220', message: 'missing', severity: 'ERROR' }] }, {}, { ruleVersion: 1 })!.severity).toBe('medium')
    expect(amazonListingErrorsCheck.detect({ ...base, status: ['DISCOVERABLE'], issues: [{ code: '8541', message: 'x', severity: 'ERROR', enforcements: { actions: [{ action: 'LISTING_SUPPRESSED' }] } }] }, {}, { ruleVersion: 1 })!.severity).toBe('high')
  })
  it('planned connectors refuse every call', async () => {
    for (const c of plannedConnectors) {
      expect(c.operational).toBe(false)
      await expect(c.readResources({} as never, ['x'])).rejects.toBeInstanceOf(NotOperational)
      await expect(c.listResources({} as never).next()).rejects.toBeInstanceOf(NotOperational)
    }
  })
})
