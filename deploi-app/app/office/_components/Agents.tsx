'use client'
/**
 * Office agents: create from a template (drafts only for every tool), read exactly what a version allows,
 * grant it, widen or narrow permissions (widening is a new version to grant), run, pause, resume, revoke.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { StatusBadge, fmt } from './shared'

type Summary = { grants: string[]; limits: string[]; never: string[] }
type Tier = 'draft' | 'send_approved' | 'send_autonomous'
type Policy = Record<string, unknown> & { kind: string; mailboxAccountId?: string | null; emailOps?: Record<string, unknown> & { readInbox?: boolean }; email?: { tier: Tier; validUntil: string | null }; calendar?: { tier: Tier; validUntil: string | null; allowMeet: boolean }; crm?: { tier: Tier; validUntil: string | null } }
type Agent = { id: string; kind: string; name: string; status: string; next_run_at: string | null; last_run_at: string | null; active_version: number | null; active_summary: Summary | null; active_policy: Policy | null
  pending: { id: string; version: number; policy_hash: string; summary: Summary; expansion: string[]; policy: Policy } | null }
type Template = { key: string; name: string; job: string; needs: string[] }
type Mailbox = { id: string; address: string; status: string; provider?: string }

/** Shown before the provider asks for inbox access (the same text as lib/office/mailbox.ts INBOX_READ_EXPLANATION). */
const INBOX_EXPLANATION = [
  'Deploi reads new mail in this inbox so Email Operations can find messages nobody has answered: sender, recipients, subject, text and attachment names and sizes.',
  'Attachments are never opened or stored. Text is stored encrypted and shown only to your organization.',
  'Nothing in a message can change what the agent may do or who it writes to; the first reply to a new sender always waits for you.',
  'Google asks for "View your email messages and settings"; Microsoft for "Read your mail" (an administrator may need to approve it). Disconnect the account to stop.',
]

const TIER_LABEL: Record<Tier, string> = { draft: 'Drafts only', send_approved: 'After my approval', send_autonomous: 'Without asking, within limits (up to one year)' }

