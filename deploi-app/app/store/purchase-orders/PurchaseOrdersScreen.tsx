'use client'
/**
 * Purchase-order import: upload a CSV, see row-level errors, the POs Deploi has, and the open supplier
 * exceptions on them. Shopify and WooCommerce have no purchase-order API, so this file is the only source.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'

type Line = { id: string; sku: string; match_status: string; qty_ordered: number; qty_confirmed: number | null; qty_received: number; unit_price_ordered: number; unit_price_confirmed: number | null; cancelled: boolean }
type Po = { id: string; po_number: string; supplier_name: string | null; supplier_email: string; status: string; ordered_at: string; expected_at: string | null; confirmed_expected_at: string | null; currency: string; subtotal: number; source: string; lines: Line[] }
type OpenCase = { id: string; ref: string; status: string; title: string; records: { type: string; id: string }[] }
type ListResponse = { purchaseOrders: Po[]; openCases: OpenCase[]; columns: { required: string[]; optional: string[] } }
type ImportResponse = { result: { created: string[]; updated: string[]; unchanged: string[]; rejected: string[]; errors: { row: number | null; column?: string; message: string }[]; matches: { matched: number; unmatched: number; ambiguous: number; noStore: number } }; cases: { opened: number; redetected: number } | null }
type Connections = { connections: { id: string; display_name: string | null; external_id: string; status: string }[] }

const MATCH: Record<string, string> = { matched: 'matched', unmatched: 'not in store', ambiguous: 'ambiguous SKU', no_store: 'no store' }

export function PurchaseOrdersScreen() {
  const { data, error, loading, reload } = useLoad(async () => ({
    list: await storeFetch<ListResponse>('/api/store/purchase-orders'),
    conns: await storeFetch<Connections>('/api/store/overview').catch(() => ({ connections: [] })),
  }), 'purchase-orders')
  const [csv, setCsv] = useState('')
  const [conn, setConn] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ImportResponse | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const header = <PageHeader title="Purchase orders" sub="Import your purchase orders so the Supplier Coordinator can follow up confirmations, quantities, delivery dates and prices with each supplier." />
  if (loading && !data) return <>{header}<Loading label="Loading purchase orders" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  const active = d.conns.connections.filter(c => c.status === 'active')

  async function upload() {
    setBusy(true); setErr(null); setRes(null)
    try {
      setRes(await storeFetch<ImportResponse>('/api/store/purchase-orders', { method: 'POST', body: { csv, connectionId: conn || null } }))
      reload()
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(false) }
  }
  async function readFile(f: File | undefined) { if (f) setCsv(await f.text()) }

  return (
    <>
      {header}
      <Section id="import" title="Import a file" sub={<>One row per line. Required columns: {d.list.columns.required.join(', ')}. Optional: {d.list.columns.optional.join(', ')}. <button type="button" className="underline" onClick={() => { window.location.href = '/api/store/purchase-orders?template=1' }}>Download the template</button>.</>}>
        <Panel>
          <div className="mb-4"><Banner icon="alert">Shopify and WooCommerce have no purchase-order API, so Deploi only knows the orders you import. Importing the same rows again changes nothing; a PO with any bad row is not imported.</Banner></div>
          <div className="grid gap-4">
            <Field label="CSV file" htmlFor="po-file"><input id="po-file" type="file" accept=".csv,text/csv" onChange={e => void readFile(e.target.files?.[0])} /></Field>
            <Field label="Or paste the CSV" htmlFor="po-csv"><Textarea id="po-csv" rows={6} value={csv} onChange={e => setCsv(e.target.value)} /></Field>
            {active.length > 0 && (
              <Field label="Match SKUs against" htmlFor="po-conn" hint="A SKU is matched only when exactly one product variant in the store has it.">
                <Select id="po-conn" value={conn} onChange={e => setConn(e.target.value)}>
                  <option value="">Do not match</option>
                  {active.map(c => <option key={c.id} value={c.id}>{c.display_name ?? c.external_id}</option>)}
                </Select>
              </Field>
            )}
            <div><Button onClick={() => void upload()} disabled={busy || !csv.trim()}>{busy ? 'Importing…' : 'Import'}</Button></div>
          </div>
          {err && <div className="mt-4"><Banner tone="warn">{err.message}</Banner></div>}
          {res && (
            <div className="mt-4 text-[14px] text-ink">
              <p className="m-0">Created {res.result.created.length}, updated {res.result.updated.length}, unchanged {res.result.unchanged.length}, not imported {res.result.rejected.length}.
                {' '}SKUs: {res.result.matches.matched} matched, {res.result.matches.unmatched} not in the store, {res.result.matches.ambiguous} ambiguous.
                {res.cases ? ` Exceptions: ${res.cases.opened} new, ${res.cases.redetected} already open.` : ''}</p>
              {res.result.errors.length > 0 && <ul className="mt-2 list-disc pl-5 text-grey">{res.result.errors.slice(0, 50).map((e, i) => <li key={i}>{e.row ? `Row ${e.row}` : 'File'}{e.column ? ` (${e.column})` : ''}: {e.message}</li>)}</ul>}
            </div>
          )}
        </Panel>
      </Section>
      <Section id="orders" title="Your purchase orders">
        {!d.list.purchaseOrders.length ? <Empty title="No purchase orders yet">Import a file above.</Empty> : (
          <ul className="flex flex-col gap-3">
            {d.list.purchaseOrders.map(po => {
              const cases = d.list.openCases.filter(c => c.records.some(r => r.type === 'purchase_order' && r.id === po.id))
              return (
                <li key={po.id}><Panel>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-ink">PO {po.po_number}</strong><Badge tone="muted">{po.status.replace(/_/g, ' ')}</Badge>
                    {po.source === 'manual' && <Badge tone="muted">draft reorder</Badge>}
                    {cases.map(c => <Badge key={c.id} tone="warn">{c.ref}: {c.title}</Badge>)}
                  </div>
                  <p className="m-0 mt-1 text-[14px] text-grey">{po.supplier_name ? `${po.supplier_name} · ` : ''}{po.supplier_email} · ordered {po.ordered_at}{po.expected_at ? ` · expected ${po.expected_at}` : ''}{po.confirmed_expected_at ? ` · supplier date ${po.confirmed_expected_at}` : ''} · {po.subtotal.toFixed(2)} {po.currency}</p>
                  <ul className="m-0 mt-2 list-none p-0 text-[14px] text-ink">
                    {po.lines.map(l => <li key={l.id} className={l.cancelled ? 'line-through text-grey' : ''}>{l.sku} · ordered {l.qty_ordered}{l.qty_confirmed !== null ? ` · confirmed ${l.qty_confirmed}` : ''} · received {l.qty_received} · {l.unit_price_ordered.toFixed(2)}{l.unit_price_confirmed !== null ? ` (supplier ${l.unit_price_confirmed.toFixed(2)})` : ''} · <span className="text-grey">{MATCH[l.match_status] ?? l.match_status}</span></li>)}
                  </ul>
                </Panel></li>
              )
            })}
          </ul>
        )}
      </Section>
    </>
  )
}
