import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listProspects, stageCounts, distinctCounties } from '@/lib/sales/queries'
import { STAGES, STAGE_LABEL, PROGRAMS } from '@/lib/sales/stages'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Select, Input } from '@/components/ui/Field'
import { Kanban } from '@/components/sales/Kanban'
import { ProspectList } from '@/components/sales/ProspectList'

export const metadata = { title: 'Pipeline' }
export const dynamic = 'force-dynamic'

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const filters = { program: sp.program ?? '', county: sp.county ?? '', stage: sp.stage ?? '', q: sp.q ?? '' }
  const filtered = Boolean(filters.program || filters.county || filters.stage || filters.q)
  const listView = sp.view === 'list' || filtered
  const { prospects, counts, counties } = await withUser(session, async db => ({
    prospects: await listProspects(db, filters), counts: await stageCounts(db), counties: await distinctCounties(db),
  }), { ip: await requestIp() })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <>
      <PageHeader
        title="Pipeline"
        sub={`${total} prospects · ${STAGES.filter(s => s !== 'lost' && s !== 'new').map(s => `${counts[s] ?? 0} ${STAGE_LABEL[s].toLowerCase()}`).slice(0, 4).join(' · ')}`}
        actions={<>
          <Button variant="ghost" size="sm" href={listView ? '/staff/pipeline' : '/staff/pipeline?view=list'} className="hidden min-[960px]:inline-flex">{listView ? 'Board view' : 'List view'}</Button>
          <Button size="sm" href="/staff/pipeline/import">Import CSV</Button>
        </>}
      />
      <form method="get" className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-[1fr_1fr_1fr_1.4fr_auto]">
        <input type="hidden" name="view" value="list" />
        <Select name="program" defaultValue={filters.program} aria-label="Program">
          <option value="">All programs</option>
          {PROGRAMS.map(p => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select name="county" defaultValue={filters.county} aria-label="County">
          <option value="">All counties</option>
          {counties.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select name="stage" defaultValue={filters.stage} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]} ({counts[s] ?? 0})</option>)}
        </Select>
        <Input name="q" defaultValue={filters.q} placeholder="Search agency or owner" aria-label="Search" />
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>
      {listView ? <ProspectList prospects={prospects} /> : (
        <>
          <Kanban prospects={prospects} />
          <div className="min-[960px]:hidden"><ProspectList prospects={prospects} /></div>
        </>
      )}
    </>
  )
}
