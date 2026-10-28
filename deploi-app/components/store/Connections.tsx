'use client'
/**
 * Connections (/store/connections, /shopify/connections): the store connection and the email accounts
 * agents may send from. Connecting an account authorizes no agent; each agent's authorization must
 * name it. Health, granted permissions and usage are shown per account, with check, reconnect, add
 * read access and disconnect controls.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { storeFetch, asApiError, StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, NoStore, Panel, Section, useStore } from './bits'
import { ConnectionDetails } from './Connect'
import { useEmailConnect, returnNotice } from './emailConnect'
import { EMAIL_PROVIDER_STATUS_WORDS, emailAccountWords, fmtAgo, fmtTime } from './format'
import type { EmailAccountsResponse, EmailAccountView, EmailConnectResponse, EmailDisconnectResponse, EmailProviderView, OverviewResponse } from './types'

type Notice = { ok: true; text: string } | { ok: false; e: StoreApiError; what: string } | null

export function ConnectionsScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(async () => {
    const [o, email] = await Promise.all([
      storeFetch<OverviewResponse>('/api/store/overview'),
      storeFetch<EmailAccountsResponse>('/api/store/email/accounts'),
    ])
    return { o, email }
  }, 'connections')
  const connect = useEmailConnect(async () => { await reload() })
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<EmailAccountView | null>(null)

  // after a standalone redirect the OAuth callback comes back with ?email=connected or ?email=<code>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const code = q.get('email')
    if (!code) return
    const r = returnNotice(code)
    setNotice(r.ok ? { ok: true, text: r.text } : { ok: false, e: new StoreApiError(0, code, r.text), what: 'Not connected' })
    q.delete('email')
    const rest = q.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  }, [])

  const header = <PageHeader title="Connections" sub="Your store, and the email accounts your agents may send from. Connecting an account lets no agent use it until you grant that agent permission." />
  if (loading && !data) return <>{header}<Loading label="Loading connections" rows={3} /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const { o, email } = data
  const canAct = o.actor.canApprove
  const returnTo = `${base}/connections`

  async function act(key: string, what: string, run: () => Promise<string>) {
    setBusy(key); setNotice(null); connect.setNotice(null)
    try { setNotice({ ok: true, text: await run() }) } catch (e) { setNotice({ ok: false, e: asApiError(e), what }) } finally { setBusy(null); await reload() }
  }
  const check = (a: EmailAccountView) => act(`check:${a.id}`, 'Check did not finish', async () => {
    const r = await storeFetch<{ account: EmailAccountView }>(`/api/store/email/accounts/${a.id}/check`, { method: 'POST', body: {} })
    return r.account.status === 'active' ? `${a.address}: the provider accepted the check. Nothing was sent.` : `${a.address}: ${emailAccountWords(r.account.status).label.toLowerCase()}${r.account.status_reason ? ` (${r.account.status_reason})` : ''}. Nothing was sent.`
  })
  const disconnect = (a: EmailAccountView) => act(`disconnect:${a.id}`, 'Not disconnected', async () => {
    const r = await storeFetch<EmailDisconnectResponse>(`/api/store/email/accounts/${a.id}/disconnect`, { method: 'POST', body: {} })
    setConfirm(null)
    const cancelled = r.messagesCancelled ? ` ${r.messagesCancelled} unsent message${r.messagesCancelled === 1 ? ' was' : 's were'} cancelled.` : ' No unsent messages were waiting.'
    const revoke = r.revokedAtProvider === 'revoked' ? ' Access was also revoked at the provider.'
      : r.revokedAtProvider === 'not_supported' ? (a.provider === 'microsoft' ? ' Microsoft does not let Deploi revoke access itself: also remove Deploi from the apps that can access your Microsoft account (account settings, privacy, apps and services).' : ' This provider does not let Deploi revoke access itself: also remove Deploi from the apps with access in your account settings.')
      : ' Deploi could not confirm the revocation at the provider: remove Deploi from the apps with access in your account settings to be sure.'
    return `${a.address} disconnected and its tokens deleted.${cancelled}${revoke}`
  })
  const reconnect = (a: EmailAccountView, read: boolean) => connect.start(`${read ? 'read' : 'reconnect'}:${a.id}`, () =>
    storeFetch<EmailConnectResponse>(`/api/store/email/accounts/${a.id}/reconnect`, { method: 'POST', body: { read, returnTo } }))
  const connectNew = (p: EmailProviderView, read: boolean) => connect.start(`connect:${p.provider}`, () =>
    storeFetch<EmailConnectResponse>('/api/store/email/accounts', { method: 'POST', body: { provider: p.provider, read, returnTo } }))
  const anyBusy = busy !== null || connect.busy !== null

  return (
    <>
      {header}
      <div aria-live="polite" className="flex flex-col gap-3">
        {notice?.ok && <Banner icon="check"><strong>Done.</strong> {notice.text}</Banner>}
        {notice && !notice.ok && <Banner tone="warn"><strong>{notice.what}.</strong> {notice.e.message}</Banner>}
        {connect.notice?.kind === 'connected' && <Banner icon="check"><strong>Email account connected{connect.notice.address ? `: ${connect.notice.address}` : ''}.</strong> No agent can use it until you grant that agent permission.</Banner>}
        {connect.notice?.kind === 'error' && <Banner tone="warn"><strong>Not connected.</strong> {connect.notice.e.message}</Banner>}
        {connect.notice?.kind === 'popup_blocked' && <Banner tone="warn"><strong>The sign-in window was blocked.</strong> Allow pop-ups for this app, then try again. The provider&apos;s page cannot open inside the Shopify admin.</Banner>}
        {connect.busy === 'complete' && <Banner icon="clock">Finishing the connection…</Banner>}
        {error && <ErrorState error={error} onRetry={reload} />}
      </div>
      {!canAct && <div className="mt-3"><Banner tone="warn"><strong>Read-only.</strong> Deploi staff can view connections but cannot connect, check or disconnect a merchant&apos;s accounts.</Banner></div>}

      <Section id="store" title="Store" sub="The store Deploi reads and corrects.">
        {o.connections.length === 0 ? <NoStore /> : o.connections.map(c => <ConnectionDetails key={c.id} c={c} />)}
        <Link href={`${base}/connect`} className="inline-flex text-[14px]"><span className="inline-flex items-center gap-1 text-ink underline-offset-4 hover:underline">Store details{o.connections.some(c => c.is_synthetic) ? ' and demo controls' : ''}<Icon name="arrow-right" size={14} /></span></Link>
      </Section>

      <Section id="email" title="Email accounts" sub="Accounts your agents may send from, each only as far as that agent's authorization allows.">
        {email.accounts.length === 0 ? (
          <Panel><p className="text-[15px] text-grey">No email account connected. Connect one below to let an agent draft or send email from it.</p></Panel>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Email accounts">
            {email.accounts.map(a => (
              <AccountCard key={a.id} a={a} canAct={canAct} busy={busy ?? connect.busy} anyBusy={anyBusy}
                onCheck={() => check(a)} onReconnect={() => reconnect(a, false)} onAddRead={() => reconnect(a, true)} onDisconnect={() => setConfirm(a)} />
            ))}
          </ul>
        )}
      </Section>

      <Section id="connect-email" title="Connect an email account">
        <Panel>
          <div className="flex flex-col gap-2 text-[15px] text-grey">
            <p className="flex gap-2"><Icon name="shield" size={16} className="mt-1 shrink-0 text-grey-h" /><span>Deploi never asks for your mailbox password. You sign in on the provider&apos;s own page and choose what to allow.</span></p>
            <p className="flex gap-2"><Icon name="check" size={16} className="mt-1 shrink-0 text-grey-h" /><span>Connecting an account lets no agent use it. Each agent can use it only after you grant that agent permission, at the level you choose (drafts only, send what you approve, or send within limits).</span></p>
          </div>
          <ul className="mt-4 flex flex-col gap-3" aria-label="Email providers">
            {email.providers.map(p => <ProviderRow key={p.provider} p={p} canAct={canAct} busy={connect.busy} anyBusy={anyBusy} onConnect={read => connectNew(p, read)} />)}
          </ul>
        </Panel>
      </Section>

      <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title="Disconnect this email account?">
        {confirm && (
          <div className="flex flex-col gap-4">
            <p className="text-[15px] text-ink break-words">{confirm.address}</p>
            <p className="text-[15px] text-grey">Disconnecting deletes Deploi&apos;s tokens for this account and cancels every unsent message from it: drafts, messages awaiting your approval and queued messages. Messages already accepted by the provider are not affected. Agents that use this account can no longer draft or send email until you connect an account and grant them permission again.</p>
            {confirm.usage.awaiting > 0 && <p className="text-[14px] text-warn">{confirm.usage.awaiting} message{confirm.usage.awaiting === 1 ? ' is' : 's are'} awaiting your approval and will be cancelled.</p>}
            {confirm.provider === 'microsoft' && <p className="text-[14px] text-grey">Microsoft does not let Deploi revoke access itself. After disconnecting, also remove Deploi from the apps that can access your Microsoft account (account settings, privacy, apps and services).</p>}
            <Button variant="danger" onClick={() => disconnect(confirm)} disabled={busy !== null}>{busy === `disconnect:${confirm.id}` ? 'Disconnecting…' : 'Disconnect account'}</Button>
          </div>
        )}
      </Sheet>
    </>
  )
}

function AccountCard({ a, canAct, busy, anyBusy, onCheck, onReconnect, onAddRead, onDisconnect }: {
  a: EmailAccountView; canAct: boolean; busy: string | null; anyBusy: boolean; onCheck: () => void; onReconnect: () => void; onAddRead: () => void; onDisconnect: () => void
}) {
  const { base } = useStore()
  const w = emailAccountWords(a.status)
  const granted = (on: boolean) => on ? <span className="text-ink">Granted</span> : <span className="text-grey-h">Not granted</span>
  return (
    <li>
      <Panel tone={a.status === 'active' ? undefined : a.status === 'error' ? 'danger' : 'warn'}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="glass" style={{ fontSize: 13, padding: '6px 12px' }}><Icon name="mail" size={14} />{a.label}</span>
          <Badge tone={w.tone}>{w.label}</Badge>
          {a.is_synthetic && <Badge tone="warn">Synthetic: nothing is ever emailed</Badge>}
        </div>
        <div className="mt-3 text-ink font-medium break-all">{a.address}</div>
        {a.display_name && <div className="text-[14px] text-grey-h break-words">Sends as &ldquo;{a.display_name}&rdquo;</div>}
        {a.status !== 'active' && <p className="pt-2 text-[14px] text-warn break-words">{a.status_reason ?? w.hint}</p>}
        <div className="mt-4">
          <Facts items={[
            ['Send email', granted(a.can_send)],
            ['Read replies', granted(a.can_read)],
            ['Agents using it', a.usage.agents ? <Link key="ag" href={`${base}/agents`} className="text-ink underline-offset-4 hover:underline">{a.usage.agents} agent{a.usage.agents === 1 ? '' : 's'}</Link> : 'None yet'],
            ['Accepted by provider today', String(a.usage.sentToday)],
            ['Awaiting your approval', a.usage.awaiting ? <span key="aw" className="text-ink">{a.usage.awaiting}</span> : '0'],
            ['Delivery unknown', a.usage.unknown ? <span key="un" className="text-warn">{a.usage.unknown}</span> : '0'],
            ['Failed in the last 7 days', a.usage.failed7d ? <span key="fa" className="text-danger">{a.usage.failed7d}</span> : '0'],
            ['Last checked', a.last_checked_at ? `${fmtAgo(a.last_checked_at)}${a.last_success_at && a.last_success_at !== a.last_checked_at ? ` · last success ${fmtAgo(a.last_success_at)}` : ''}` : 'Not checked yet'],
            ['Connected', `${fmtTime(a.connected_at)}`],
          ]} />
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] text-ink">Permissions as the provider reports them</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">{a.granted_scopes.length ? a.granted_scopes.map(s => <Badge key={s} tone="muted">{s}</Badge>) : <span className="text-[13px] text-grey-h">none</span>}</div>
        </details>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onCheck} disabled={!canAct || anyBusy} aria-label={`Check connection for ${a.address}`}><Icon name="search" size={15} />{busy === `check:${a.id}` ? 'Checking…' : 'Check connection'}</Button>
          <Button size="sm" variant={a.status === 'needs_reauth' || a.status === 'error' ? 'primary' : 'ghost'} onClick={onReconnect} disabled={!canAct || anyBusy} aria-label={`Reconnect ${a.address}`}><Icon name="bolt" size={15} />{busy === `reconnect:${a.id}` ? 'Opening…' : 'Reconnect'}</Button>
          {!a.can_read && <Button size="sm" variant="ghost" onClick={onAddRead} disabled={!canAct || anyBusy} aria-label={`Add read access to ${a.address}`}><Icon name="eye" size={15} />{busy === `read:${a.id}` ? 'Opening…' : 'Add read access'}</Button>}
          <Button size="sm" variant="danger" onClick={onDisconnect} disabled={!canAct || anyBusy} aria-label={`Disconnect ${a.address}`}>Disconnect</Button>
        </div>
        {!a.can_read && <p className="pt-2 text-[13px] text-grey-h">Read access is only needed so an agent can notice supplier replies to the restock requests it sent. Deploi records who replied and when, never acts on what a reply says, and does not look at other mail.</p>}
      </Panel>
    </li>
  )
}

function ProviderRow({ p, canAct, busy, anyBusy, onConnect }: { p: EmailProviderView; canAct: boolean; busy: string | null; anyBusy: boolean; onConnect: (read: boolean) => void }) {
  const [read, setRead] = useState(false)
  const w = EMAIL_PROVIDER_STATUS_WORDS[p.status]
  const available = p.status !== 'not_configured'
  const id = `read-${p.provider}`
  return (
    <li className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="text-ink font-medium">{p.label}</span>{w && <Badge tone={w.tone}>{w.label}</Badge>}</div>
          <p className="pt-1 text-[14px] text-grey">{w?.hint ?? p.status}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onConnect(read)} disabled={!available || !canAct || anyBusy} aria-label={`Connect ${p.label}`}>
          <Icon name="plus" size={15} />{busy === `connect:${p.provider}` ? 'Opening…' : 'Connect'}
        </Button>
      </div>
      {available && (
        <label htmlFor={id} className="mt-3 flex cursor-pointer items-start gap-3 text-[14px] text-grey">
          <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 accent-white" checked={read} onChange={e => setRead(e.target.checked)} disabled={!canAct} />
          <span>Also ask for read access<span className="block text-[13px] text-grey-h">Only needed for an agent that asks a supplier to confirm restock and should notice the reply. You can add it later.</span></span>
        </label>
      )}
    </li>
  )
}
