'use client'
/** The weekly summary: the in-app version, and the email exactly as it renders (sent Mondays when sending is allowed). */
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, Panel, Section } from './bits'
import { BackToAgents, WeeklyPreview } from './Agents'
import type { WeeklyResponse } from './types'

export function WeeklyScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<WeeklyResponse>('/api/store/weekly'), 'weekly-email')
  const header = <><BackToAgents /><PageHeader title="Weekly summary" sub="What your agents did this week and what needs you. Time saved is an estimate, and the email says so." /></>
  if (loading && !data) return <>{header}<Loading label="Loading the summary" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  return (
    <>
      {header}
      <Section id="in-app" title="In the app"><WeeklyPreview /></Section>
      <Section id="email" title="The email" sub={d.liveSends === 'off' ? 'Email sending is off in this environment: this is exactly what would be sent, but nothing is sent.' : 'Sent on Mondays to the people in your organization.'}>
        <Panel>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[14px]">
            <dt className="text-grey-h">From</dt><dd className="m-0 break-all text-ink">{d.from ?? 'Deploi AI'}</dd>
            <dt className="text-grey-h">Subject</dt><dd className="m-0 break-words text-ink">{d.rendered.subject}</dd>
          </dl>
          {d.rendered.html ? (
            <iframe title="Weekly summary email" srcDoc={d.rendered.html} sandbox="" className="mt-4 h-[760px] w-full rounded-[12px] border border-line bg-white" />
          ) : <pre className="mt-4 whitespace-pre-wrap text-[14px] text-grey">{d.rendered.text}</pre>}
        </Panel>
        {d.last && d.last.status !== 'accepted' && <div className="mt-3"><Banner tone="warn">Last summary (week of {d.last.week_start}) was not sent: {d.last.status_reason ?? d.last.status}.</Banner></div>}
      </Section>
    </>
  )
}
