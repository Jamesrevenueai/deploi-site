'use client'
/** Agents list (/store/agents, /shopify/agents) and the pieces shared by the agent screens. */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, NoStore, Panel, useStore } from './bits'
import { AGENT_CORRECTION_LABEL, agentWords, templateToolWords, toolBadges, fmtAgo, runWords, scheduleLabel, type StatusWords } from './format'
import type { AgentListItem, AgentRunCounts, AgentsResponse, AgentTemplateView, AuthorizationSummary, OverviewResponse, WeeklyResponse } from './types'

export function StatusBadge({ w }: { w: StatusWords }) {
  return <Badge tone={w.tone}>{w.label}</Badge>
}

/** "3 verified · 1 waiting for you · 1 blocked" from a run's counts; only non-zero outcomes are listed */
export function countsInWords(c: Partial<AgentRunCounts> | null | undefined): string {
  if (!c) return ''
  const parts: string[] = []
  const add = (n: unknown, one: string, many = one) => { if (typeof n === 'number' && n > 0) parts.push(`${n} ${n === 1 ? one : many}`) }
  add(c.issuesFound, 'problem found', 'problems found')
  add(c.verified, 'verified')
  add(c.awaitingApproval, 'waiting for approval')
  add(c.needsPerson, 'needs a person', 'need a person')
  add(c.unconfirmed, 'unconfirmed')
  add(c.failed, 'failed')
  add(c.blocked, 'blocked')
  add(c.stale, 'stale (records changed)')
  if (Array.isArray(c.missingSources) && c.missingSources.length) parts.push(`${c.missingSources.length} reference file${c.missingSources.length === 1 ? '' : 's'} missing`)
  const k = c.competitors
  if (k) {
    add(k.storesChecked, 'competitor store read', 'competitor stores read')
    add(k.storesSkipped, 'store not checked', 'stores not checked')
    add(k.baselines, 'starting point recorded', 'starting points recorded')
    add(k.findings, 'new finding', 'new findings')
    add(k.opportunities, 'possible opportunity', 'possible opportunities')
  }
  const e = c.email
  if (e) {
    add(e.emailDrafted, 'email drafted', 'emails drafted')
    add(e.emailAwaiting, 'email awaiting approval', 'emails awaiting approval')
    add(e.emailAccepted, 'email accepted by provider', 'emails accepted by provider')
    add(e.emailUnknown, 'email with delivery unknown', 'emails with delivery unknown')
    add(e.emailFailed, 'email failed', 'emails failed')
  }
  return parts.length ? parts.join(' · ') : 'no problems found'
}

/** The readable authorization: what it grants, its limits, and what it never does. */
export function AuthorizationSummaryView({ summary, title }: { summary: AuthorizationSummary; title?: ReactNode }) {
  const block = (h: string, items: string[], icon: string) => (
    <div>
      <h4 className="text-[14px] font-medium text-ink">{h}</h4>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map(x => <li key={x} className="flex gap-2 text-[15px] text-grey"><Icon name={icon} size={15} className="mt-1 shrink-0 text-grey-h" /><span className="min-w-0 break-words">{x}</span></li>)}
      </ul>
    </div>
  )
  return (
    <div className="flex flex-col gap-4" aria-label="Authorization summary">
      {title}
      {block('This authorization allows', summary.grants ?? [], 'check')}
      {block('Limits', summary.limits ?? [], 'clock')}
      {block('It never', summary.never ?? [], 'x')}
    </div>
  )
}

/** Connections and the merchant's timezone, for the agent form. */
export function useStoreBasics() {
  return useLoad(async () => {
    const o = await storeFetch<OverviewResponse>('/api/store/overview')
    const conns = o.connections.filter(c => c.status === 'active')
    const tz = conns[0]?.timezone ?? o.org?.timezone ?? 'UTC'
    return { connections: conns.length ? conns : o.connections, timezone: tz, orgName: o.org?.name ?? null, canApprove: o.actor.canApprove }
  }, 'basics')
}

export function BackToAgents() {
  const { base } = useStore()
  return <Link href={`${base}/agents`} className="mb-4 inline-flex items-center gap-1 text-[14px]"><span className="inline-flex items-center gap-1 text-grey hover:text-ink"><Icon name="arrow-right" size={14} style={{ transform: 'rotate(180deg)' }} />All agents</span></Link>
}

