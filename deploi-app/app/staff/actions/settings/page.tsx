import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Select } from '@/components/ui/Field'
import { AutoSendForm } from '@/components/actions/AutoSendForm'
import { saveAutoSend } from '../actions'
import type { WorkerName } from '@/lib/workers/types'

export const metadata = { title: 'Auto-send settings' }
export const dynamic = 'force-dynamic'

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { agencies, current } = await withUser(session, async db => {
    const agencies = await db.query<{ id: string; name: string; auto_send: Partial<Record<WorkerName, boolean>> }>('select id, name, auto_send from agencies order by name')
    const current = agencies.find(a => a.id === sp.agency) ?? agencies[0]
    return { agencies, current }
  }, { ip: await requestIp() })

  return (
    <>
      <PageHeader title="Auto-send" sub="Per agency, per worker. OFF means every message waits for a staff approval on the Actions page." />
      <div className="mb-5"><Banner tone="warn"><strong>Switching a worker ON sends its messages to aides, families and referrers without anyone reading them first.</strong> Keep it OFF until that worker has run clean for a few days.</Banner></div>
      {sp.saved && <div className="mb-4"><Banner icon="check"><strong>Saved.</strong></Banner></div>}
      <form method="get" className="mb-6 max-w-sm">
        <label className="field"><span className="text-ink text-[14px] font-medium">Agency</span>
          <Select name="agency" defaultValue={current?.id} onChange={undefined}>
            {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </label>
        <noscript><button className="btn ghost sm mt-2" type="submit">Load</button></noscript>
        <button className="btn ghost xs mt-2" type="submit">Load agency</button>
      </form>
      {current && <AutoSendForm agencyId={current.id} autoSend={current.auto_send ?? {}} action={saveAutoSend} />}
    </>
  )
}