function SummaryView({ s }: { s: Summary }) {
  return (
    <div className="grid gap-3 text-[14px] md:grid-cols-3">
      <div><div className="text-grey-h">Allows</div><ul className="list-disc pl-5">{s.grants.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
      <div><div className="text-grey-h">Limits</div><ul className="list-disc pl-5">{s.limits.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
      <div><div className="text-grey-h">Never</div><ul className="list-disc pl-5">{s.never.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
    </div>
  )
}

function PermissionEditor({ agent, onSave, busy }: { agent: Agent; onSave: (p: Policy) => void; busy: boolean }) {
  const base = (agent.pending?.policy ?? agent.active_policy)!
  const [p, setP] = useState<Policy>(base)
  const until = new Date(Date.now() + 90 * 864e5).toISOString()
  const tools = (['email', 'calendar', 'crm'] as const).filter(t => p[t])
  const setTier = (t: 'email' | 'calendar' | 'crm', tier: Tier) => setP({ ...p, [t]: { ...(p[t] as object), tier, validUntil: tier === 'send_autonomous' ? ((p[t] as { validUntil: string | null }).validUntil ?? until) : null } })
  return (
    <div className="mt-3 flex flex-col gap-3">
      {tools.map(t => (
        <Field key={t} label={`${t === 'crm' ? 'CRM' : t[0].toUpperCase() + t.slice(1)} permission`} htmlFor={`${agent.id}-${t}`}
          hint={(p[t] as { tier: Tier }).tier === 'send_autonomous' ? `Until ${((p[t] as { validUntil: string | null }).validUntil ?? until).slice(0, 10)} (at most one year)` : undefined}>
          <Select id={`${agent.id}-${t}`} value={(p[t] as { tier: Tier }).tier} onChange={e => setTier(t, e.target.value as Tier)}>
            {(Object.keys(TIER_LABEL) as Tier[]).map(k => <option key={k} value={k}>{TIER_LABEL[k]}</option>)}
          </Select>
        </Field>
      ))}
      {p.emailOps && (
        <div className="rounded-[14px] border border-line p-3 text-[14px]">
          <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(p.emailOps.readInbox)} onChange={e => setP({ ...p, emailOps: { ...p.emailOps!, readInbox: e.target.checked } })} />Read my inbox (Gmail or Outlook)</label>
          <ul className="list-disc pl-5 pt-2 text-[13px] text-grey">{INBOX_EXPLANATION.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {p.calendar && <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={Boolean(p.calendar.allowMeet)} onChange={e => setP({ ...p, calendar: { ...p.calendar!, allowMeet: e.target.checked } })} />Add a Google Meet link to bookings</label>}
      <div><Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(p)}>Save as a new version</Button></div>
    </div>
  )
}

export function AgentsScreen() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([storeFetch<{ agents: Agent[]; templates: Template[] }>('/api/office/agents'), storeFetch<{ mailboxes: Mailbox[] }>('/api/office/connections')]), 'office-agents')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [form, setForm] = useState({ template: 'lead_followup', name: '', mailboxAccountId: '', senderName: '', pitch: '' })
  const [editing, setEditing] = useState<string | null>(null)
  const [meet, setMeet] = useState<Record<string, string>>({})
  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setErr(null); setNote(null)
    try { const t = await fn(); if (t) setNote(t); await reload() } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  const op = (id: string, body: Record<string, unknown>) => storeFetch<Record<string, unknown>>(`/api/office/agents/${id}`, { method: 'POST', body })
  const header = <PageHeader title="Agents" sub="Every office agent starts at drafts only. Nothing happens until you grant its permission, and anything wider is a new version you grant again." />
  if (loading && !data) return <>{header}<Loading /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const [{ agents, templates }, { mailboxes }] = data!
  const t = templates.find(x => x.key === form.template)
  return (
    <>
      {header}
      <div aria-live="polite" className="mb-3 flex flex-col gap-3">{note && <Banner icon="check">{note}</Banner>}{err && <ErrorState error={err} />}</div>
      <Section title="Your agents">
        {agents.length === 0 ? <Empty title="No agents yet">Create one from a template below.</Empty> : (
          <ul className="flex flex-col gap-3">{agents.map(a => (
            <li key={a.id}><Panel>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><h3 className="text-[1.05rem]">{a.name}</h3><div className="text-[13px] text-grey-h">{templates.find(x => x.key === a.kind)?.name ?? a.kind}{a.active_version ? ` · permission version ${a.active_version}` : ''} · last run {fmt(a.last_run_at)}</div></div>
                <StatusBadge status={a.status} />
              </div>
              {a.active_summary && <div className="mt-3"><SummaryView s={a.active_summary} /></div>}
              {a.pending && (
                <div className="mt-4 rounded-[14px] border border-warn-line p-3">
                  <div className="text-[14px]"><Badge tone="warn">Version {a.pending.version} waits for your grant</Badge> <span className="text-grey">{a.pending.expansion.join('; ')}</span></div>
                  <div className="mt-2"><SummaryView s={a.pending.summary} /></div>
                  <Button size="sm" className="mt-3" disabled={busy !== null} onClick={() => act(`g:${a.id}`, async () => { await op(a.id, { op: 'grant', policyId: a.pending!.id, policyHash: a.pending!.policy_hash }); return `Granted version ${a.pending!.version} of ${a.name}.` })}>Grant exactly this</Button>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {a.status === 'active' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`r:${a.id}`, async () => { const r = await op(a.id, { op: 'run' }); return `Run ${String(r.status)}${r.reason ? `: ${String(r.reason)}` : ''}.` })}>Run now</Button>}
                {a.status === 'active' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`p:${a.id}`, async () => { await op(a.id, { op: 'pause' }); return `${a.name} paused; queued items were cancelled.` })}>Pause</Button>}
                {a.status === 'paused' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act(`u:${a.id}`, async () => { await op(a.id, { op: 'resume' }) })}>Resume</Button>}
                {(a.active_policy || a.pending) && a.status !== 'revoked' && <Button size="sm" variant="ghost" onClick={() => setEditing(editing === a.id ? null : a.id)}>Change permission</Button>}
                {a.status !== 'revoked' && <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { if (confirm(`Revoke ${a.name}? Its permission ends now and queued items are cancelled.`)) void act(`v:${a.id}`, async () => { await op(a.id, { op: 'revoke' }) }) }}>Revoke</Button>}
                <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { if (confirm(`Delete ${a.name}? Its history is kept in the work log.`)) void act(`x:${a.id}`, async () => { await op(a.id, { op: 'delete' }) }) }}>Delete</Button>
              </div>
              {a.kind === 'email_operations' && a.active_policy?.emailOps?.readInbox && ['gmail', 'microsoft'].includes(mailboxes.find(m => m.id === a.active_policy?.mailboxAccountId)?.provider ?? '') && (
                <div className="mt-4 rounded-[14px] border border-line p-3 text-[14px]">
                  <div className="font-medium text-ink">Inbox reading</div>
                  <ul className="list-disc pl-5 pt-1 text-[13px] text-grey">{INBOX_EXPLANATION.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  <Button size="sm" variant="ghost" className="mt-2" disabled={busy !== null} onClick={() => act(`ri:${a.id}`, async () => { const r = await op(a.id, { op: 'read_inbox' }); if (typeof r.url === 'string') window.location.assign(r.url) })}>Allow Deploi to read this inbox</Button>
                </div>
              )}
              {editing === a.id && <PermissionEditor agent={a} busy={busy !== null} onSave={p => act(`e:${a.id}`, async () => { const r = await op(a.id, { op: 'edit', policy: p }); setEditing(null); return r.requiresGrant ? 'Saved as a new version: it waits for your grant; the current version keeps running.' : 'Saved: narrower permissions apply at once.' })} />}
              {a.kind === 'meeting_scheduler' && a.status === 'active' && (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <Field label="Propose three times to" htmlFor={`m-${a.id}`}><Input id={`m-${a.id}`} type="email" placeholder="name@company.com" value={meet[a.id] ?? ''} onChange={e => setMeet({ ...meet, [a.id]: e.target.value })} /></Field>
                  <Button size="sm" variant="ghost" disabled={busy !== null || !meet[a.id]} onClick={() => act(`mt:${a.id}`, async () => { const r = await op(a.id, { op: 'meet', email: meet[a.id] }); return `Proposal ${String(r.status).replace('_', ' ')}.` })}>Propose times</Button>
                </div>
              )}
            </Panel></li>
          ))}</ul>
        )}
      </Section>
      <Section title="Create from a template" sub="The new agent is saved at drafts only for every tool and does nothing until you grant it.">
        <Panel>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Template" htmlFor="tpl"><Select id="tpl" value={form.template} onChange={e => setForm({ ...form, template: e.target.value })}>{templates.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}</Select></Field>
            <Field label="Name" htmlFor="nm"><Input id="nm" placeholder={t?.name} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
            {t?.needs.includes('mailbox') && <Field label="Send from" htmlFor="mb"><Select id="mb" value={form.mailboxAccountId} onChange={e => setForm({ ...form, mailboxAccountId: e.target.value })}><option value="">Choose a mailbox</option>{mailboxes.filter(m => m.status === 'active').map(m => <option key={m.id} value={m.id}>{m.address}</option>)}</Select></Field>}
            {t?.needs.includes('mailbox') && <Field label="Sign emails as" htmlFor="sn"><Input id="sn" placeholder="Sam at Northwind" value={form.senderName} onChange={e => setForm({ ...form, senderName: e.target.value })} /></Field>}
            {form.template === 'lead_followup' && <div className="md:col-span-2"><Field label="What you offer (one or two sentences, used in the first email)" htmlFor="pt"><Textarea id="pt" rows={2} value={form.pitch} onChange={e => setForm({ ...form, pitch: e.target.value })} /></Field></div>}
          </div>
          <p className="pt-3 text-[14px] text-grey">{t?.job}</p>
          <Button className="mt-4" disabled={busy !== null} onClick={() => act('create', async () => { await storeFetch('/api/office/agents', { method: 'POST', body: form }); return 'Created at drafts only. Review its permission above and grant it to start.' })}>Create agent</Button>
        </Panel>
      </Section>
    </>
  )
}