export function AgentsScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<AgentsResponse>('/api/store/agents'), 'agents')
  const header = (
    <PageHeader
      title="Agents"
      sub="Each agent does one job you describe. It uses only the tools you connect, at the permission level you grant: drafts only (the default), after your approval, or without asking within limits for up to a year."
      actions={<Button size="sm" href={`${base}/agents/new`}><Icon name="plus" size={15} />Create agent</Button>}
    />
  )
  if (loading && !data) return <>{header}<Loading label="Loading agents" /></>
  if (error && !data) return <>{header}{error.status === 404 ? <NoStore /> : <ErrorState error={error} onRetry={reload} />}</>
  const agents = data?.agents ?? []
  return (
    <>
      {header}
      {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}
      {(data?.templates?.length ?? 0) > 0 && <Templates templates={data!.templates!} />}
      {agents.length === 0 ? (
        <Empty title="No agents yet">Create an agent, describe its task in plain English, review exactly what it may change, then grant it. <Link href={`${base}/agents/new`}><span className="text-ink underline">Create agent</span></Link></Empty>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Agents">
          {agents.map(a => <AgentCard key={a.id} a={a} />)}
        </ul>
      )}
      <WeeklyPreview />
      <div className="mt-6"><Banner icon="shield">Agents only change what their authorization covers, re-read every record just before writing, and count a change as done only when a fresh read shows it (Verified). Store content and uploaded files are treated as data, never as instructions.</Banner></div>
    </>
  )
}

function AgentCard({ a }: { a: AgentListItem }) {
  const { base } = useStore()
  const w = agentWords(a.status)
  const last = a.last_run
  return (
    <li>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`${base}/agents/${a.id}`} className="text-[1.1rem] font-medium text-ink underline-offset-4 hover:underline">{a.name}</Link>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge w={w} />
              {toolBadges({ approvalMode: a.approval_mode, correctionTypes: a.correction_types, emailPermission: a.email_permission, competitors: a.competitor_stores > 0 }).map(b => <Badge key={b} tone="muted">{b}</Badge>)}
              {a.pending_version !== null && <Badge tone="warn">Version {a.pending_version} waiting for your grant</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {a.competitor_unseen > 0 && <Link href={`${base}/agents/${a.id}#competitors`} className="badge" style={{ padding: '6px 12px' }}>{a.competitor_unseen} new competitor finding{a.competitor_unseen === 1 ? '' : 's'}</Link>}
            {a.awaiting_approval > 0 && <Link href={`${base}/agents/${a.id}#waiting`} className="badge" style={{ padding: '6px 12px' }}>{a.awaiting_approval} awaiting approval</Link>}
            {a.needs_person > 0 && <Link href={`${base}/agents/${a.id}#person`} className="badge warn" style={{ padding: '6px 12px' }}>{a.needs_person} need{a.needs_person === 1 ? 's' : ''} a person</Link>}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[14px] sm:grid-cols-[max-content_1fr]">
          <dt className="text-grey-h">Corrects</dt><dd className="m-0 text-ink">{a.correction_types.length ? a.correction_types.map(t => AGENT_CORRECTION_LABEL[t] ?? t).join(', ') : a.active_version === null ? 'Not authorized yet' : a.competitor_stores > 0 ? `Nothing in your store (watches ${a.competitor_stores} competitor store${a.competitor_stores === 1 ? '' : 's'}, read only)` : 'Nothing in the store (email tasks only)'}</dd>
          <dt className="text-grey-h">Schedule</dt><dd className="m-0 text-ink">{scheduleLabel(a.schedule)}{a.status === 'active' && a.next_run_at ? ` · next ${fmtAgo(a.next_run_at)}` : ''}</dd>
          <dt className="text-grey-h">Last run</dt>
          <dd className="m-0 text-ink">{last ? <>{runWords(last.status).label} · {fmtAgo(last.finished_at ?? a.last_run_at)} · <span className="text-grey">{last.status_reason ?? countsInWords(last.counts as Partial<AgentRunCounts>)}</span></> : 'Not run yet'}</dd>
          {a.store && <><dt className="text-grey-h">Store</dt><dd className="m-0 text-grey break-all">{a.store}</dd></>}
        </dl>
        {a.status === 'draft' && <p className="pt-3 text-[13px] text-grey-h">{w.hint}</p>}
      </Panel>
    </li>
  )
}

