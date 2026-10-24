import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { env } from '@/lib/env'
import { getProspect } from '@/lib/sales/queries'
import { STAGE_LABEL } from '@/lib/sales/stages'
import { logCallForm } from '@/lib/sales/actions'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { StageSheet } from '@/components/sales/StageSheet'
import { WebsiteTag } from '@/components/sales/ProspectCard'
import { isWebsiteLead } from '@/lib/sales/queries'

export const dynamic = 'force-dynamic'

const CHANNEL_ICON: Record<string, string> = { email: 'mail', call: 'phone', linkedin: 'users', referral: 'spark', chat: 'chat', sms: 'chat', site: 'inbox' }

export default async function ProspectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const data = await withUser(session, db => getProspect(db, id), { ip: await requestIp() })
  if (!data) notFound()
  const { prospect: p, touches } = data
  const booking = env.bookingUrl

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/staff/pipeline" className="inline-flex items-center gap-1"><Icon name="arrow-right" size={12} className="rotate-180" /> Pipeline</Link>}
        title={p.agency_name}
        sub={<>{p.owner_name ?? 'No owner name'}{p.email ? ` · ${p.email}` : ''}{p.phone ? ` · ${p.phone}` : ''}<br />{[p.city, p.county, p.state].filter(Boolean).join(', ')}{p.programs.length ? ` · ${p.programs.join(', ')}` : ''} · source {p.source}</>}
        actions={<>
          <StageSheet id={p.id} stage={p.stage} label={STAGE_LABEL[p.stage]} />
          <WebsiteTag p={p} />
          {p.email_invalid && <Badge tone="danger">email bounced</Badge>}
          {p.website_engagement_id && <Button variant="ghost" size="sm" href={`/staff/website/${p.website_engagement_id}`}>Website engagement</Button>}
          {booking ? <Button variant="ghost" size="sm" href={booking} external>Book call</Button> : <span title="Set BOOKING_URL"><Button variant="ghost" size="sm" disabled>Book call</Button></span>}
          <Button variant="ghost" size="sm" href={`/staff/assessments/new?prospect=${p.id}`}>Create assessment</Button>
        </>}
      />
      {sp.logged && <div className="mb-5"><Banner icon="check"><strong>Call logged.</strong></Banner></div>}
      {!booking && <div className="mb-5"><Banner>Set <strong>BOOKING_URL</strong> in the environment to enable the Book call button.</Banner></div>}
      {isWebsiteLead(p) && (
        <div className="mb-5"><Banner icon="spark">
          <strong>Website Improvement lead.</strong> {p.website_url ? <>Site: <a className="text-ink underline" href={p.website_url} target="_blank" rel="noopener noreferrer">{p.website_url}</a>. </> : 'No site URL given. '}
          {p.website_goal ? <>Goal: {p.website_goal}. </> : null}
          {p.website_engagement_id ? <Link className="text-ink underline" href={`/staff/website/${p.website_engagement_id}`}>Open the website engagement</Link> : 'No engagement row yet'}
          {'. '}Standalone $500 one-time service; no assessment and no credit involved.
        </Banner></div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section aria-labelledby="timeline">
          <h2 id="timeline" className="mb-3 text-lg">Timeline</h2>
          {(p.biggest_leak || p.next_step || p.follow_up_at) && (
            <div className="mb-3 rounded-2xl border border-line p-4 text-[15px]">
              {p.biggest_leak && <div><span className="text-grey-h">Biggest leak:</span> <span className="text-ink">{p.biggest_leak}</span></div>}
              {p.next_step && <div><span className="text-grey-h">Next step:</span> <span className="text-ink">{p.next_step}</span></div>}
              {p.follow_up_at && <div><span className="text-grey-h">Follow-up:</span> <span className="text-ink">{String(p.follow_up_at).slice(0, 10)}</span></div>}
            </div>
          )}
          <ol className="flex flex-col gap-3">
            {touches.length === 0 && <li className="text-grey">No touches yet.</li>}
            {touches.map(t => (
              <li key={t.id} className="flex gap-3 rounded-2xl border border-line p-4">
                <span className="glass mt-0.5 shrink-0" style={{ padding: '6px 9px' }}><Icon name={CHANNEL_ICON[t.channel] ?? 'spark'} size={14} /></span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-grey-h">
                    <span className="text-ink">{t.channel}</span><span>{t.direction === 'inbound' ? '← inbound' : '→ outbound'}</span>
                    <span>{new Date(t.at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })}</span>
                    {typeof t.meta?.outcome === 'string' && <Badge tone={t.meta.outcome === 'held' ? 'ok' : 'muted'}>{String(t.meta.outcome).replace('_', ' ')}</Badge>}
                  </div>
                  {t.subject && <div className="mt-1 text-[15px] font-medium text-ink">{t.subject}</div>}
                  {t.body && <div className="mt-1 whitespace-pre-wrap text-[15px] text-grey">{t.body}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="logcall">
          <h2 id="logcall" className="mb-3 text-lg">Log a call</h2>
          <form action={logCallForm} className="flex flex-col gap-4 rounded-2xl border border-line p-4">
            <input type="hidden" name="id" value={p.id} />
            <Field label="Outcome" htmlFor="outcome">
              <Select id="outcome" name="outcome" defaultValue="held">
                <option value="held">Held</option><option value="no_answer">No answer</option><option value="voicemail">Voicemail</option><option value="rescheduled">Rescheduled</option>
              </Select>
            </Field>
            <Field label="Biggest leak they named" htmlFor="biggest_leak"><Input id="biggest_leak" name="biggest_leak" placeholder="e.g. referrals answered next day" /></Field>
            <Field label="Next step" htmlFor="next_step"><Input id="next_step" name="next_step" placeholder="e.g. send assessment proposal" /></Field>
            <Field label="Follow-up date" htmlFor="follow_up_at"><Input id="follow_up_at" name="follow_up_at" type="date" /></Field>
            <Field label="Notes" htmlFor="notes"><Textarea id="notes" name="notes" rows={3} /></Field>
            <div><Button type="submit">Save call</Button></div>
          </form>
          {p.owner_notes && <div className="mt-4 rounded-2xl border border-line p-4 text-[14px] whitespace-pre-wrap"><div className="mb-1 text-grey-h">Owner notes</div>{p.owner_notes}</div>}
        </section>
      </div>
    </>
  )
}
