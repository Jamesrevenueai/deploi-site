import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { admin, withUser } from '../../lib/db'
import { prepareDb, SESSIONS } from '../db/helpers'
import { enableProduct, enabledProducts, disableProduct, assertProduct } from '../../lib/products'
import { NW, HB } from '../merchant/helpers'

const ready = await prepareDb()

describe.skipIf(!ready)('org products', () => {
  it('merchants start with Commerce; Office is enabled per organization and isolated by RLS', async () => {
    await admin(db => disableProduct(db, NW.org, 'office'))
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['commerce'])
    await admin(db => enableProduct(db, NW.org, 'office', 'test'))
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['commerce', 'office'])
    await admin(db => assertProduct(db, NW.org, 'office'))
    const seen = await withUser(SESSIONS.harbor, db => db.query<{ org_id: string }>('select org_id from org_products'))
    expect(seen.every(r => r.org_id === HB.org)).toBe(true)
    await admin(db => disableProduct(db, NW.org, 'office'))
    await expect(admin(db => assertProduct(db, NW.org, 'office'))).rejects.toThrow(/not enabled/)
  })
})