/** Start from a template: pre-filled job, tools and the most restrictive permission level (drafts only). */
function Templates({ templates }: { templates: AgentTemplateView[] }) {
  const { base } = useStore()
  return (
    <section aria-labelledby="templates-h" className="mb-6">
      <h2 id="templates-h" className="mb-1 text-[1.1rem]">Start from a template</h2>
      <p className="mb-3 text-[14px] text-grey-h">Every template starts at drafts only for every tool, and gets its own email address when it sends email. You still read and grant its authorization before it does anything.</p>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map(t => (
          <li key={t.key}>
            <Panel className="h-full">
              <div className="flex h-full flex-col gap-2">
                <h3 className="text-[1.05rem]">{t.name}</h3>
                <p className="text-[14px] text-grey">{t.job}</p>
                <div className="flex flex-wrap gap-2">
                  {t.tools.map(x => <Badge key={x} tone="muted">{templateToolWords(x, { optionalEmail: t.key === 'competitor_watcher' })}</Badge>)}
                </div>
                <p className="text-[13px] text-grey-h">You add: {t.needs.join('; ')}.</p>
                <div className="mt-auto pt-1"><Button size="sm" variant="ghost" href={`${base}/agents/new?template=${t.key}`}>Use this template<Icon name="arrow-right" size={14} /></Button></div>
              </div>
            </Panel>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** This week's summary as it stands, and the status of the last one sent (never "sent" unless it was). */
export function WeeklyPreview() {
  const { base } = useStore()
  const { data } = useLoad(() => storeFetch<WeeklyResponse>('/api/store/weekly'), 'weekly')
  if (!data) return null
  const f = data.facts
  const lastStatus = data.last ? (data.last.status === 'accepted' ? `Last summary (week of ${data.last.week_start}) was accepted by the email provider.` : `Last summary (week of ${data.last.week_start}) was not sent: ${data.last.status_reason ?? data.last.status}.`) : 'No summary has been prepared yet.'
  return (
    <section aria-labelledby="weekly-h" className="mt-6">
      <Panel>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="weekly-h" className="text-[1.05rem]">Weekly summary</h2>
          <Badge tone="muted">week of {f.weekStart}</Badge>
          <Badge tone="muted">emailed Mondays</Badge>
          <Link href={`${base}/weekly`} className="ml-auto text-[13px] text-ink underline">See the email</Link>
        </div>
        <ul className="mt-3 flex flex-col gap-1 text-[14px] text-grey">
          {f.agents.length === 0 ? <li>No agents yet.</li> : f.agents.map(a => <li key={a.agentId}><span className="text-ink">{a.name}</span>: {a.runs} run(s), {a.verified} verified, {a.drafted} drafted, {a.emailsAccepted} email(s) sent, {a.emailsDrafted} email draft(s), {a.tasksDone} task(s) done{a.competitorObserved || a.competitorInferences ? `, ${a.competitorObserved ?? 0} competitor change(s) seen, ${a.competitorInferences ?? 0} trend(s) inferred` : ''}</li>)}
        </ul>
        <div className="mt-3 text-[14px]">
          <span className="text-grey-h">Needs your attention: </span>
          <span className="text-ink">{f.attention.length ? f.attention.map(a => `${a.count} ${a.label}`).join(' · ') : 'nothing'}</span>
        </div>
        <p className="mt-3 text-[14px] text-ink">Estimated time saved this week: about {f.estimate.minutes} minutes <Badge tone="warn">Estimate</Badge></p>
        <p className="pt-1 text-[13px] text-grey-h">An estimate, not a measurement: {f.estimate.formula}.</p>
        <p className="pt-2 text-[13px] text-grey-h">{lastStatus}{data.liveSends === 'off' ? ' Email sending is off in this environment, so summaries are prepared but not sent.' : ''}</p>
      </Panel>
    </section>
  )
}
