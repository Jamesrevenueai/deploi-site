'use client'
/**
 * Office approvals: the exact email, event or CRM change. Approving carries out that exact item (bound to
 * its hash); editing it creates a new version that needs a new approval. Drafts are shown, never sent.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { PayloadView, fmt, type Payload } from './shared'

type Pending = { id: string; agentName: string; kind: string; purpose: string; payload: Payload; payloadHash: string; statusReason: string | null; policyVersion: number | null; createdAt: string }
type Draft = { id: string; agent_name: string; kind: string; purpose: string; payload: Payload; payload_hash: string; status_reason: string | null; created_at: string }

function Item({ a, busy, onAct }: { a: Pending; busy: boolean; onAct: (key: string, body: Record<string, unknown>, msg: string) => void }) {
  const [edit, setEdit] = useState(false)
  const email = a.payload.type === 'email' ? a.payload : null
  const [subject, setSubject] = useState(email?.subject ?? '')
  const [body, setBody] = useState(email?.body ?? '')
  return (
    <Panel>
      <div className="text-[14px] text-grey-h">{a.agentName} · {a.purpose} · permission version {a.policyVersion ?? '—'} · {fmt(a.createdAt)}</div>
      <div className="mt-2">{edit && email ? (
        <div className="flex flex-col gap-2">
          <Field label="Subject" htmlFor={`s-${a.id}`}><Input id={`s-${a.id}`} value={subject} onChange={e => setSubject(e.target.value)} /></Field>
          <Field label="Message" htmlFor={`b-${a.id}`}><Textarea id={`b-${a.id}`} rows={8} value={body} onChange={e => setBody(e.target.value)} /></Field>
        </div>
      ) : <PayloadView p={a.payload} />}</div>
      {a.statusReason && <p className="pt-2 text-[13px] text-grey-h">{a.statusReason}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!edit && <Button size="sm" disabled={busy} onClick={() => onAct(`a:${a.id}`, { op: 'approve', shownHash: a.payloadHash }, 'Approved: carried out exactly as shown.')}>Approve exactly this</Button>}
        {email && !edit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdit(true)}>Edit</Button>}
        {edit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEdit(false); onAct(`e:${a.id}`, { op: 'edit', shownHash: a.payloadHash, subject, body }, 'Saved. Review the new version and approve it.') }}>Save changes</Button>}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onAct(`r:${a.id}`, { op: 'reject' }, 'Declined: it will not be carried out.')}>Decline</Button>
      </div>
    </Panel>
  )
}

export function ApprovalsScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ pending: Pending[]; drafts: Draft[] }>('/api/office/approvals'), 'office-approvals')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const onAct = async (key: string, body: Record<string, unknown>, msg: string) => {
    setBusy(key); setErr(null); setNote(null)
    try {
      const r = await storeFetch<{ status?: string; reason?: string | null }>(`/api/office/actions/${key.slice(2)}`, { method: 'POST', body })
      setNote(body.op === 'approve' ? `Approved: ${r.status === 'succeeded' ? 'done and confirmed by a fresh read' : `${String(r.status).replace('_', ' ')}${r.reason ? ` (${r.reason})` : ''}`}.` : msg)
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null); await reload() }
  }
  const header = <PageHeader title="Approvals" sub="Each item is exactly what will be sent, booked or written. Approving does that and nothing else; editing needs a new approval." />
  if (loading && !data) return <>{header}<Loading /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  return (
    <>
      {header}
      <div aria-live="polite" className="mb-3 flex flex-col gap-3">{note && <Banner icon="check">{note}</Banner>}{err && <ErrorState error={err} />}</div>
      <Section title="Waiting for you">
        {d.pending.length === 0 ? <Empty title="Nothing to approve" /> : <ul className="flex flex-col gap-3">{d.pending.map(a => <li key={a.id}><Item a={a} busy={busy !== null} onAct={onAct} /></li>)}</ul>}
      </Section>
      <Section title="Drafts" sub="From agents at drafts only. Nothing here is ever sent or written; widen the agent's permission to let it act.">
        {d.drafts.length === 0 ? <Empty title="No drafts" /> : <ul className="flex flex-col gap-3">{d.drafts.map(x => (
          <li key={x.id}><Panel><div className="text-[14px] text-grey-h">{x.agent_name} · {x.purpose} · {fmt(x.created_at)}</div><div className="mt-2"><PayloadView p={x.payload} /></div></Panel></li>
        ))}</ul>}
      </Section>
    </>
  )
}
