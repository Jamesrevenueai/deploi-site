import { describe, it, expect, afterEach } from 'vitest'
import { quickbooksClient, toInvoice } from '../../lib/office/quickbooks'
import { setOfficeFetch, setOfficeSleep, OfficeHttpError } from '../../lib/office/http'
import { assertApprovedHost } from '../../lib/net/outbound'
import { intuitSignature, parseQuickBooksChanges, verifyIntuitSignature } from '../../lib/office/quickbooks-webhook'

type Call = { url: URL; method: string; headers: Headers; body: string | null }
const calls: Call[] = []
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function fake(answer: (c: Call, n: number) => Response) {
  setOfficeFetch(async (url, init) => {
    const c = { url: new URL(url), method: String(init.method ?? 'GET'), headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : null }
    calls.push(c)
    return answer(c, calls.length)
  })
}
const waits: number[] = []
const rawInvoice = (id: number, o: Record<string, unknown> = {}) => ({ Id: String(id), DocNumber: `INV-${id}`, TxnDate: '2026-09-01', DueDate: '2026-10-01', TotalAmt: 1250, Balance: 1250,
  CurrencyRef: { value: 'USD', name: 'United States Dollar' }, CustomerRef: { value: '58', name: 'Brightpath Studio' }, BillEmail: { Address: 'Accounts@Brightpath.example' },
  LinkedTxn: [{ TxnId: '901', TxnType: 'Payment' }, { TxnId: '77', TxnType: 'Estimate' }], MetaData: { LastUpdatedTime: '2026-10-02T10:00:00-07:00' }, ...o })

