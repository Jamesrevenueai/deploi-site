'use client'
/** Needs you: every decision waiting, from every source (store changes, emails, agent and Office actions, case decisions), with the exact content. */
import { useState } from 'react'
import Link from 'next/link'
import { Button, EmptyState } from '@/components/app/ui'
import { Banner } from '@/components/ui/Banner'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Section } from '@/components/store/bits'
import { ApprovalCard, CaseList, Notice } from './bits'
import { loadApprovals, loadCases, loadTeam, directoryOf } from './data'
import { PAGE_VIEWS, approvalsWithoutCase, pendingDecisionsFor, type ApprovalEntry, type CaseItem } from './caseView'

export function ApprovalsScreen() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [approvals, c, team] = await Promise.all([loadApprovals(), loadCases(PAGE_VIEWS.approvals), loadTeam()])
    return { approvals, ...c, dir: directoryOf(team) }
  }, 'approvals')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const header = (
    <header className="mb-6 flex flex-col gap-2">
      <h1 className="app-h1">Needs you</h1>
      <p className="app-muted max-w-[62ch]">Everything your agents are waiting on you for. Approving does exactly what is shown and nothing else; declining closes it. Nothing here happens until you decide.</p>
    </header>
  )
  if (loading && !data) return <>{header}<Loading label="Loading approvals" rows={3} /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const items = data.approvals?.items ?? []
  const caseOf = (a: ApprovalEntry): CaseItem | undefined => data.cases.find(c => pendingDecisionsFor(c, [], [a]).length > 0)
  const withCase = items.filter(a => caseOf(a))
  const loose = approvalsWithoutCase(items, data.cases)
  const casesWithoutItem = data.cases.filter(c => !items.some(a => pendingDecisionsFor(c, [], [a]).length))
  const done = async (text: string) => { setMsg({ ok: true, text }); await reload() }
  const total = items.length + casesWithoutItem.length
  return (
    <>
      {header}
      <div aria-live="polite" className="mb-3 flex flex-col gap-3">
        <Notice msg={msg} />
        {data.approvals === null && <Banner tone="warn"><strong>The approvals list could not be read.</strong> Cases waiting for you are still listed below.</Banner>}
        {data.approvals?.errors?.map(e => <Banner key={e.source} tone="warn"><strong>Some items could not be loaded</strong> ({e.source}): {e.message}</Banner>)}
      </div>
      {total > 0 && <p className="mb-2 text-[14px] text-grey-h" data-testid="approvals-total">{total} waiting</p>}
      {total === 0 && (
        <EmptyState title="Nothing needs you right now" testId="needs-you-empty" action={<><Button href="/store">Back to the Command center</Button><Button variant="secondary" href="/store/work">See work in progress</Button></>}>
          Your agents have no decisions waiting for you. When one needs a yes, it shows up here with what it spotted and what it prepared.
        </EmptyState>
      )}
      {withCase.length > 0 && (
        <Section id="case-decisions" title="Decisions on open work" sub="Each belongs to a case; open the case for the full history and evidence.">
          <div className="flex flex-col gap-3">{withCase.map(a => <ApprovalCard key={`${a.source}:${a.id}`} item={a} caseRef={caseOf(a)?.ref} onDone={done} />)}</div>
        </Section>
      )}
      {loose.length > 0 && (
        <Section id="other-decisions" title="Changes and messages" sub="Store changes, emails and agent actions waiting for you.">
          <div className="flex flex-col gap-3">{loose.map(a => <ApprovalCard key={`${a.source}:${a.id}`} item={a} onDone={done} />)}</div>
        </Section>
      )}
      {casesWithoutItem.length > 0 && (
        <Section id="waiting-cases" title="Cases waiting for you" sub="Open a case to see what it needs from you.">
          <CaseList cases={casesWithoutItem} dir={data.dir} label="Cases waiting for approval" empty={null} />
        </Section>
      )}
      <p className="pt-6 text-[13px] text-grey-h">To edit an email before approving it, use the <Link href="/store/approvals/review" className="link">detailed review</Link>.</p>
    </>
  )
}
