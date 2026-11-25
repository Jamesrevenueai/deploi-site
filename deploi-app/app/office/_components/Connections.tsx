'use client'
/**
 * CRMs (HubSpot, Salesforce, Pipedrive, Zoho CRM), Google Calendar, QuickBooks, Buildium, Microsoft 365 mail and
 * calendar, and the mailbox office agents send from. Connecting authorizes no agent: each agent's policy must name it.
 */
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Facts, Loading, Panel, Section } from '@/components/store/bits'
import { StatusBadge, fmt } from './shared'

type Conn = { id: string; provider: string; status: string; status_reason: string | null; is_synthetic: boolean; display_name: string | null; external_account_id: string; scopes: string[]; timezone: string | null; connected_at: string }
type Provider = 'hubspot' | 'salesforce' | 'pipedrive' | 'zoho_crm' | 'google_calendar' | 'quickbooks' | 'buildium'
type Data = { providers: { provider: Provider; label: string; configured: boolean; connection: Conn | null; auth: 'oauth' | 'api_key'; synthetic: boolean; sandboxOnly: boolean }[]
  mailboxes: { id: string; provider: string; address: string; status: string; can_send: boolean; can_read: boolean; is_synthetic: boolean; office_mailbox: boolean; has_calendar: boolean }[]
  outlook: { configured: boolean; calendarAccounts: string[] }
  syntheticAllowed: boolean; officeMailboxAvailable: boolean; liveSends: 'off' | 'allowlist' | 'all' }

const WHAT: Record<string, string> = {
  hubspot: 'Reads leads and contacts; writes notes, tasks, lifecycle and deal stages only when an agent with CRM permission does so.',
  google_calendar: 'Reads only your free/busy times; creates, moves or cancels the meetings an agent books.',
  quickbooks: 'Reads open invoices, payments and customers (QuickBooks Online). Creates an invoice, records a payment or sends an invoice only for actions you approve or grant.',
  salesforce: 'Finds and updates leads and contacts, logs tasks and notes, and moves opportunity stages, only when an agent with CRM permission does so.',
  pipedrive: 'Finds and updates people, logs activities and notes, and moves deal stages, only when an agent with CRM permission does so.',
  zoho_crm: 'Finds and updates leads and contacts, logs tasks and notes, and moves deal stages (any Zoho data center), only when an agent with CRM permission does so.',
  buildium: 'Reads properties, units, leases, tenants, rental applications and work orders. Creates work orders or changes a status only for actions you approve or grant.',
}
const SECTIONS: { title: string; keys: Provider[] }[] = [
  { title: 'CRM', keys: ['hubspot', 'salesforce', 'pipedrive', 'zoho_crm'] },
  { title: 'Calendar, accounting and property management', keys: ['google_calendar', 'quickbooks', 'buildium'] },
]

/** Buildium connects with an API key the owner creates in Buildium (Settings, Application settings, API settings). */
function BuildiumKeyForm({ busy, onSubmit }: { busy: boolean; onSubmit: (clientId: string, clientSecret: string) => void }) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <form className="mt-3 flex flex-col gap-2" onSubmit={e => { e.preventDefault(); onSubmit(id, secret); setSecret('') }}>
      <Field label="Client ID" htmlFor="buildium-client-id"><Input id="buildium-client-id" autoComplete="off" value={id} onChange={e => setId(e.target.value)} /></Field>
      <Field label="Secret" htmlFor="buildium-secret" hint="Create the key in Buildium: Settings, Application settings, API settings. Deploi checks it with one read and stores it encrypted."><Input id="buildium-secret" type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} /></Field>
      <div><Button size="sm" type="submit" disabled={busy || !id.trim() || !secret.trim()}>Connect Buildium</Button></div>
    </form>
  )
}

