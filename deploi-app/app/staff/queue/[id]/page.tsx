import { notFound } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getTicket, SEVERITIES, CLASSIFICATIONS, TICKET_STATUSES, STATUS_LABEL, CLASSIFICATION_LABEL, SEVERITY_TONE, SUPPORT_COVERAGE_NOTE } from '@/lib/queue/tickets'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { updateTicketAction, setTicketStatusAction } from '../actions'

export const metadata = { title: 'Ticket' }
export const dynamic = 'force-dynamic'

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const t = await withUser(session, db => getTicket(db, id), { ip: await requestIp() })
  if (!t) notFound()
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
  const next = t.status === 'open' ? 'in_progress' : t.status === 'in_progress' ? 'resolved' : t.status === 'waiting_on_agency' ? 'in_progress' : t.status === 'resolved' ? 'closed' : null

  return (
    <>
      <PageHeader title={t.title} eyebrow={<>{t.agency_name ?? 'Agency'} · opened {when(t.created_at)} · updated {when(t.updated_at)}</>}
        sub={<span className="flex flex-wrap gap-2"><Badge tone={SEVERITY_TONE[t.severity]}>{t.severity}</Badge><Badge tone="none">{CLASSIFICATION_LABEL[t.classification]}</Badge><Badge tone={t.status === 'resolved' || t.status === 'closed' ? 'ok' : 'none'}>{STATUS_LABEL[t.status]}</Badge>{t.resolved_at && <span className="text-grey-h text-[13px]">resolved {when(t.resolved_at)}</span>}</span>}
        actions={<>
          <Button variant="ghost" size="sm" href="/staff/queue">Back to queue</Button>
          {next && <form action={setTicketStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value={next} /><Button type="submit" size="sm">Mark {STATUS_LABEL[next].toLowerCase()}</Button></form>}
        </>} />
      <div className="mb-5"><Banner icon="clock">{SUPPORT_COVERAGE_NOTE}</Banner></div>
      {sp.created && <div className="mb-4"><Banner icon="check"><strong>Ticket created.</strong></Banner></div>}
      {sp.saved && <div className="mb-4"><Banner icon="check"><strong>Saved.</strong></Banner></div>}
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not save.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}

      <form action={updateTicketAction} className="grid gap-3 rounded-[20px] border border-line p-5 md:grid-cols-2">
        <input type="hidden" name="id" value={t.id} />
        <div className="md:col-span-2"><Field label="Title" htmlFor="title"><Input id="title" name="title" defaultValue={t.title} required maxLength={200} /></Field></div>
        <Field label="Status" htmlFor="status"><Select id="status" name="status" defaultValue={t.status}>{TICKET_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select></Field>
        <Field label="Severity" htmlFor="severity"><Select id="severity" name="severity" defaultValue={t.severity}>{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</Select></Field>
        <Field label="Classification" htmlFor="classification"><Select id="classification" name="classification" defaultValue={t.classification}>{CLASSIFICATIONS.map(c => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select></Field>
        <Field label="Owner" htmlFor="owner"><Input id="owner" name="owner" defaultValue={t.owner ?? ''} placeholder="staff name or profile id" /></Field>
        <Field label="Engagement reference" htmlFor="engagement_ref"><Input id="engagement_ref" name="engagement_ref" defaultValue={t.engagement_ref ?? ''} /></Field>
        <div className="md:col-span-2"><Field label="Detail" htmlFor="detail" hint="No names or client details."><Textarea id="detail" name="detail" rows={4} defaultValue={t.detail ?? ''} /></Field></div>
        <div className="md:col-span-2"><Field label="Next action" htmlFor="next_action"><Input id="next_action" name="next_action" defaultValue={t.next_action ?? ''} /></Field></div>
        <div className="md:col-span-2"><Field label="Resolution" htmlFor="resolution" hint="What was done, or why it was closed."><Textarea id="resolution" name="resolution" rows={3} defaultValue={t.resolution ?? ''} /></Field></div>
        <div className="md:col-span-2"><button type="submit" className="btn ghost sm">Save ticket</button></div>
      </form>
    </>
  )
}
