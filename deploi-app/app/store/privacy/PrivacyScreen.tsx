'use client'
/**
 * Privacy requests (/store/privacy): Shopify's customer data requests and erasures for this business. A data
 * request becomes an export of everything Deploi holds for that customer; you download it here and send it to
 * the customer yourself (Deploi sends nothing). Erasures show what was deleted or anonymized, per table.
 * Customers appear only as a one-way hash: no address is shown or stored here.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Section } from '@/components/store/bits'
import { fmtTime } from '@/components/store/format'

type ExportRow = { id: string; shop: string; subjectHash: string; summary: Record<string, number>; sizeBytes: number; createdAt: string; expiresAt: string; downloadedAt: string | null; downloadedBy: string | null; downloads: number }
type RequestRow = { id: string; topic: string; status: string; receivedAt: string; completedAt: string | null; subjectHash: string | null; result: Record<string, unknown> }
type PrivacyResponse = { ok: true; exports: ExportRow[]; requests: RequestRow[] }

const TABLE_WORDS: Record<string, string> = {
  email_messages: 'agent emails', email_inbound: 'emails received', email_suppressions: 'opt-outs', office_leads: 'leads', office_meetings: 'meetings', office_invoices: 'invoices',
  office_actions: 'Office actions', library_actions: 'agent drafts and reports', library_chat_messages: 'chat messages', cases: 'cases', case_events: 'case history entries', engine_audit: 'audit entries', engine_audit_retained: 'audit entries kept for audit', privacy_exports: 'earlier exports',
}
const counted = (m: Record<string, unknown> | undefined) => Object.entries(m ?? {}).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${TABLE_WORDS[k] ?? k}`).join(', ') || 'nothing'

export function PrivacyScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<PrivacyResponse>('/api/store/privacy'), 'privacy')
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const header = <PageHeader title="Privacy requests" sub="When a customer asks Shopify for their data, or to be erased, Deploi answers here. You download each export and send it to the customer yourself." />
  if (loading && !data) return <>{header}<Loading label="Loading privacy requests" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null

  async function download(x: ExportRow) {
    setBusy(x.id); setNote(null)
    try {
      const r = await storeFetch<{ filename: string; data: unknown }>(`/api/store/privacy/${x.id}`)
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url)
      setNote({ tone: 'info', text: 'Downloaded. Send it to the customer through your usual support channel; Deploi does not send it.' })
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null); await reload() }
  }

  return (
    <>
      {header}
      <div className="mb-4"><Banner tone="info">Deploi does not read your Shopify customers or orders. A customer can appear only where your agents worked with their address: agent email, drafts, cases and Office records. Exports are encrypted and kept until the date shown.</Banner></div>
      <div aria-live="polite">{note && <div className="mb-4"><Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner></div>}</div>
      <Section id="exports" title="Customer data exports" sub="Shopify gives you 30 days to answer a data request.">
        {data.exports.length ? (
          <ul className="flex flex-col gap-3" aria-label="Customer data exports">
            {data.exports.map(x => (
              <li key={x.id} className="panel p-4" data-export={x.id}>
                <div className="flex flex-wrap items-center gap-2"><strong>Customer {x.subjectHash.slice(0, 10)}</strong><Badge tone={x.downloadedAt ? 'ok' : 'warn'}>{x.downloadedAt ? 'Downloaded' : 'Not downloaded yet'}</Badge></div>
                <p className="pt-1 text-[14px] text-grey">Holds {counted(x.summary)}. Requested {fmtTime(x.createdAt)} for {x.shop}; kept until {fmtTime(x.expiresAt)}.</p>
                {x.downloadedAt && <p className="text-[12.5px] text-grey-h">Last downloaded {fmtTime(x.downloadedAt)} by {x.downloadedBy}</p>}
                <div className="pt-2"><Button size="xs" onClick={() => download(x)} disabled={busy === x.id}>Download JSON</Button></div>
              </li>
            ))}
          </ul>
        ) : <Empty title="No data requests">When a customer asks Shopify for their data, the export appears here.</Empty>}
      </Section>
      <Section id="requests" title="All requests" sub="Every customer request Shopify sent, and what Deploi did.">
        {data.requests.length ? (
          <ul className="flex flex-col gap-2" aria-label="Privacy requests">
            {data.requests.map(r => (
              <li key={r.id} className="rounded-[12px] border border-line p-3 text-[14px]" data-request={r.topic}>
                <div className="font-medium">{r.topic === 'customers/redact' ? 'Erase a customer' : 'Customer data request'} · {r.status === 'completed' ? 'done' : r.status}</div>
                <div className="text-[13px] text-grey">{r.topic === 'customers/redact' ? `Erased or anonymized: ${counted(r.result.tables as Record<string, unknown>)}` : r.result.customer_data_held === false ? 'Nothing was held for this customer.' : `Exported: ${counted(r.result.tables as Record<string, unknown>)}`}</div>
                <div className="text-[12px] text-grey-h">Received {fmtTime(r.receivedAt)}{r.subjectHash ? ` · customer ${r.subjectHash.slice(0, 10)}` : ''}</div>
              </li>
            ))}
          </ul>
        ) : <Empty title="No requests yet">Shopify sends these when a customer uses their privacy rights.</Empty>}
      </Section>
    </>
  )
}
