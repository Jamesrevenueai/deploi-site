'use client'
/** One agent: its authorization, waiting changes, items for a person, verified results and runs. */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { Field, Textarea, Input } from '@/components/ui/Field'
import { storeFetch, asApiError, StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, Panel, Section, SeverityBadge, useStore } from './bits'
import { AgentPolicyForm, formFromPolicy, policyFromForm, type AgentFormState } from './AgentForm'
import { AuthorizationSummaryView, BackToAgents, StatusBadge, countsInWords, useStoreBasics } from './Agents'
import {
  AGENT_CORRECTION_LABEL, APPROVAL_MODE_LABEL, TRIGGER_LABEL, actorLabel, agentWords, changeInWords, executionWords, fmtTime, fmtUntil, fmtValue, fieldLabel,
  proposalWords, runWords, scheduleLabel,
} from './format'
import type {
  AgentDetailResponse, AgentExecutionRow, AgentPolicyRow, AgentRunResponse, AgentWaitingRow, EditAgentResponse, ExecutionResult, GrantResponse,
} from './types'

type Notice =
  | { kind: 'run'; r: AgentRunResponse }
  | { kind: 'approve'; r: ExecutionResult; target: string }
  | { kind: 'edit'; r: EditAgentResponse }
  | { kind: 'done'; message: string }
  | { kind: 'error'; e: StoreApiError; what: string }

const CONFLICT: Record<string, string> = {
  expired: 'This change expired before it was approved. Run the agent again for a fresh proposal.',
  hash_mismatch: 'The change was updated after this page loaded. Review the current version and approve again.',
  not_pending: 'This is no longer waiting for approval. Its current state is shown below.',
  agent_inactive: 'The agent is not active. Resume it or grant its authorization first.',
  busy: 'This agent is already running. Wait for that run to finish.',
}