export function ConnectionsScreen() {
  const q = useSearchParams()
  const { data, error, loading, reload } = useLoad(() => storeFetch<Data>('/api/office/connections'), 'office-connections')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const post = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null)
    try {
      const r = await storeFetch<{ url?: string }>('/api/office/connections', { method: 'POST', body })
      if (r.url) { window.location.assign(r.url); return }
      await reload()
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  const connectOutlook = async () => {
    setBusy('outlook'); setErr(null)
    try {
      const r = await storeFetch<{ url?: string }>('/api/store/email/accounts', { method: 'POST', body: { provider: 'microsoft', read: true, calendar: true, returnTo: '/office/connections' } })
      if (r.url) window.location.assign(r.url)
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  const header = <PageHeader title="Connections" sub="Connect your CRM, calendar, accounting, property management and mailbox. Connecting allows nothing by itself: each agent's permission names what it may use and how." />
  if (loading && !data) return <>{header}<Loading /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  return (
    <>
      {header}
      <div aria-live="polite" className="mb-3 flex flex-col gap-3">
        {q.get('connected') && <Banner icon="check">Connected {d.providers.find(p => p.provider === q.get('connected'))?.label ?? 'the account'}.</Banner>}
        {q.get('error') && <Banner tone="warn">{q.get('error')}</Banner>}
        {q.get('from') === 'setup' && <Banner icon="spark">Connect what you use, then <Link className="underline" href="/store/setup">continue setup</Link>.</Banner>}
        {err && <ErrorState error={err} />}
        {d.liveSends !== 'all' && <Banner tone="warn">Real email sending is {d.liveSends === 'off' ? 'off' : 'limited to test recipients'} in this environment (EMAIL_LIVE_SENDS). Approved emails to real recipients are held and marked failed with the reason.</Banner>}
      </div>
      {SECTIONS.map(sec => (
        <Section key={sec.title} title={sec.title}>
          <div className="grid gap-3 md:grid-cols-2">
            {d.providers.filter(p => sec.keys.includes(p.provider)).map(p => (
              <Panel key={p.provider} tone={p.connection?.status === 'needs_reauth' ? 'warn' : undefined}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[1.05rem]">{p.label}</h3>
                  <span className="flex gap-2">
                    {p.sandboxOnly && <Badge tone="warn">Sandbox only</Badge>}
                    {p.connection ? <StatusBadge status={p.connection.status} /> : p.configured ? <Badge tone="muted">Not connected</Badge> : <Badge tone="warn">Needs setup</Badge>}
                  </span>
                </div>
                <p className="pt-2 text-[14px] text-grey">{WHAT[p.provider]}</p>
                {p.connection && <div className="pt-3"><Facts items={[
                  ['Account', `${p.connection.display_name ?? p.connection.external_account_id}${p.connection.is_synthetic ? ' (synthetic, test only)' : ''}`],
                  ['Connected', fmt(p.connection.connected_at)],
                  ...(p.connection.status_reason ? [['Status', p.connection.status_reason] as [string, string]] : []),
                ]} /></div>}
                {!p.configured && !p.connection && <p className="pt-2 text-[13px] text-grey-h">{p.label} is not set up on this environment yet. See docs/CONNECTIONS.md.</p>}
                {p.auth === 'api_key' && p.configured && (!p.connection || p.connection.status === 'needs_reauth') && (
                  <BuildiumKeyForm busy={busy !== null} onSubmit={(clientId, clientSecret) => void post(`k:${p.provider}`, { op: 'api_key', provider: p.provider, clientId, clientSecret })} />
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {p.auth === 'oauth' && (!p.connection || p.connection.status === 'needs_reauth') && !p.connection?.is_synthetic && <Button size="sm" disabled={!p.configured || busy !== null} onClick={() => post(`c:${p.provider}`, { op: 'connect', provider: p.provider })}>{p.connection ? 'Reconnect' : 'Connect'}</Button>}
                  {!p.connection && p.synthetic && d.syntheticAllowed && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => post(`s:${p.provider}`, { op: 'synthetic', provider: p.provider })}>Use a synthetic one (test)</Button>}
                  {p.connection && <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { if (confirm(`Disconnect ${p.label}? Deploi removes its stored access${p.auth === 'oauth' ? ' and asks ' + p.label + ' to revoke it' : ''}. Queued work that needs it is cancelled.`)) void post(`d:${p.provider}`, { op: 'disconnect', id: p.connection!.id }) }}>Disconnect</Button>}
                </div>
              </Panel>
            ))}
          </div>
        </Section>
      ))}
      <Section title="Microsoft 365 mail and calendar" sub="One Microsoft 365 (Outlook) account gives agents your new mail, including Zillow, Apartments.com and Zumper lead emails, and your calendar. Gmail is coming later.">
        <Panel>
          <p className="text-[14px] text-grey">{d.outlook.calendarAccounts.length ? 'Mail and calendar are connected. Agents see new mail and calendar changes within minutes.' : 'Not connected with mail and calendar yet.'}</p>
          {!d.outlook.configured && <p className="pt-2 text-[13px] text-grey-h">Microsoft 365 is not set up on this environment yet. See docs/CONNECTIONS.md.</p>}
          <div className="mt-3"><Button size="sm" disabled={!d.outlook.configured || busy !== null} onClick={() => void connectOutlook()}>{d.outlook.calendarAccounts.length ? 'Reconnect Microsoft 365' : 'Connect Microsoft 365'}</Button></div>
        </Panel>
      </Section>
      <Section title="Mailbox" sub="The address office agents send from. Replies to it come back to the agents as data: they never change what an agent may do.">
        {d.mailboxes.length === 0 ? <Empty title="No mailbox yet">Create the organization&apos;s Deploi Office mailbox, or connect Gmail or Microsoft 365 in <Link className="underline" href="/store/connections">Commerce connections</Link>.</Empty> : (
          <ul className="flex flex-col gap-2">{d.mailboxes.map(m => (
            <li key={m.id}><Panel><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{m.address}</span><span className="flex gap-2">
              {m.office_mailbox && <Badge>Office mailbox</Badge>}{m.is_synthetic && <Badge tone="warn">Synthetic</Badge>}<StatusBadge status={m.status} /></span></div>
              <div className="pt-1 text-[13px] text-grey-h">{m.can_send ? 'Can send' : 'Cannot send'} · {m.can_read ? 'Notices replies' : 'Does not read replies'}</div></Panel></li>
          ))}</ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {d.officeMailboxAvailable && !d.mailboxes.some(m => m.office_mailbox) && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => post('mb', { op: 'mailbox', kind: 'office' })}>Create the Office mailbox</Button>}
          {d.syntheticAllowed && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => post('mbs', { op: 'mailbox', kind: 'synthetic' })}>Add a synthetic mailbox (test)</Button>}
        </div>
      </Section>
    </>
  )
}
