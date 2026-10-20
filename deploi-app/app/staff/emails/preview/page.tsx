import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { env } from '@/lib/env'
import { getMetrics } from '@/lib/dashboard/metrics'
import { buildMorningReport } from '@/emails/morning-report'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Empty } from '@/components/ui/Empty'
import { sendTestToMe } from './actions'

export const metadata = { title: 'Email preview' }
export const dynamic = 'force-dynamic'

export default async function EmailPreview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const now = new Date()
  const data = await withUser(session, async db => {
    const agencies = await db.query<{ id: string; name: string }>(
      "select g.id, g.name from agencies g where exists (select 1 from profiles p where p.agency_id = g.id and p.role = 'client') order by g.name")
    const agencyId = sp.agency && agencies.some(a => a.id === sp.agency) ? sp.agency : agencies[0]?.id
    if (!agencyId) return { agencies, agencyId: null, mail: null, recipients: 0 }
    const metrics = await getMetrics(db, agencyId, now)
    const mail = await buildMorningReport(metrics, env.appUrl, now)
    const recipients = await db.one<{ n: string }>("select count(*) as n from profiles where role = 'client' and agency_id = $1", [agencyId])
    return { agencies, agencyId, mail, recipients: Number(recipients?.n ?? 0) }
  }, { ip })

  return (
    <>
      <PageHeader title="Morning report preview" sub="What each client user receives at 7:00 AM their local time. Rendered live from today's numbers." />
      {sp.sent === 'mock' && <div className="mb-4"><Banner icon="mail"><strong>Sent to the mock outbox.</strong> RESEND_API_KEY is empty, so nothing left the server. The email went to {session.email}.</Banner></div>}
      {sp.sent === 'ok' && <div className="mb-4"><Banner icon="mail"><strong>Sent.</strong> Check {session.email}.</Banner></div>}
      {sp.sent === 'error' && <div className="mb-4"><Banner tone="warn"><strong>Could not send.</strong> Check the server log.</Banner></div>}
      {!data.agencyId || !data.mail ? <Empty title="No agencies with client users yet" /> : (
        <>
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end">
            <form method="get" className="flex flex-1 gap-2">
              <Select name="agency" defaultValue={data.agencyId} aria-label="Agency">
                {data.agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <Button variant="ghost" size="sm" type="submit">Preview</Button>
            </form>
            <form action={sendTestToMe}>
              <input type="hidden" name="agency" value={data.agencyId} />
              <Button variant="ghost" size="sm" type="submit">Send test to me</Button>
            </form>
          </div>
          <p className="mb-4 text-[14px] text-grey-h">Subject: <span className="text-ink">{data.mail.subject}</span> · {data.recipients} client recipient{data.recipients === 1 ? '' : 's'} · from hello@getdeploi.com</p>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-base">HTML</h2>
              <iframe title="Morning report HTML" srcDoc={data.mail.html} className="h-[720px] w-full rounded-[16px] border border-line bg-white" sandbox="" />
            </div>
            <div>
              <h2 className="mb-2 text-base">Plain text</h2>
              <pre className="h-[720px] overflow-auto whitespace-pre-wrap rounded-[16px] border border-line p-4 text-[14px] leading-6 text-grey">{data.mail.text}</pre>
            </div>
          </div>
        </>
      )}
    </>
  )
}