export function AgentDetailScreen({ id }: { id: string }) {
  const { base } = useStore()
  const router = useRouter()
  const { data, error, loading, reload } = useLoad(() => storeFetch<AgentDetailResponse>(`/api/store/agents/${encodeURIComponent(id)}`), id)
  const basics = useStoreBasics()
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<null | 'revoke' | 'delete' | 'pause'>(null)
  const [reason, setReason] = useState('')
  const [editing, setEditing] = useState<{ form: AgentFormState; name: string; task: string; showProblems: boolean } | null>(null)

  if (loading && !data) return <><BackToAgents /><Loading label="Loading agent" rows={4} /></>
  if (error && !data) {
    if (error.status === 404 || error.code === 'not_found') {
      return <><BackToAgents /><Empty title="Agent not found">This agent does not exist or belongs to another store. <Link href={`${base}/agents`}><span className="text-ink underline">Back to agents</span></Link></Empty></>
    }
    return <><BackToAgents /><ErrorState error={error} onRetry={reload} /></>
  }
  if (!data) return null

  const { agent, policies, runs, executions, waiting, needsPerson, pendingExpansion } = data
  const active = policies.find(p => p.status === 'active') ?? null
  const pending = policies.find(p => p.status === 'pending_grant') ?? null
  const latest = active ?? pending ?? policies[0] ?? null
  const w = agentWords(agent.status)
  const timezone = basics.data?.timezone ?? 'UTC'

  async function act(key: string, what: string, run: () => Promise<Notice | null>) {
    setBusy(key); setNotice(null)
    try { setNotice(await run()) } catch (e) {
      const err = asApiError(e)
      setNotice(err.status === 409 && CONFLICT[err.code] ? { kind: 'error', e: new StoreApiError(err.status, err.code, `${CONFLICT[err.code]} (${err.message})`), what } : { kind: 'error', e: err, what })
    } finally { setBusy(null); await reload() }
  }
  const post = <T,>(action: string, body: unknown = {}) => storeFetch<T>(`/api/store/agents/${agent.id}/${action}`, { method: 'POST', body })

  const runNow = () => act('run', 'Run not started', async () => ({ kind: 'run', r: await post<AgentRunResponse>('run') }))
  const pause = () => act('pause', 'Not paused', async () => { const r = await post<{ proposalsBlocked: number }>('pause'); setDialog(null); return { kind: 'done', message: `Paused. Nothing will run or be written${r.proposalsBlocked ? `; ${r.proposalsBlocked} waiting or queued change${r.proposalsBlocked === 1 ? ' was' : 's were'} cancelled` : ''}. The authorization is kept; resume to continue.` } })
  const resume = () => act('resume', 'Not resumed', async () => { await post('resume'); return { kind: 'done', message: 'Resumed. The agent runs on its schedule again.' } })
  const revoke = () => act('revoke', 'Not revoked', async () => { const r = await post<{ proposalsBlocked: number }>('revoke', reason.trim() ? { reason: reason.trim() } : {}); setDialog(null); setReason(''); return { kind: 'done', message: `Authorization revoked. The agent will not write anything${r.proposalsBlocked ? `; ${r.proposalsBlocked} waiting or queued change${r.proposalsBlocked === 1 ? ' was' : 's were'} cancelled` : ''}. Its history is kept. To use it again, edit it and grant a new authorization.` } })
  async function remove() {
    setBusy('delete'); setNotice(null)
    try { await storeFetch(`/api/store/agents/${agent.id}`, { method: 'DELETE' }); setDialog(null); router.push(`${base}/agents`) } catch (e) { setDialog(null); setNotice({ kind: 'error', e: asApiError(e), what: 'Not deleted' }); setBusy(null) }
  }
  const grant = (p: AgentPolicyRow) => act('grant', 'Not granted', async () => { const r = await post<GrantResponse>('grant', { policyId: p.id, policyHash: p.policy_hash }); return { kind: 'done', message: `Authorization version ${r.version} granted and active.${r.warnings.length ? ` Note: ${r.warnings.join(' ')}` : ''}` } })
  const approve = (wt: AgentWaitingRow) => act(`approve:${wt.id}`, 'Not approved', async () => ({ kind: 'approve', target: wt.target_label ?? 'this record', r: await storeFetch<ExecutionResult>(`/api/store/proposals/${wt.id}/approve`, { method: 'POST', body: { changeHash: wt.change_hash } }) }))

  function startEdit() {
    if (!latest) return
    setNotice(null)
    setEditing({ form: formFromPolicy(latest.policy), name: agent.name, task: agent.task_text, showProblems: false })
  }
  async function saveEdit() {
    if (!editing) return
    const { policy } = policyFromForm(editing.form, timezone)
    setEditing({ ...editing, showProblems: true })
    if (!policy || !editing.name.trim()) return
    await act('edit', 'Not saved', async () => {
      const r = await storeFetch<EditAgentResponse>(`/api/store/agents/${agent.id}`, { method: 'PUT', body: { name: editing.name.trim(), taskText: editing.task, policy } })
      setEditing(null)
      return { kind: 'edit', r }
    })
  }

  if (editing) {
    const check = policyFromForm(editing.form, timezone)
    return (
      <>
        <BackToAgents />
        <PageHeader eyebrow={agent.name} title="Edit agent" sub="Changes that only narrow what the agent may do take effect at once. Anything that allows more is saved as a new version that waits for your grant; the current version keeps running until then." />
        <div aria-live="polite">{notice?.kind === 'error' && <div className="mb-4"><ErrorState error={notice.e} /></div>}</div>
        <Panel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="edit-name" className="text-[14px] text-grey">Agent name</label>
              <Input id="edit-name" value={editing.name} maxLength={80} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="edit-task" className="text-[14px] text-grey">Task, in plain English (for your reference; the form below is what is authorized)</label>
              <Textarea id="edit-task" value={editing.task} rows={3} maxLength={2000} onChange={e => setEditing({ ...editing, task: e.target.value })} />
            </div>
          </div>
        </Panel>
        <div className="mt-4">
          <AgentPolicyForm value={editing.form} onChange={form => setEditing({ ...editing, form })} connections={basics.data?.connections ?? []} timezone={timezone} lockConnection showProblems={editing.showProblems} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={saveEdit} disabled={busy !== null || (editing.showProblems && !check.policy)}><Icon name="check" size={16} />{busy === 'edit' ? 'Saving…' : 'Save changes'}</Button>
          <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy !== null}>Cancel</Button>
        </div>
      </>
    )
  }

  const isActive = agent.status === 'active', isPaused = agent.status === 'paused'
  return (
    <>
      <BackToAgents />
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        sub={agent.task_text ? <>&ldquo;{agent.task_text}&rdquo;</> : undefined}
        actions={
          <>
            <Button size="sm" onClick={runNow} disabled={!isActive || busy !== null} aria-label="Run now">
              <Icon name="bolt" size={15} />{busy === 'run' ? 'Running…' : 'Run now'}
            </Button>
            {isActive && <Button size="sm" variant="ghost" onClick={() => setDialog('pause')} disabled={busy !== null}>Pause</Button>}
            {isPaused && <Button size="sm" variant="ghost" onClick={resume} disabled={busy !== null}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</Button>}
            <Button size="sm" variant="ghost" onClick={startEdit} disabled={busy !== null || !latest}><Icon name="edit" size={15} />Edit</Button>
            {(isActive || isPaused || agent.status === 'draft') && <Button size="sm" variant="ghost" onClick={() => setDialog('revoke')} disabled={busy !== null}>Revoke</Button>}
            <Button size="sm" variant="danger" onClick={() => setDialog('delete')} disabled={busy !== null}>Delete</Button>
          </>
        }
      />
      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
        <StatusBadge w={w} />
        {latest && <Badge tone="muted">{APPROVAL_MODE_LABEL[latest.policy.approvalMode]}</Badge>}
        <Badge tone="muted">{scheduleLabel(agent.schedule)}</Badge>
        {active && <span className="text-[13px] text-grey-h">Authorization version {active.version}</span>}
        {isActive && agent.next_run_at && <span className="text-[13px] text-grey-h">Next run {fmtTime(agent.next_run_at)}</span>}
      </div>
      {w.hint && agent.status !== 'active' && <div className="mb-4"><Banner tone={agent.status === 'draft' ? 'info' : 'warn'}>{w.hint}</Banner></div>}

      <div aria-live="polite" className="flex flex-col gap-3">
        {notice && <NoticeView n={notice} />}
        {error && <ErrorState error={error} onRetry={reload} />}
      </div>

      <Section id="authorization" title="Authorization" sub="What this agent is allowed to do. Each change it makes records the version it ran under and why it qualified.">
        <div className="flex flex-col gap-3">
          {pending && (
            <Panel tone="warn">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[1.05rem]">Version {pending.version} is waiting for your grant</h3>
                <Badge tone="warn">Not active</Badge>
              </div>
              {pendingExpansion && pendingExpansion.length > 0 && (
                <div className="mt-3">
                  <div className="text-[14px] text-ink">{active ? 'This version allows more than the current one:' : 'This is the agent\'s first authorization.'}</div>
                  {active && <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[15px] text-grey">{pendingExpansion.map(r => <li key={r}>{r}</li>)}</ul>}
                </div>
              )}
              <div className="mt-4"><AuthorizationSummaryView summary={pending.summary} /></div>
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                <Button size="sm" onClick={() => grant(pending)} disabled={busy !== null} aria-label={`Grant authorization version ${pending.version}`}><Icon name="check" size={15} />{busy === 'grant' ? 'Granting…' : 'Grant this authorization'}</Button>
                <span className="text-[13px] text-grey-h">{active ? `Until you grant it, version ${active.version} keeps running unchanged.` : 'Until you grant it, the agent does nothing.'}</span>
              </div>
            </Panel>
          )}
          {active ? (
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[1.05rem]">Current authorization · version {active.version}</h3>
                <Badge tone={isActive ? 'ok' : 'muted'}>{isActive ? 'In force' : isPaused ? 'Kept while paused' : 'Granted'}</Badge>
              </div>
              <p className="pt-1 text-[13px] text-grey-h">Granted {fmtTime(active.granted_at)} by {actorLabel(active.granted_by)} · corrects {active.policy.correctionTypes.map(t => AGENT_CORRECTION_LABEL[t] ?? t).join(', ')}</p>
              <div className="mt-4"><AuthorizationSummaryView summary={active.summary} /></div>
            </Panel>
          ) : !pending && (
            <Panel><p className="text-[15px] text-grey">{agent.status === 'revoked' ? 'No authorization is in force: it was revoked. Edit the agent to review and grant a new one.' : 'No authorization is in force.'}</p></Panel>
          )}
          <p className="text-[13px] text-grey-h">Pausing or revoking stops all writes, including changes already approved and queued. Pausing keeps the authorization; revoking ends it.</p>
        </div>
      </Section>

      <Section id="waiting" title="Waiting for your approval" sub="Exact changes this agent found but may not make on its own. Approving runs the change now: Deploi re-reads the record, writes it, and confirms it with a fresh read.">
        {waiting.length === 0 ? <Empty title="Nothing waiting">No changes are waiting for your approval.</Empty> : (
          <ul className="flex flex-col gap-3">
            {waiting.map(wt => <WaitingItem key={wt.id} wt={wt} review={latest?.policy.approvalMode === 'review'} busy={busy} onApprove={() => approve(wt)} canAct={isActive} />)}
          </ul>
        )}
      </Section>

      <Section id="person" title="Needs a person" sub="Problems the agent found but cannot correct safely (ambiguous or conflicting data, items outside what Deploi can change).">
        {needsPerson.length === 0 ? <Empty title="Nothing for a person">Nothing needs a person right now.</Empty> : (
          <ul className="flex flex-col gap-3">
            {needsPerson.map(n => (
              <li key={n.id}>
                <Panel>
                  <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={n.severity} /><span className="text-ink font-medium break-words">{n.resource_label ?? 'Record'}</span></div>
                  {n.summary && <p className="pt-2 text-[15px] text-grey">{n.summary}</p>}
                  {n.human_action && <p className="pt-2 text-[15px] text-ink"><span className="text-grey-h">What to do: </span>{n.human_action}</p>}
                  <div className="mt-2 flex flex-wrap gap-3 text-[13px] text-grey-h"><span>First seen {fmtTime(n.first_detected_at)}</span><Link href={`${base}/issues/${n.id}`} className="text-ink underline">Evidence</Link></div>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="results" title="Results" sub="Every change this agent made or tried. Only Verified means a fresh read of the store shows the change.">
        {executions.length === 0 ? <Empty title="No changes yet">Results appear here after the agent makes or tries a change.</Empty> : (
          <ul className="flex flex-col gap-2">{executions.map(e => <ResultItem key={e.id} e={e} />)}</ul>
        )}
      </Section>

      <Section id="runs" title="Runs">
        {runs.length === 0 ? <Empty title="Not run yet">{isActive ? 'Press Run now, or wait for its schedule.' : 'The agent runs once it is active.'}</Empty> : (
          <div className="table-wrap">
            <table className="dg-table">
              <caption className="sr-only">Runs of this agent</caption>
              <thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Status</th><th scope="col">Outcome</th><th scope="col">Version</th></tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmtTime(r.started_at)}</td>
                    <td>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                    <td><StatusBadge w={runWords(r.status)} /></td>
                    <td className="ink">{r.status_reason ? <span className="text-warn">{r.status_reason}</span> : countsInWords(r.counts)}</td>
                    <td>v{r.policy_version ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {policies.length > 1 && (
        <Section id="versions" title="Authorization versions">
          <ul className="flex flex-col gap-2">
            {policies.map(p => (
              <li key={p.id} className="rounded-[16px] border border-line p-3 text-[14px] text-grey">
                <span className="text-ink">Version {p.version}</span> · {VERSION_STATUS[p.status] ?? p.status} · created {fmtTime(p.created_at)} by {actorLabel(p.created_by)}
                {p.granted_at && <> · granted {fmtTime(p.granted_at)} by {actorLabel(p.granted_by)}</>}
                {p.revoked_at && <> · revoked {fmtTime(p.revoked_at)}{p.revoke_reason ? ` (${p.revoke_reason})` : ''}</>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Sheet open={dialog === 'pause'} onClose={() => setDialog(null)} title="Pause this agent?">
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-grey">While paused, the agent does not run and writes nothing. Changes waiting for approval or already queued are cancelled. Its authorization is kept, so you can resume it later without granting again.</p>
          <Button onClick={pause} disabled={busy !== null}>{busy === 'pause' ? 'Pausing…' : 'Pause agent'}</Button>
        </div>
      </Sheet>
      <Sheet open={dialog === 'revoke'} onClose={() => setDialog(null)} title="Revoke this authorization?">
        <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void revoke() }}>
          <p className="text-[15px] text-grey">The authorization ends now. The agent writes nothing more: changes waiting for approval and changes already queued are cancelled. Its history stays. To use it again you review and grant a new authorization.</p>
          <Field label="Reason (optional)" htmlFor="revoke-reason"><Textarea id="revoke-reason" rows={2} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <Button type="submit" variant="danger" disabled={busy !== null}>{busy === 'revoke' ? 'Revoking…' : 'Revoke authorization'}</Button>
        </form>
      </Sheet>
      <Sheet open={dialog === 'delete'} onClose={() => setDialog(null)} title="Delete this agent?">
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-grey">Deleting revokes its authorization, cancels anything waiting or queued, and removes the agent from your list. Changes it already made stay in your store, and its history stays in the audit trail.</p>
          <Button variant="danger" onClick={remove} disabled={busy !== null}>{busy === 'delete' ? 'Deleting…' : 'Delete agent'}</Button>
        </div>
      </Sheet>
    </>
  )
}

const VERSION_STATUS: Record<string, string> = { pending_grant: 'waiting for your grant', active: 'in force', superseded: 'replaced', revoked: 'revoked', discarded: 'discarded (edited before it was granted)' }

function ChangeBox({ field, from, to }: { field: string; from: unknown; to: unknown }) {
  const c = changeInWords({ field, from, to })
  return (
    <div className="rounded-[14px] border border-line bg-[#0A0A0A] p-3">
      <div className="text-[13px] text-grey-h">{c.label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[1.1rem] font-semibold text-ink break-all"><span>{c.from}</span><Icon name="arrow-right" size={16} /><span>{c.to}</span></div>
    </div>
  )
}

function WaitingItem({ wt, review, busy, onApprove, canAct }: { wt: AgentWaitingRow; review: boolean; busy: string | null; onApprove: () => void; canAct: boolean }) {
  const { base } = useStore()
  const why = wt.status_reason?.replace(/^waiting for your approval: /, '') || (review ? 'this agent is in review mode: you approve each change' : 'not covered by the standing authorization')
  const label = wt.target_label ?? 'this record'
  const expired = new Date(wt.expires_at).getTime() <= Date.now()
  return (
    <li>
      <Panel>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge w={proposalWords(wt.status)} /><SeverityBadge severity={wt.severity} /><span className="min-w-0 text-ink font-medium break-words">{label}</span></div>
        {wt.summary && <p className="pt-2 text-[15px] text-grey">{wt.summary}</p>}
        <div className="mt-3"><ChangeBox field={wt.change.field} from={wt.change.from} to={wt.change.to} /></div>
        <p className="pt-2 text-[14px] text-grey"><span className="text-grey-h">Why it waits: </span>{why}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onApprove} disabled={busy !== null || expired || !canAct} aria-label={`Approve change for ${label}`}>
            <Icon name="check" size={15} />{busy === `approve:${wt.id}` ? 'Running: re-read, write, verify…' : 'Approve'}
          </Button>
          <span className="text-[13px] text-grey-h">{expired ? 'Expired: run the agent again for a fresh proposal.' : `Expires ${fmtUntil(wt.expires_at)}`}</span>
          <Link href={`${base}/issues/${wt.issue_id}`} className="text-[13px] text-ink underline">Evidence</Link>
        </div>
        {!canAct && <p className="pt-2 text-[13px] text-grey-h">The agent is not active, so its changes cannot run.</p>}
      </Panel>
    </li>
  )
}

function ResultItem({ e }: { e: AgentExecutionRow }) {
  const w = executionWords(e.status)
  const byAgent = e.approver_kind === 'standing_authorization'
  const reasons = e.qualification?.reasons ?? []
  const facts: [ReactNode, ReactNode][] = [
    ['Change', `${fieldLabel(e.change.field)}: ${fmtValue(e.change.field, e.change.from)} → ${fmtValue(e.change.field, e.change.to)}`],
    ['Before → after', `${e.before_value === null || e.before_value === undefined ? 'not read' : fmtValue(e.change.field, e.before_value)} → ${e.after_value === null || e.after_value === undefined ? (e.status === 'verified' ? fmtValue(e.change.field, e.change.to) : 'not confirmed') : fmtValue(e.change.field, e.after_value)}`],
    ['Approved by', byAgent ? 'The agent, under its standing authorization' : `You (${actorLabel(e.approved_by)})`],
    ['Authorization', e.policy_version ? `version ${e.policy_version}` : '—'],
    ['When', `${fmtTime(e.started_at)}${e.verified_at ? ` · verified ${fmtTime(e.verified_at)}` : e.finished_at ? ` · finished ${fmtTime(e.finished_at)}` : ''}${e.attempt > 1 ? ` · attempt ${e.attempt}` : ''}`],
  ]
  return (
    <li className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge w={w} /><span className="min-w-0 text-ink text-[15px] break-words">{e.target_label ?? 'Record'}</span></div>
      <div className="mt-2 text-[14px]"><Facts items={facts} /></div>
      {e.status_reason && <p className="pt-2 text-[14px] text-grey-h break-words">{e.status_reason}</p>}
      {w.hint && e.status !== 'verified' && <p className="pt-1 text-[13px] text-grey-h">{w.hint}</p>}
      {reasons.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] text-ink">Why it qualified</summary>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-grey">{reasons.map(r => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
    </li>
  )
}

function NoticeView({ n }: { n: Notice }) {
  if (n.kind === 'done') return <Banner icon="check"><strong>Done.</strong> {n.message}</Banner>
  if (n.kind === 'error') return <Banner tone="warn"><strong>{n.what}.</strong> {n.e.message}</Banner>
  if (n.kind === 'edit') {
    const r = n.r
    return r.requiresGrant
      ? <Banner tone="warn"><strong>Saved as version {r.version}; it needs your grant.</strong> {r.expansion.length ? `It allows more than before: ${r.expansion.join(', ')}.` : ''} Review it under Authorization and grant it. Until then the current version keeps running unchanged.</Banner>
      : <Banner icon="check"><strong>Saved as version {r.version}; in force now.</strong> It allows nothing new, so no new grant was needed. Changes proposed under the old version are recomputed on the next run.</Banner>
  }
  if (n.kind === 'run') {
    const r = n.r
    if (r.status !== 'completed') return <Banner tone="warn"><strong>Run {runWords(r.status).label.toLowerCase()}.</strong> {r.reason ?? ''} Nothing was written.</Banner>
    return <Banner icon="check"><strong>Run finished.</strong> {countsInWords(r.counts)}.{r.counts.unconfirmed ? ' Unconfirmed changes are not counted as done until a fresh read shows them.' : ''}</Banner>
  }
  const r = n.r
  const reason = r.reason ? ` (${r.reason})` : ''
  const w = executionWords(r.status === 'not_approved' ? 'blocked' : r.status)
  if (r.status === 'verified') return <Banner icon="check"><strong>Verified: a fresh read shows the change on {n.target}.</strong>{r.duplicate ? ' This approval had already run; nothing was written twice.' : ''}</Banner>
  return <Banner tone="warn"><strong>{w.label}{reason}.</strong> {w.hint}</Banner>
}
