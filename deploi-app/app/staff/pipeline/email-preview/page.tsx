import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { buildMorningPipeline } from '@/lib/sales/morning'
import { renderMorningPipeline } from '@/emails/morning-pipeline'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'

export const metadata = { title: 'Morning pipeline email' }
export const dynamic = 'force-dynamic'

export default async function EmailPreviewPage() {
  await requireRole('staff')
  const data = await admin(db => buildMorningPipeline(db))
  const { html, text } = await renderMorningPipeline(data)
  return (
    <>
      <PageHeader eyebrow="Pipeline" title="Morning pipeline email" sub={`Sent at 7:00 AM ET to ${env.staffNotifyEmail} with today's numbers.`}
        actions={<Button variant="ghost" size="sm" href="/api/cron/morning-pipeline?force=1" external>Send now</Button>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <iframe title="HTML preview" srcDoc={html} className="h-[720px] w-full rounded-2xl border border-line bg-white" />
        <pre className="overflow-auto rounded-2xl border border-line p-4 text-[13px] text-grey whitespace-pre-wrap">{text}</pre>
      </div>
    </>
  )
}