describe('QuickBooks Online client (fake HTTP; no real call is made)', () => {
  afterEach(() => { setOfficeFetch(null); setOfficeSleep(null); calls.length = 0; waits.length = 0; delete process.env.QUICKBOOKS_ENVIRONMENT; delete process.env.QUICKBOOKS_MINOR_VERSION })
  const client = () => quickbooksClient(async () => 'access-token-1', '4620816365000000001')

  it('queries open invoices on the bound company with minorversion, paged by STARTPOSITION / MAXRESULTS', async () => {
    fake(c => {
      const start = Number(/STARTPOSITION (\d+)/.exec(c.url.searchParams.get('query') ?? '')![1])
      return json(200, { QueryResponse: { Invoice: start === 1 ? Array.from({ length: 100 }, (_, i) => rawInvoice(i + 1)) : [rawInvoice(101), rawInvoice(102)], startPosition: start }, time: 'x' })
    })
    const p1 = await client().listOpenInvoices({ startPosition: 1, maxResults: 100 })
    expect(p1.invoices).toHaveLength(100)
    expect(p1.next).toBe(101)
    const p2 = await client().listOpenInvoices({ startPosition: p1.next!, maxResults: 100 })
    expect(p2.next).toBeNull()
    const c = calls[0]
    expect(`${c.url.origin}${c.url.pathname}`).toBe('https://quickbooks.api.intuit.com/v3/company/4620816365000000001/query')
    expect(c.url.searchParams.get('query')).toBe("select * from Invoice where Balance > '0' STARTPOSITION 1 MAXRESULTS 100")
    expect(c.url.searchParams.get('minorversion')).toBe('75')
    expect(c.method).toBe('GET')
    expect(c.headers.get('authorization')).toBe('Bearer access-token-1')
    expect(c.headers.get('accept')).toBe('application/json')
    expect(calls[1].url.searchParams.get('query')).toContain('STARTPOSITION 101 MAXRESULTS 100')
    expect(p1.invoices[0]).toEqual({ id: '1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: '2026-10-01', totalAmt: 1250, balance: 1250, currency: 'USD', customerId: '58', customerName: 'Brightpath Studio',
      billEmail: 'accounts@brightpath.example', privateNote: null, linkedPaymentIds: ['901'], updatedAt: '2026-10-02T10:00:00-07:00' })
  })

  it('reads one invoice, payment and customer; the sandbox host and minor version come from the environment', async () => {
    process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox'
    process.env.QUICKBOOKS_MINOR_VERSION = '73'
    fake(c => c.url.pathname.endsWith('/invoice/130') ? json(200, { Invoice: rawInvoice(130, { Balance: 0 }) })
      : c.url.pathname.endsWith('/payment/901') ? json(200, { Payment: { Id: '901', TotalAmt: 1250, TxnDate: '2026-10-20', CustomerRef: { value: '58' }, Line: [{ Amount: 1250, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] } })
      : json(200, { Customer: { Id: '58', DisplayName: 'Brightpath Studio', PrimaryEmailAddr: { Address: 'AP@brightpath.example' }, Active: true } }))
    expect((await client().getInvoice('130'))!.balance).toBe(0)
    expect(await client().getPayment('901')).toEqual({ id: '901', totalAmt: 1250, txnDate: '2026-10-20', customerId: '58', appliedTo: [{ invoiceId: '130', amount: 1250 }] })
    expect(await client().getCustomer('58')).toEqual({ id: '58', displayName: 'Brightpath Studio', email: 'ap@brightpath.example', active: true })
    expect(calls.every(c => c.url.host === 'sandbox-quickbooks.api.intuit.com' && c.url.searchParams.get('minorversion') === '73')).toBe(true)
  })

  it('429 waits (Retry-After, bounded) and retries; 5xx on a read is retried; after the bound it is an error', async () => {
    setOfficeSleep(async ms => { waits.push(ms) })
    fake((_c, n) => n === 1 ? json(429, { Fault: { type: 'ThrottleFault' } }, { 'retry-after': '2' }) : n === 2 ? json(503, {}) : json(200, { Invoice: rawInvoice(5) }))
    expect((await client().getInvoice('5'))!.id).toBe('5')
    expect(calls).toHaveLength(3)
    expect(waits).toEqual([2000, 1000])
    calls.length = 0
    fake(() => json(500, { Fault: { type: 'SystemFault', Error: [{ code: '10000', Message: 'An application error has occurred', Detail: 'customer Brightpath secret detail' }] } }))
    const e = await client().getInvoice('5').catch(x => x as OfficeHttpError)
    expect(e).toBeInstanceOf(OfficeHttpError)
    expect(e).toMatchObject({ code: 'server', status: 500, provider: 'quickbooks' })
    expect((e as Error).message).toContain('SystemFault 10000')
    expect((e as Error).message).not.toMatch(/secret detail|Brightpath/)
    expect(calls).toHaveLength(4) // 1 + 3 retries
  })

  it('classifies errors: 401 is auth (no retry), "Object Not Found" (400 / 610) is a missing record, other 400s are invalid', async () => {
    fake(() => json(401, { Fault: { type: 'AUTHENTICATION', Error: [{ code: '3200' }] } }))
    await expect(client().getInvoice('5')).rejects.toMatchObject({ code: 'auth', status: 401 })
    expect(calls).toHaveLength(1)
    fake(() => json(400, { Fault: { type: 'ValidationFault', Error: [{ code: '610', Message: 'Object Not Found' }] } }))
    expect(await client().getInvoice('5')).toBeNull()
    fake(() => json(400, { Fault: { type: 'ValidationFault', Error: [{ code: '4000' }] } }))
    await expect(client().listOpenInvoices({ startPosition: 1, maxResults: 10 })).rejects.toMatchObject({ code: 'invalid' })
    // ids and the company id are checked before anything reaches a URL
    const before = calls.length
    await expect(client().getInvoice('5/../../x')).rejects.toMatchObject({ code: 'invalid' })
    expect(() => quickbooksClient(async () => 't', '../other')).toThrow()
    expect(calls.length).toBe(before)
  })

  it('only Intuit hosts are approved for QuickBooks', () => {
    for (const u of ['https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke', 'https://quickbooks.api.intuit.com/v3/company/1/query', 'https://sandbox-quickbooks.api.intuit.com/v3/company/1/query'])
      expect(assertApprovedHost(u, 'quickbooks')).toBeTruthy()
    expect(() => assertApprovedHost('https://quickbooks.api.intuit.com.evil.example/v3', 'quickbooks')).toThrow()
    expect(() => assertApprovedHost('https://api.hubapi.com/x', 'quickbooks')).toThrow()
  })

  it('a billing email that is not one plain address is dropped (nobody is reminded)', () => {
    expect(toInvoice(rawInvoice(1, { BillEmail: { Address: 'a@x.example, b@y.example' } })).billEmail).toBeNull()
    expect(toInvoice(rawInvoice(1, { BillEmail: undefined })).billEmail).toBeNull()
  })
})

describe('QuickBooks webhook signature and payload', () => {
  const body = JSON.stringify({ eventNotifications: [{ realmId: '4620816365000000001', dataChangeEvent: { entities: [{ name: 'Invoice', id: '130', operation: 'Update', lastUpdated: '2026-11-05T10:00:00Z' }, { name: 'Customer', id: '58', operation: 'Update' }] } }] })
  it('accepts only the base64 HMAC-SHA256 of the raw body with the verifier token', () => {
    const sig = intuitSignature(body, 'verifier-token')
    expect(verifyIntuitSignature(body, sig, 'verifier-token')).toBe(true)
    expect(verifyIntuitSignature(body, sig, 'other-token')).toBe(false)
    expect(verifyIntuitSignature(`${body} `, sig, 'verifier-token')).toBe(false)
    expect(verifyIntuitSignature(body, null, 'verifier-token')).toBe(false)
    expect(verifyIntuitSignature(body, 'short', 'verifier-token')).toBe(false)
  })
  it('reads changed invoices and payments from both formats and drops anything malformed', () => {
    expect(parseQuickBooksChanges(JSON.parse(body))).toEqual([{ realmId: '4620816365000000001', entity: 'invoice', id: '130' }])
    expect(parseQuickBooksChanges([{ type: 'qbo.payment.created.v1', intuitaccountid: '4620816365000000001', intuitentityid: '901' }, { type: 'qbo.invoice.updated.v1', intuitaccountid: 'x; drop', intuitentityid: '1' }]))
      .toEqual([{ realmId: '4620816365000000001', entity: 'payment', id: '901' }])
    expect(parseQuickBooksChanges({ nothing: true })).toEqual([])
  })
})
