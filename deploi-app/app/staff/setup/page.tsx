import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { gatherReadiness } from '@/lib/setup/gather'
import { getSettings, settingString } from '@/lib/setup/settings'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Field'
import { CheckRow } from '@/components/setup/CheckRow'
import { uploadTemplate, saveBookingUrl, sendTestEmail } from './actions'

export const metadata = { title: 'Setup' }
export const dynamic = 'force-dynamic'

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const testSend = sp.test ? { ok: sp.test === 'ok', mocked: sp.mocked === '1', error: sp.err } : null
  const { readiness, bookingUrl } = await withUser(session, async db => {
    const readiness = await gatherReadiness(db, { resendTestSend: testSend })
    const settings = await getSettings(db)
    return { readiness, bookingUrl: settingString(settings.booking_url, 'url') ?? '' }
  }, { ip })

  return (
    <>
      <PageHeader title="Setup" eyebrow="Readiness" sub={`${readiness.okCount} of ${readiness.total} ready. This page reports; it blocks nothing.`}
        actions={<form action={sendTestEmail}><Button type="submit" size="sm">Send test email</Button></form>} />
      {sp.saved && <div className="mb-4"><Banner icon="check"><strong>Saved.</strong></Banner></div>}
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not save.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}
      {testSend && <div className="mb-4"><Banner tone={testSend.ok && !testSend.mocked ? 'info' : 'warn'} icon="mail">
        <strong>Test email {testSend.ok ? 'sent' : 'failed'}{testSend.mocked ? ' (mocked: no RESEND_API_KEY)' : ''}.</strong>{testSend.error ? ` ${testSend.error}` : ` To ${session.email}.`}
      </Banner></div>}

      <ul className="mb-8 rounded-[20px] border border-line px-5">
        {readiness.checks.map(c => <CheckRow key={c.key} c={c} />)}
      </ul>

      <div className="grid gap-6 md:grid-cols-2">
        <form action={uploadTemplate} className="flex flex-col gap-3 rounded-[20px] border border-line p-5">
          <input type="hidden" name="kind" value="baa_template" />
          <h2 className="text-lg">BAA template</h2>
          <Field label="PDF" htmlFor="baa_file" hint="Up to 10 MB; stored under templates/ in the reports bucket."><Input id="baa_file" name="file" type="file" accept=".pdf,application/pdf" required /></Field>
          <div><button type="submit" className="btn ghost sm">Upload BAA template</button></div>
        </form>
        <form action={uploadTemplate} className="flex flex-col gap-3 rounded-[20px] border border-line p-5">
          <input type="hidden" name="kind" value="sow_template" />
          <h2 className="text-lg">SOW template</h2>
          <Field label="PDF or DOCX" htmlFor="sow_file"><Input id="sow_file" name="file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required /></Field>
          <div><button type="submit" className="btn ghost sm">Upload SOW template</button></div>
        </form>
        <form action={saveBookingUrl} className="flex flex-col gap-3 rounded-[20px] border border-line p-5 md:col-span-2">
          <h2 className="text-lg">Calendar booking URL</h2>
          <Field label="https://…" htmlFor="booking_url" hint="Overrides BOOKING_URL from the environment."><Input id="booking_url" name="url" type="url" defaultValue={bookingUrl} placeholder="https://cal.com/…" /></Field>
          <div><button type="submit" className="btn ghost sm">Save booking URL</button></div>
        </form>
      </div>
    </>
  )
}
