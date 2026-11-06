'use client'
/** Shows Office only when it is enabled for the organization; otherwise offers to turn it on (that grants no agent anything). */
import { useState, type ReactNode } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel } from '@/components/store/bits'

export function OfficeGate({ children }: { children: ReactNode }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ enabled: boolean }>('/api/office/product'), 'office-product')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<StoreApiError | null>(null)
  if (loading && !data) return <Loading label="Loading Deploi Office" />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (data?.enabled) return <>{children}</>
  return (
    <>
      <PageHeader title="Deploi Office" sub="Agents for your CRM, calendar and inbox: follow up with new HubSpot leads, propose and book meetings, keep HubSpot up to date and draft replies. Every agent starts at drafts only." />
      <Panel>
        <p className="text-[15px] text-grey">Turning Office on for your organization lets you connect HubSpot and Google Calendar and create office agents. It sends nothing and changes nothing by itself.</p>
        {err && <div className="mt-3"><ErrorState error={err} /></div>}
        <Button className="mt-4" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await storeFetch('/api/office/product', { method: 'POST', body: { enable: true } }); await reload() } catch (e) { setErr(asApiError(e)) } finally { setBusy(false) } }}>Turn on Deploi Office</Button>
      </Panel>
    </>
  )
}
