'use client'
/**
 * Create-agent wizard: name and plain-English task -> deterministic draft -> structured review form ->
 * server-side authorization summary -> explicit grant. Nothing is granted automatically.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { ErrorState, Loading, NoStore, Panel, Section, useStore } from './bits'
import { AgentPolicyForm, formFromDraft, policyFromForm, type AgentFormState } from './AgentForm'
import { AuthorizationSummaryView, BackToAgents, useStoreBasics } from './Agents'
import { AGENT_CORRECTION_LABEL, AGENT_EMAIL_PERMISSION_LABEL, AGENT_EMAIL_TASK_LABEL } from './format'
import type { CreateAgentResponse, EditAgentResponse, GrantResponse, ParseResponse, TaskDraft } from './types'

type Created = { agentId: string; policyId: string; policyHash: string; summary: CreateAgentResponse['summary'] }
type Step = 'describe' | 'review' | 'authorize' | 'granted'

export function AgentNewScreen() {
  const { base } = useStore()
  const basics = useStoreBasics()
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [form, setForm] = useState<AgentFormState | null>(null)
  const [step, setStep] = useState<Step>('describe')
  const [busy, setBusy] = useState<null | 'parse' | 'submit' | 'grant'>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [granted, setGranted] = useState<GrantResponse | null>(null)

  if (basics.loading && !basics.data) return <><BackToAgents /><PageHeader title="Create agent" /><Loading label="Loading" /></>
  if (basics.error && !basics.data) return <><BackToAgents /><PageHeader title="Create agent" /><ErrorState error={basics.error} onRetry={basics.reload} /></>
  const b = basics.data!
  if (!b.connections.length) return <><BackToAgents /><PageHeader title="Create agent" /><NoStore /></>
  const connectionId = b.connections[0].id

  async function parse() {
    setBusy('parse'); setErr(null)
    try {
      const r = await storeFetch<ParseResponse>('/api/store/agents', { method: 'POST', body: { op: 'parse', text: task } })
      setDraft(r.draft)
      setForm(formFromDraft(r.draft, form?.connectionId ?? connectionId))
      setShowProblems(false)
      setStep('review')
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  const check = form ? policyFromForm(form, b.timezone) : null

  async function submit() {
    if (!form || !check) return
    setShowProblems(true)
    if (!name.trim()) { setErr(null); return }
    if (!check.policy) return
    setBusy('submit'); setErr(null)
    try {
      if (created) {
        // the draft agent already exists: record the edited version on it instead of creating a second agent
        const r = await storeFetch<EditAgentResponse>(`/api/store/agents/${created.agentId}`, { method: 'PUT', body: { name: name.trim(), taskText: task, policy: check.policy } })
        setCreated({ agentId: created.agentId, policyId: r.policyId, policyHash: r.policyHash, summary: r.summary })
      } else {
        const r = await storeFetch<CreateAgentResponse>('/api/store/agents', { method: 'POST', body: { name: name.trim(), taskText: task, policy: check.policy } })
        setCreated({ agentId: r.agentId, policyId: r.policyId, policyHash: r.policyHash, summary: r.summary })
      }
      setStep('authorize')
      window.scrollTo?.({ top: 0 })
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  async function grant() {
    if (!created) return
    setBusy('grant'); setErr(null)
    try {
      const r = await storeFetch<GrantResponse>(`/api/store/agents/${created.agentId}/grant`, { method: 'POST', body: { policyId: created.policyId, policyHash: created.policyHash } })
      setGranted(r)
      setStep('granted')
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  return (
    <>
      <BackToAgents />
      <PageHeader title="Create agent" sub="Describe the task in your own words. Deploi turns it into a structured authorization you review and grant. The agent cannot change anything before you grant it." />
      <Steps step={step} />
      <div aria-live="polite">{err && <div className="mb-4"><ErrorState error={err} /></div>}</div>

      {(step === 'describe' || step === 'review') && (
        <Panel>
          <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); if (task.trim()) void parse() }}>
            <div className="flex flex-col gap-1">
              <label htmlFor="agent-name" className="text-[14px] text-grey">Agent name</label>
              <Input id="agent-name" value={name} maxLength={80} placeholder="e.g. Stock Guardian" onChange={e => setName(e.target.value)} />
              {showProblems && !name.trim() && <span className="text-[13px] text-warn">Give the agent a name.</span>}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="agent-task" className="text-[14px] text-grey">Task, in plain English</label>
              <Textarea id="agent-task" value={task} rows={4} maxLength={2000} placeholder="e.g. Every 6 hours, stop products from selling when they are out of stock, except anything tagged pre-order. Ask me before changing anything." onChange={e => setTask(e.target.value)} aria-describedby="agent-task-hint" />
              <span id="agent-task-hint" className="text-[13px] text-grey-h">Supported today on Shopify: overselling settings, product publication, prices (from your price list) and SKUs (from your mapping). Agents can also email run summaries, alerts and supplier restock requests from an account you connect.</span>
            </div>
            <div><Button type="submit" variant={step === 'describe' ? 'primary' : 'ghost'} size="sm" disabled={!task.trim() || busy !== null}><Icon name="spark" size={15} />{busy === 'parse' ? 'Drafting…' : step === 'review' ? 'Draft it again' : 'Draft it'}</Button></div>
          </form>
        </Panel>
      )}

      {step === 'review' && draft && form && (
        <>
          <DraftReport draft={draft} />
          <Section id="review" title="Review the structured task" sub="Everything below is editable. This, not the sentence above, is what the agent will be authorized to do.">
            <AgentPolicyForm value={form} onChange={setForm} connections={b.connections} timezone={b.timezone} showProblems={showProblems} />
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={busy !== null || (showProblems && (!check?.policy || !name.trim()))}>
                <Icon name="shield" size={16} />{busy === 'submit' ? 'Preparing…' : 'Review authorization'}
              </Button>
              {!check?.policy && <span className="text-[13px] text-grey-h">{check?.problems.length} choice{check?.problems.length === 1 ? '' : 's'} still needed</span>}
            </div>
          </Section>
        </>
      )}

      {step === 'authorize' && created && (
        <Section id="authorize" title="Review the authorization" sub={`Read exactly what "${name.trim()}" will be allowed to do. Nothing has been granted yet.`}>
          <Panel>
            <AuthorizationSummaryView summary={created.summary} />
            <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5">
              <p className="text-[14px] text-grey">Granting activates this exact version. Changing it later in a way that allows more (new corrections, fields, products, email recipients or permissions, higher limits or acting without asking) needs a new grant. You can pause or revoke it at any time; both stop all writes, including queued ones.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={grant} disabled={busy !== null}><Icon name="check" size={16} />{busy === 'grant' ? 'Granting…' : 'Grant this authorization'}</Button>
                <Button variant="ghost" onClick={() => { setStep('review'); setErr(null) }} disabled={busy !== null}>Back to edit</Button>
              </div>
              <p className="text-[13px] text-grey-h">Not ready? The agent is saved as a draft and does nothing until you grant it.</p>
            </div>
          </Panel>
        </Section>
      )}

      {step === 'granted' && created && granted && (
        <div className="mt-2 flex flex-col gap-3">
          <Banner icon="check"><strong>Authorization granted.</strong> &ldquo;{name.trim()}&rdquo; is active on version {granted.version}. {granted.nextRunAt ? 'It runs on its schedule; you can also run it now.' : 'It runs when you press Run now.'}</Banner>
          {granted.warnings.length > 0 && <Banner tone="warn"><strong>Check the overlap.</strong> {granted.warnings.join(' ')}</Banner>}
          <div><Button href={`${base}/agents/${created.agentId}`}>Open agent<Icon name="arrow-right" size={16} /></Button></div>
        </div>
      )}
    </>
  )
}

function Steps({ step }: { step: Step }) {
  const steps: [Step, string][] = [['describe', 'Describe'], ['review', 'Review'], ['authorize', 'Authorize'], ['granted', 'Active']]
  const at = steps.findIndex(s => s[0] === step)
  return (
    <ol className="mb-5 flex flex-wrap gap-2 text-[13px]" aria-label="Steps">
      {steps.map(([k, l], i) => (
        <li key={k} aria-current={i === at ? 'step' : undefined} className={`badge ${i === at ? '' : 'muted'}`}>{i + 1}. {l}</li>
      ))}
    </ol>
  )
}

/** What the draft understood, what is missing, and what Deploi cannot do. */
function DraftReport({ draft }: { draft: TaskDraft }) {
  const emailOnly = !draft.correctionTypes.length && Boolean(draft.email)
  const vague = (!draft.correctionTypes.length && !draft.email) || (!draft.productScope.mode && !emailOnly)
  return (
    <Section id="understood" title="What Deploi understood" sub="A suggestion from your words. It grants nothing; you confirm every choice below.">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel>
          <h3 className="text-[1rem]">Understood</h3>
          {draft.matched.length === 0 ? <p className="pt-2 text-[15px] text-grey">Nothing specific yet.</p> : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {draft.matched.map((m, i) => <li key={i} className="text-[15px] text-grey"><span className="text-ink">{m.phrase}</span> → {meaning(m.meaning)}</li>)}
            </ul>
          )}
        </Panel>
        <Panel tone={draft.missing.length ? 'warn' : undefined}>
          <h3 className="text-[1rem]">Still to choose</h3>
          {draft.missing.length === 0 ? <p className="pt-2 text-[15px] text-grey">Nothing missing.</p> : (
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">{draft.missing.map(m => <li key={m} className="text-[15px] text-grey">{m}</li>)}</ul>
          )}
        </Panel>
      </div>
      {vague && (
        <div className="mt-3"><Banner tone="warn"><strong>This task is too general to authorize as written.</strong> A broad instruction never grants open-ended access. Choose the corrections and products explicitly below.</Banner></div>
      )}
      {draft.unsupported.length > 0 && (
        <div className="mt-3">
          <Panel tone="danger">
            <h3 className="text-[1rem]">Deploi can&apos;t do this</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">{draft.unsupported.map(u => <li key={u} className="text-[15px] text-grey">{u}</li>)}</ul>
            <p className="pt-2 text-[13px] text-grey-h">These parts of the task are left out. The agent will not attempt them.</p>
          </Panel>
        </div>
      )}
      {draft.correctionTypes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">{draft.correctionTypes.map(t => <Badge key={t} tone="muted">{AGENT_CORRECTION_LABEL[t] ?? t}</Badge>)}</div>
      )}
      {draft.email && (
        <div className="mt-3">
          <Panel>
            <h3 className="text-[1rem]">Email</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[15px] text-grey">
              {draft.email.tasks.map(t => <li key={t}>{AGENT_EMAIL_TASK_LABEL[t] ?? t}</li>)}
              <li>{draft.email.permission ? AGENT_EMAIL_PERMISSION_LABEL[draft.email.permission] : 'Permission level: still to choose'}</li>
            </ul>
            {draft.email.addresses.length > 0 && (
              <p className="pt-2 text-[14px] text-grey"><Badge tone="warn">found in your text: confirm</Badge> {draft.email.addresses.join(', ')}. Confirm these below before the agent may write to them.</p>
            )}
            <p className="pt-2 text-[13px] text-grey-h">Nothing here is granted. You choose the account, recipients and limits below.</p>
          </Panel>
        </div>
      )}
    </Section>
  )
}

function meaning(m: string): string {
  const c = /^correction: (.+)$/.exec(m)
  if (c) return `corrects ${(AGENT_CORRECTION_LABEL[c[1]] ?? c[1]).toLowerCase()}`
  const e = /^email tasks?: (.+)$/.exec(m)
  if (e) return `email: ${e[1].split(/,\s*/).map(t => (AGENT_EMAIL_TASK_LABEL as Record<string, string>)[t]?.toLowerCase() ?? t).join('; ')}`
  return m
}
