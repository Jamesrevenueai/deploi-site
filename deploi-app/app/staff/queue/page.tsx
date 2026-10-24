import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listTickets, ticketCounts, SEVERITIES, CLASSIFICATIONS, TICKET_STATUSES, STATUS_LABEL, CLASSIFICATION_LABEL, SEVERITY_TONE, SUPPORT_COVERAGE_NOTE } from '@/lib/queue/tickets'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { MobileRows } from '@/components/dashboard/MobileRows'
import { createTicketAction } from './actions'

export const metadata = { title: 'Service queue' }
export const dynamic = 'force-dynamic'

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const status = sp.status ?? 'active'
  const f = { status, severity: sp.severity ?? '', classification: sp.classification ?? '', agency: sp.agency ?? '' }
  const { rows, counts, agencies } = await withUser(session, async db => ({
    rows: await listTickets(db, f), counts: await ticketCounts(db),
    agencies: await db.query<{ id: string; name: string }>('select id, name from agencies order by name'),
  }), { ip: await requestIp() })
  const active = (counts.open ?? 0) + (counts.in_progress ?? 0) + (counts.waiting_on_agency ?? 0)
  const qs = (patch: Record<string, string>) => '?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...f, ...patch }).filter(([, v]) => v))).toString()
  const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <>
      <PageHeader title="Service queue" eyebrow="Staff" sub={`${active} active ticket${active === 1 ? '' : 's'}. Defects, support requests and new-scope asks, each with an owner, a next action and a resolution.`} />
      <div className="mb-5"><Banner icon="clock">{SUPPORT_COVERAGE_NOTE}</Banner></div>
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not save.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}

      <div className="mb-4 flex flex-wrap gap-2 text-[14px]">
        {[['active', 'Active'], ...TICKET_STATUSES.map(s => [s, STATUS_LABEL[s]]), ['all', 'All']].map(([s, label]) => (
          <Link key={s} href={qs({ status: s })} className={`badge ${status === s ? '' : 'muted'}`}>{label}{s === 'active' ? ` ${active}` : s !== 'all' ? ` ${counts[s] ?? 0}` : ''}</Link>
        ))}
      </div>
      <form method="get" className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
        <input type="hidden" name="status" value={status} />
        <Select name="severity" defaultValue={f.severity} aria-label="Severity"><option value="">Any severity</option>{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</Select>
        <Select name="classification" defaultValue={f.classification} aria-label="Classification"><option value="">Any classification</option>{CLASSIFICATIONS.map(c => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select>
        <Select name="agency" defaultValue={f.agency} aria-label="Agency"><option value="">All agencies</option>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>

      {rows.length === 0 ? <Empty title="No tickets match">Nothing in this view. Create a ticket below when an agency reports a defect, asks for help, or asks for something outside the engagement.</Empty> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Ticket</th><th>Agency</th><th>Severity</th><th>Class</th><th>Status</th><th>Owner</th><th>Next action</th><th>Opened</th></tr></thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.id}>
                    <td className="ink"><Link href={`/staff/queue/${t.id}`} className="underline">{t.title}</Link></td>
                    <td>{t.agency_name ?? '—'}</td>
                    <td><Badge tone={SEVERITY_TONE[t.severity]}>{t.severity}</Badge></td>
                    <td>{CLASSIFICATION_LABEL[t.classification]}</td>
                    <td><Badge tone={t.status === 'resolved' || t.status === 'closed' ? 'ok' : t.status === 'waiting_on_agency' ? 'muted' : 'none'}>{STATUS_LABEL[t.status]}</Badge></td>
                    <td>{t.owner ?? <span className="text-grey-h">unassigned</span>}</td>
                    <td className="max-w-[28ch]">{t.next_action ?? '—'}</td>
                    <td className="whitespace-nowrap">{when(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={rows.map(t => ({
            key: t.id, title: <Link href={`/staff/queue/${t.id}`} className="underline">{t.title}</Link>, badge: <Badge tone={SEVERITY_TONE[t.severity]}>{t.severity}</Badge>,
            lines: [`${t.agency_name ?? '—'} · ${CLASSIFICATION_LABEL[t.classification]} · ${STATUS_LABEL[t.status]}`, `Owner ${t.owner ?? 'unassigned'} · opened ${when(t.created_at)}`, ...(t.next_action ? [`Next: ${t.next_action}`] : [])],
          }))} />
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-3">New ticket</h2>
        <form action={createTicketAction} className="grid gap-3 rounded-[20px] border border-line p-5 md:grid-cols-2">
          <Field label="Agency" htmlFor="t_agency"><Select id="t_agency" name="agency_id" required defaultValue={agencies[0]?.id}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Title" htmlFor="t_title" hint="What is wrong or wanted. No names or client details."><Input id="t_title" name="title" required maxLength={200} /></Field>
          <Field label="Severity" htmlFor="t_sev"><Select id="t_sev" name="severity" defaultValue="medium">{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</Select></Field>
          <Field label="Classification" htmlFor="t_class"><Select id="t_class" name="classification" defaultValue="support_request">{CLASSIFICATIONS.map(c => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select></Field>
          <Field label="Owner" htmlFor="t_owner" hint="Staff name or profile id."><Input id="t_owner" name="owner" placeholder="optional" /></Field>
          <Field label="Engagement reference" htmlFor="t_eng"><Input id="t_eng" name="engagement_ref" placeholder="optional engagement id" /></Field>
          <div className="md:col-span-2"><Field label="Detail" htmlFor="t_detail"><Textarea id="t_detail" name="detail" rows={3} /></Field></div>
          <div className="md:col-span-2"><Field label="Next action" htmlFor="t_next"><Input id="t_next" name="next_action" placeholder="optional" /></Field></div>
          <div className="md:col-span-2"><Button type="submit" size="sm">Create ticket</Button></div>
        </form>
      </section>
    </>
  )
}
