'use client'
/**
 * An agent's tasks, mailbox and work log. Tasks are plain language: within the granted rules they run
 * now; outside them they wait for a wider grant; anything unclear is refused. The work log answers, for
 * every recorded action: what happened, when, why, and which permission allowed it.
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, Panel, Section } from './bits'
import { StatusBadge } from './Agents'
import { INBOUND_CLASS_LABEL, fmtTime, taskWords } from './format'

type Task = { id: string; text: string; status: string; status_reason: string | null; outside_rules: string[]; policy_version: number | null; run_id: string | null; proof: Record<string, unknown> | null; created_at: string; finished_at: string | null }
type LogEntry = { at: string; what: string; why: string | null; permission: string; event: string; actor: string }
type Inbound = { id: string; from_address: string; classification: string; status: string; status_reason: string | null; received_at: string }
type WorkResponse = { ok: true; log: LogEntry[]; tasks: Task[]; mailbox: { id: string; address: string; status: string } | null; inbound: Inbound[]; mailDomain: string | null }

export function AgentWorkSections({ agentId, agentActive, refreshKey, onChanged }: { agentId: string; agentActive: boolean; refreshKey: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<WorkResponse>(`/api/store/agents/${encodeURIComponent(agentId)}/worklog`), `work:${agentId}:${refreshKey}`)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [last, setLast] = useState<Task | null>(null)

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null)
    try { await fn() } catch (e) { setErr(asApiError(e)) } finally { setBusy(null); await reload(); onChanged() }
  }
  const assign = () => act('task', async () => {
    const r = await storeFetch<{ task: Task }>(`/api/store/agents/${agentId}/task`, { method: 'POST', body: { text } })
    setLast(r.task); setText('')
  })
  const cancel = (t: Task) => act(`cancel:${t.id}`, async () => { await storeFetch(`/api/store/agents/${agentId}/cancel-task`, { method: 'POST', body: { taskId: t.id } }) })
  const mailbox = () => act('mailbox', async () => { await storeFetch(`/api/store/agents/${agentId}/mailbox`, { method: 'POST', body: {} }) })

  if (loading && !data) return <Section id="tasks" title="Tasks"><Loading label="Loading tasks and work log" /></Section>
  if (error && !data) return <Section id="tasks" title="Tasks"><ErrorState error={error} onRetry={reload} /></Section>
  const d = data!

  return (
    <>
      <Section id="tasks" title="Tasks" sub="Give this agent a task in your own words. If it fits the rules you granted, it runs now. If it needs more, it waits until you widen the agent and grant the new version. If Deploi cannot tell what to do, nothing runs.">
        <Panel>
          <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (text.trim()) void assign() }}>
            <label htmlFor="task-text" className="text-[14px] text-grey">New task</label>
            <Textarea id="task-text" rows={2} maxLength={2000} value={text} placeholder="e.g. Check overselling on all products now" onChange={e => setText(e.target.value)} />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" type="submit" disabled={!text.trim() || busy !== null}><Icon name="spark" size={15} />{busy === 'task' ? 'Checking and running…' : 'Assign task'}</Button>
              {!agentActive && <span className="text-[13px] text-grey-h">The agent is not active: tasks within its rules wait in the queue.</span>}
            </div>
          </form>
        </Panel>
        <div aria-live="polite" className="mt-3 flex flex-col gap-3">
          {err && <ErrorState error={err} />}
          {last && <Banner tone={last.status === 'done' ? 'info' : last.status === 'refused' || last.status === 'failed' ? 'warn' : 'info'}><strong>{taskWords(last.status).label}.</strong> {last.status_reason}</Banner>}
        </div>
        {d.tasks.length === 0 ? <div className="mt-3"><Empty title="No tasks yet">Tasks you assign appear here with an honest status.</Empty></div> : (
          <ul className="mt-3 flex flex-col gap-2" aria-label="Tasks">
            {d.tasks.map(t => (
              <li key={t.id} className="rounded-[16px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge w={taskWords(t.status)} />
                  <span className="min-w-0 break-words text-[15px] text-ink">&ldquo;{t.text}&rdquo;</span>
                </div>
                {t.status_reason && <p className="pt-2 text-[14px] text-grey">{t.status_reason}</p>}
                {t.proof && <p className="pt-1 text-[13px] text-grey-h">Proof: run {String(t.proof.run_id ?? '').slice(0, 8)} · {String(t.proof.verified ?? 0)} verified · {String(t.proof.drafted ?? 0)} drafted · {String(t.proof.awaiting_approval ?? 0)} waiting · {String(t.proof.failed ?? 0)} failed</p>}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-grey-h">
                  <span>Assigned {fmtTime(t.created_at)}{t.policy_version ? ` · checked against authorization v${t.policy_version}` : ''}</span>
                  {(t.status === 'needs_approval' || t.status === 'queued') && <Button size="sm" variant="ghost" onClick={() => cancel(t)} disabled={busy !== null}>Cancel task</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="mailbox" title="Agent mailbox" sub="The agent's own address on Deploi's domain. It sends from here and suppliers reply here. Forward or copy a thread to this address to share it with the agent. A mailbox grants nothing: the authorization still decides whether it drafts, sends after approval or sends without asking, and to whom.">
        <Panel>
          {d.mailbox ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2"><Icon name="mail" size={16} /><span className="break-all text-[1.05rem] font-medium text-ink">{d.mailbox.address}</span><Badge tone="ok">Ready</Badge></div>
              <p className="text-[13px] text-grey-h">Only this agent can send from this address. Mail from senders outside its allowed recipients, or that fails sender checks, is quarantined. Incoming mail never changes what the agent may do.</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[15px] text-grey">This agent has no address yet.</p>
              <Button size="sm" variant="ghost" onClick={mailbox} disabled={busy !== null || !d.mailDomain}>{busy === 'mailbox' ? 'Creating…' : 'Give it an address'}</Button>
              {!d.mailDomain && <span className="text-[13px] text-grey-h">Agent mailboxes are not set up in this environment yet.</span>}
            </div>
          )}
        </Panel>
        {d.inbound.length > 0 && (
          <div className="table-wrap mt-3">
            <table className="dg-table">
              <caption className="sr-only">Mail received at the agent mailbox</caption>
              <thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Kind</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {d.inbound.map(i => (
                  <tr key={i.id}>
                    <td className="whitespace-nowrap">{fmtTime(i.received_at)}</td>
                    <td className="break-all">{i.from_address}</td>
                    <td>{INBOUND_CLASS_LABEL[i.classification] ?? i.classification}</td>
                    <td>{i.status === 'accepted' ? <Badge tone="ok">Accepted</Badge> : <Badge tone="warn">Quarantined</Badge>}{i.status_reason && <span className="block text-[13px] text-grey-h">{i.status_reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="worklog" title="Work log" sub="Every action this agent took or was refused: what happened, when, why, and which permission allowed it.">
        {d.log.length === 0 ? <Empty title="Nothing logged yet">Actions appear here as the agent works.</Empty> : (
          <div className="table-wrap">
            <table className="dg-table">
              <caption className="sr-only">Work log</caption>
              <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Why</th><th scope="col">Allowed by</th></tr></thead>
              <tbody>
                {d.log.slice(0, 100).map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="whitespace-nowrap">{fmtTime(e.at)}</td>
                    <td className="ink break-words">{e.what}</td>
                    <td className="break-words">{e.why ?? '—'}</td>
                    <td className="break-words">{e.permission}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}
