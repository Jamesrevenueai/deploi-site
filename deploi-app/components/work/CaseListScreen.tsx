'use client'
/** Work in Progress (cases being handled or needing attention) and Completed Work (verified outcomes). */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Empty } from '@/components/ui/Empty'
import { Badge } from '@/components/ui/Badge'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Section } from '@/components/store/bits'
import { CaseList } from './bits'
import { loadCases, loadTeam, directoryOf } from './data'
import { PAGE_VIEWS, STATUS_WORDS, EMPTY_DIRECTORY } from './caseView'

const COPY = {
  work: { title: 'Work in Progress', sub: 'Every problem your AI team is handling, from discovery to a verified result. Blocked or failed work is listed first.' },
  completed: { title: 'Completed Work', sub: 'Work that is done and verified: each outcome was confirmed by a fresh read of the system it happened in. A sent message alone never counts as done.' },
} as const

export function CaseListScreen({ page }: { page: 'work' | 'completed' }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [c, team] = await Promise.all([loadCases(PAGE_VIEWS[page]), loadTeam()])
    return { ...c, dir: directoryOf(team) }
  }, `cases-${page}`)
  const header = <PageHeader title={COPY[page].title} sub={COPY[page].sub} />
  if (loading && !data) return <>{header}<Loading label={`Loading ${COPY[page].title}`} rows={3} /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const dir = data.dir ?? EMPTY_DIRECTORY
  if (page === 'completed') {
    return (
      <>
        {header}
        <div className="mb-2 flex flex-wrap gap-2"><Badge tone="ok">{data.counts.completed} verified</Badge><Badge tone="muted">{data.counts.resolved_30d} in the last 30 days</Badge></div>
        <CaseList cases={data.cases} dir={dir} label="Completed work" empty={<Empty title="Nothing completed yet">When your team resolves a problem and a fresh read confirms it, it shows here with its evidence. <Link href="/store/work" className="link">See work in progress</Link>.</Empty>} />
        <p className="pt-6 text-[13px] text-grey-h">Cases you closed yourself (an acknowledged market signal, a request you no longer need) are not counted here: nothing was verified. Earlier store corrections and their verification are in <Link href="/store/activity" className="link">Activity</Link>.</p>
      </>
    )
  }
  const attention = data.cases.filter(c => STATUS_WORDS[c.status]?.stage === 'attention')
  const rest = data.cases.filter(c => STATUS_WORDS[c.status]?.stage !== 'attention')
  return (
    <>
      {header}
      <div className="mb-2 flex flex-wrap gap-2">
        <Badge tone="info">{data.counts.in_progress} in progress</Badge>
        <Badge tone={data.counts.attention ? 'danger' : 'muted'}>{data.counts.attention} need attention</Badge>
        <Badge tone={data.counts.needs_approval ? 'warn' : 'muted'}>{data.counts.needs_approval} waiting for you</Badge>
      </div>
      {attention.length > 0 && <Section id="attention" title="Needs attention" sub="Blocked, failed or handed to a person. Open one to see why and what you can do."><CaseList cases={attention} dir={dir} label="Needs attention" empty={null} /></Section>}
      <Section id="in-progress" title="Being handled" sub={data.counts.needs_approval ? <>Work waiting for your decision is in <Link href="/store/approvals" className="link">Needs My Approval</Link>.</> : undefined}>
        <CaseList cases={rest} dir={dir} label="Work in progress" empty={<Empty title="Nothing in progress">When Deploi finds work in your connected tools, it shows here as it is handled. <Link href="/store/integrations" className="link">Check your connections</Link>.</Empty>} />
      </Section>
      <p className="pt-6 text-[13px] text-grey-h">Store checks by product are in <Link href="/store/issues" className="link">Issues</Link>.</p>
    </>
  )
}
