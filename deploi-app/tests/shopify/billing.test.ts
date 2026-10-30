import { describe, it, expect } from 'vitest'
import { pricingPlansUrl, mapStatus } from '../../lib/connectors/shopify/billing'

describe('Shopify billing preparation', () => {
  it('builds the Shopify-hosted plan page URL and maps statuses conservatively', () => {
    expect(pricingPlansUrl('example-shop.myshopify.com', 'deploi-ai')).toBe('https://admin.shopify.com/store/example-shop/charges/deploi-ai/pricing_plans')
    expect(pricingPlansUrl('example-shop.myshopify.com', '')).toBeNull()
    expect(mapStatus('ACTIVE')).toBe('active')
    expect(mapStatus('PENDING')).toBe('pending')
    expect(mapStatus('SOMETHING_NEW')).toBe('cancelled')
  })
})
