import { describe, it, expect, afterEach } from 'vitest'
import { quickbooksClient } from '../../lib/office/quickbooks'
import { calls, fake, json, path, resetFake } from './fake-http'

const REALM = '4620816365000000001'
const API = `https://quickbooks.api.intuit.com/v3/company/${REALM}`
const rawInvoice = { Id: '130', DocNumber: '1037', TxnDate: '2026-11-05', DueDate: '2026-12-05', TotalAmt: 450, Balance: 450, CustomerRef: { value: '58', name: 'Brightpath' }, BillEmail: { Address: 'ap@brightpath.example' } }

describe('QuickBooks writes and change feed (fake HTTP; no real call is made)', () => {
  afterEach(() => { resetFake(); delete process.env.QUICKBOOKS_ENVIRONMENT })
  let refreshed: string[] = []
  const client = () => { refreshed = []; let n = 1; return quickbooksClient(async () => `qb-${n}`, REALM, { refresh: async r => { refreshed.push(r); n++; return `qb-${n}` } }) }

  it('create invoice: lines, due date and billing address, with a requestid', async () => {
    fake(() => json(200, { Invoice: rawInvoice, time: 'x' }))
    const inv = await client().createInvoice({ customerId: '58', lines: [{ amount: 450, description: 'October maintenance', itemId: '1', qty: 3, unitPrice: 150 }], dueDate: '2026-12-05', billEmail: 'ap@brightpath.example', requestId: 'deploi-act-1' })
    expect(inv).toMatchObject({ id: '130', docNumber: '1037', balance: 450, billEmail: 'ap@brightpath.example' })
    const c = calls[0]
    expect(c.method).toBe('POST')
    expect(path(c)).toBe(`${API}/invoice`)
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ requestid: 'deploi-act-1', minorversion: '75' })
    expect(c.json).toEqual({ CustomerRef: { value: '58' }, Line: [{ Amount: 450, DetailType: 'SalesItemLineDetail', Description: 'October maintenance', SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 3, UnitPrice: 150 } }],
      DueDate: '2026-12-05', BillEmail: { Address: 'ap@brightpath.example' } })
    expect(c.headers.get('authorization')).toBe('Bearer qb-1')
  })

  it('record a payment against an invoice, and refuse bad amounts or a missing requestid', async () => {
    fake(() => json(200, { Payment: { Id: '901', TotalAmt: 450, TxnDate: '2026-11-06', CustomerRef: { value: '58' }, Line: [{ Amount: 450, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] } }))
    expect(await client().recordPayment({ customerId: '58', amount: 450, invoiceId: '130', txnDate: '2026-11-06', requestId: 'pay-130-1' })).toEqual({ id: '901', totalAmt: 450, txnDate: '2026-11-06', customerId: '58', appliedTo: [{ invoiceId: '130', amount: 450 }] })
    expect(path(calls[0])).toBe(`${API}/payment`)
    expect(calls[0].json).toEqual({ CustomerRef: { value: '58' }, TotalAmt: 450, TxnDate: '2026-11-06', Line: [{ Amount: 450, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] })
    await expect(client().recordPayment({ customerId: '58', amount: -5, invoiceId: '130', requestId: 'r' })).rejects.toThrow(/amount/)
    await expect(client().recordPayment({ customerId: '58', amount: 5, invoiceId: '130', requestId: 'has spaces' })).rejects.toThrow(/requestid/)
    await expect(client().createInvoice({ customerId: '58', lines: [], requestId: 'r1' })).rejects.toThrow(/at least one line/)
  })

  it('send invoice posts to /invoice/{id}/send (optionally to another address) and reads the email status', async () => {
    fake(() => json(200, { Invoice: { ...rawInvoice, EmailStatus: 'EmailSent' } }))
    expect(await client().sendInvoice('130', { to: 'billing@brightpath.example', requestId: 'send-130' })).toEqual({ id: '130', emailStatus: 'EmailSent' })
    expect(path(calls[0])).toBe(`${API}/invoice/130/send`)
    expect(calls[0].url.searchParams.get('sendTo')).toBe('billing@brightpath.example')
    expect(calls[0].headers.get('content-type')).toBe('application/octet-stream')
    await expect(client().sendInvoice('13x')).rejects.toThrow(/QuickBooks id/)
  })

  it('a 401 on a write refreshes the token once and repeats it with the same requestid (Intuit does not apply it twice)', async () => {
    fake((_c, n) => n === 1 ? json(401, { Fault: { type: 'AUTHENTICATION', Error: [{ code: '3200' }] } }) : json(200, { Invoice: rawInvoice }))
    const q = client()
    await q.createInvoice({ customerId: '58', lines: [{ amount: 450 }], requestId: 'deploi-act-2' })
    expect(refreshed).toEqual(['qb-1'])
    expect(calls.map(c => [c.headers.get('authorization'), c.url.searchParams.get('requestid')])).toEqual([['Bearer qb-1', 'deploi-act-2'], ['Bearer qb-2', 'deploi-act-2']])
  })

  it('change data capture: invoices and payments changed (or deleted) since a time, at most 30 days back', async () => {
    fake(() => json(200, { CDCResponse: [{ QueryResponse: [
      { Invoice: [{ Id: '130', MetaData: { LastUpdatedTime: '2026-11-05T10:00:00-08:00' } }, { Id: '131', status: 'Deleted', MetaData: { LastUpdatedTime: '2026-11-05T11:00:00-08:00' } }] },
      { Payment: [{ Id: '901', MetaData: { LastUpdatedTime: '2026-11-05T12:00:00-08:00' } }] },
    ] }] }))
    const since = new Date(Date.now() - 3600e3)
    expect(await client().changes(since)).toEqual([
      { entity: 'Invoice', id: '130', deleted: false, updatedAt: '2026-11-05T10:00:00-08:00' },
      { entity: 'Invoice', id: '131', deleted: true, updatedAt: '2026-11-05T11:00:00-08:00' },
      { entity: 'Payment', id: '901', deleted: false, updatedAt: '2026-11-05T12:00:00-08:00' },
    ])
    expect(path(calls[0])).toBe(`${API}/cdc`)
    expect(calls[0].url.searchParams.get('entities')).toBe('Invoice,Payment')
    expect(calls[0].url.searchParams.get('changedSince')).toBe(since.toISOString().replace(/\.\d{3}Z$/, 'Z'))
    await client().changes(new Date('2020-01-01'))
    expect(Date.parse(calls[1].url.searchParams.get('changedSince')!)).toBeGreaterThan(Date.now() - 31 * 864e5)
  })

  it('sandbox companies go to the sandbox host', async () => {
    process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox'
    fake(() => json(200, { Invoice: rawInvoice }))
    await client().sendInvoice('130')
    expect(calls[0].url.host).toBe('sandbox-quickbooks.api.intuit.com')
  })
})
