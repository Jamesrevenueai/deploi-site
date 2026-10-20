import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { heldConversations, CONVERSATION_GOAL } from '@/lib/evv/gate'
import { CONNECTORS } from '@/lib/evv/connectors'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { EvvView, type Tab } from '@/components/evv/EvvView'

export const metadata = { title: 'EVV exceptions' }
export const dynamic = 'force-dynamic'

export default async function StaffEvv({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const tab = (['open', 'corrected', 'hold'].includes(sp.tab ?? '') ? sp.tab : 'open') as Tab
  const { agencies, held } = await withUser(session, async db => ({
    agencies: await db.query<{ id: string; name: string; state: string }>('select id, name, state from agencies order by name'),
    held: await heldConversations(db),
  }))
  const agencyId = agencies.find(a => a.id === sp.agency)?.id ?? agencies.find(a => a.name.startsWith('Buckeye'))?.id ?? agencies[0]?.id
  const agency = agencies.find(a => a.id === agencyId)

  return (
    <>
      <PageHeader
        title="EVV exceptions"
        sub="Visits checked against EVV and the authorization, sorted by the correction window. Fix them before the window closes and before billing."
        actions={<Button href={`/staff/evv/import?agency=${agencyId ?? ''}`} size="sm"><Icon name="upload" size={16} />Import visits</Button>}
      />

      <div className="mb-5 flex flex-col gap-4">
        <Banner tone={held >= CONVERSATION_GOAL ? 'info' : 'warn'} icon="chat">
          <strong>Real connector work starts after {CONVERSATION_GOAL} held owner conversations.</strong> {held}/{CONVERSATION_GOAL} so far — see <Link href="/staff/conversations" className="underline text-ink">/staff/conversations</Link>. Until then this module runs on CSV exports.
        </Banner>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-grey-h">Connectors:</span>
          {CONNECTORS.map(c => <span key={c.vendor} className={`glass ${c.status === 'next' ? 'muted' : ''}`} style={{ padding: '5px 10px', fontSize: 13 }}>{c.label}<span className="divider" aria-hidden="true" />{c.status === 'first' ? 'CSV now · API first' : 'CSV now · API next'}</span>)}
        </div>
      </div>

      <form method="get" className="mb-5 flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value={tab} />
        <label htmlFor="agency" className="text-[14px] text-grey-h">Agency</label>
        <div className="w-full max-w-xs"><Select id="agency" name="agency" defaultValue={agencyId}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name} · {a.state}</option>)}</Select></div>
        <button className="btn ghost xs" type="submit">Switch</button>
      </form>

      {agencyId ? <EvvView session={session} agencyId={agencyId} tab={tab} basePath="/staff/evv" extraQuery={`&agency=${agencyId}`} /> : null}
      {agency && <p className="mt-6 text-[13px] text-grey-h">Correction window for {agency.state}: see EVV_CORRECTION_WINDOWS. Red at 7 days or less.</p>}
    </>
  )
}
