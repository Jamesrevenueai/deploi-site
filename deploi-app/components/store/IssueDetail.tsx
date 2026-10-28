'use client'
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { Field, Textarea } from '@/components/ui/Field'
import { EXECUTION_STATUS_LABEL, OUTCOME_LABEL, PROPOSAL_STATUS_LABEL } from '@/lib/engine/outcomes'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, OutcomeBadge, Panel, Section, SeverityBadge, useStore } from './bits'
import {
  INVENTORY_POLICY_WORDS, ISSUE_STATUS_LABEL, PRODUCT_STATUS_LABEL, RESOLUTION_LABEL,
  actorLabel, changeInWords, eventLabel, fieldLabel, fmtTime, fmtUntil, fmtValue, shortId,
} from './format'
import type { ExecutionResult, ExecutionView, IssueDetailResponse, ProposalView } from './types'

type Level = { location?: string; locationId?: string; available?: number | null; onHand?: number | null; committed?: number | null }
type Busy = null | 'approve' | 'retry' | 'exempt' | 'dismiss' | 'repropose'
type Notice =
  | { kind: 'result'; r: ExecutionResult }
  | { kind: 'conflict'; title: string; message: string }
  | { kind: 'error'; e: StoreApiError }
  | { kind: 'done'; message: string }

const CONFLICT: Record<string, string> = {
  expired: 'This proposal expired before it was approved. Run a new scan for a fresh proposal.',
  hash_mismatch: 'The proposal changed after this page loaded. The current proposal is shown below; review it and approve again.',
  rule_changed: 'Your rule changed after this proposal was made. Run a new scan to get a proposal under the current rule.',
  not_pending: 'This proposal is no longer waiting for approval. Its current state is shown below.',
  not_retryable: 'This run cannot be retried: only failed or unconfirmed runs with a valid approval can be retried.',
}

const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : v === null || v === undefined ? '—' : String(v))

export function IssueDetailScreen({ id }: { id: string }) {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<IssueDetailResponse>(`/api/store/issues/${encodeURIComponent(id)}`), id)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ackOpen, setAckOpen] = useState(false)
  const [note, setNote] = useState('')

  if (loading && !data) return <><BackLink /><Loading label="Loading issue" rows={4} /></>
  if (error && !data) {
    if (error.status === 404 || error.code === 'not_found') {
      return (
        <>
          <BackLink />
          <Empty title="Issue not found">This issue does not exist or belongs to another store. <Link href={`${base}/issues`}><span className="underline text-ink">Back to issues</span></Link></Empty>
        </>
      )
    }
    return <><BackLink /><ErrorState error={error} onRetry={reload} /></>
  }
  if (!data) return null

  const { issue, check, proposals, executions, trail, canApprove } = data
  const ev = issue.evidence as Record<string, unknown>
  const live = issue.status === 'open' || issue.status === 'needs_review'
  const proposal = issue.proposal
  const pending = proposal && proposal.status === 'pending_approval' && live
  const expired = proposal ? new Date(proposal.expires_at).getTime() <= Date.now() : false
  const latestExec = proposal ? executions.find(e => e.proposal_id === proposal.id) : undefined
  const retryable = latestExec && ['failed', 'verification_failed', 'unknown'].includes(latestExec.status)

  async function act(kind: Exclude<Busy, null>, run: () => Promise<Notice | null>) {
    setBusy(kind)
    setNotice(null)
    try {
      const n = await run()
      setNotice(n)
    } catch (e) {
      const err = asApiError(e)
      if (err.status === 409 && CONFLICT[err.code]) setNotice({ kind: 'conflict', title: err.code === 'not_retryable' ? 'Not retried' : 'Not approved', message: `${CONFLICT[err.code]} (${err.message})` })
      else setNotice({ kind: 'error', e: err })
    } finally {
      setBusy(null)
      await reload()
    }
  }

  const approve = () => proposal && act('approve', async () => ({ kind: 'result', r: await storeFetch<ExecutionResult>(`/api/store/proposals/${proposal.id}/approve`, { method: 'POST', body: { changeHash: proposal.change_hash } }) }))
  const retry = (executionId: string) => act('retry', async () => ({ kind: 'result', r: await storeFetch<ExecutionResult>(`/api/store/executions/${executionId}/retry`, { method: 'POST', body: {} }) }))
  const exempt = () => act('exempt', async () => { await storeFetch(`/api/store/issues/${issue.id}/exempt`, { method: 'POST', body: {} }); return { kind: 'done', message: 'Product exempted. Deploi will not flag it under this check again; you can see the exempt count on the Rules page.' } })
  const dismiss = () => act('dismiss', async () => { await storeFetch(`/api/store/issues/${issue.id}/dismiss`, { method: 'POST', body: { note } }); setAckOpen(false); setNote(''); return { kind: 'done', message: 'Acknowledged. The issue stays closed unless the problem goes away and comes back.' } })
  const repropose = () => act('repropose', async () => { await storeFetch(`/api/store/issues/${issue.id}/repropose`, { method: 'POST', body: {} }); return { kind: 'done', message: 'Deploi re-read the variant. If the problem is still there, a new proposal is waiting for your approval below.' } })

  const levels = Array.isArray(ev.levels) ? (ev.levels as Level[]) : []
  const tags = Array.isArray(ev.productTags) ? (ev.productTags as unknown[]).map(String) : []
  const ruleEv = (ev.rule ?? null) as { exemptTags?: string[]; exemptProductCount?: number } | null
  const humanAction = typeof ev.humanAction === 'string' && ev.humanAction ? ev.humanAction : null
  const summary = typeof ev.summary === 'string' ? ev.summary : null

  return (
    <>
      <BackLink />
      <PageHeader eyebrow={issue.resource_label ?? shortId(issue.resource_id)} title={check?.title ?? issue.check_title} sub={summary ?? undefined} />
      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} />
        <Badge tone={issue.status === 'needs_review' ? 'warn' : live ? 'none' : 'muted'}>{ISSUE_STATUS_LABEL[issue.status] ?? issue.status}</Badge>
        {issue.kind === 'needs_person' ? <Badge tone="muted">Needs a person</Badge> : <Badge tone="muted">Correctable</Badge>}
        {!live && issue.resolution && <span className="text-[13px] text-grey-h">{RESOLUTION_LABEL[issue.resolution] ?? issue.resolution} · {fmtTime(issue.resolved_at)}</span>}
        <span className="text-[13px] text-grey-h">First seen {fmtTime(issue.first_detected_at)} · last seen {fmtTime(issue.last_seen_at)}</span>
      </div>

      <div aria-live="polite" className="flex flex-col gap-3">
        {notice && <NoticeBanner n={notice} onRetry={retry} busy={busy !== null} canApprove={canApprove} />}
        {error && <ErrorState error={error} onRetry={reload} />}
      </div>
      {!canApprove && <div className="mt-3"><Banner tone="warn"><strong>Read-only.</strong> Deploi staff can view this issue but cannot approve, retry or change anything.</Banner></div>}

      {issue.status === 'needs_review' && (
        <div className="mt-4">
          <Panel tone="warn">
            <div className="flex items-start gap-3">
              <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
              <div className="min-w-0">
                <div className="text-ink font-medium">The setting was changed back after Deploi fixed it</div>
                <p className="pt-1 text-[15px] text-grey">Deploi made this change and a fresh read confirmed it, then someone (you, a staff member or another app) changed it back. Deploi will not propose it again on its own so it does not fight that change. If the change back was a mistake, ask Deploi to propose again.</p>
                <Button className="mt-3" size="sm" variant="ghost" onClick={repropose} disabled={!canApprove || busy !== null}><Icon name="bolt" size={15} />{busy === 'repropose' ? 'Re-reading…' : 'Propose again'}</Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {humanAction && live && (
        <div className="mt-4"><Banner tone="warn" icon="users"><strong>What a person needs to do.</strong> {humanAction}</Banner></div>
      )}

      {proposal && (
        <Section id="proposal" title={pending ? 'Proposed change' : 'Latest proposal'} sub={pending ? 'Approve this exact change and Deploi makes it, then confirms it with a fresh read.' : undefined}>
          <ProposalCard p={proposal} pending={Boolean(pending)} expired={expired}>
            {pending && (
              <div className="mt-5 flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={approve} disabled={!canApprove || busy !== null || expired} aria-label={`Approve this change for ${proposal.target_label ?? 'this variant'}`}>
                    <Icon name="check" size={17} />{busy === 'approve' ? 'Running: re-read, write, verify…' : 'Approve this change'}
                  </Button>
                </div>
                {expired && <p className="text-[13px] text-warn">This proposal has expired. Run a new scan for a fresh one.</p>}
                {!canApprove && <p className="text-[13px] text-grey-h">Only the store&apos;s own users can approve.</p>}
              </div>
            )}
            {!pending && retryable && latestExec && !(notice?.kind === 'result' && notice.r.executionId === latestExec.id) && (
              <div className="mt-5">
                <Button variant="ghost" size="sm" onClick={() => retry(latestExec.id)} disabled={!canApprove || busy !== null} aria-label="Retry this change">
                  <Icon name="bolt" size={15} />{busy === 'retry' ? 'Retrying…' : `Retry (attempt ${latestExec.attempt + 1})`}
                </Button>
                <p className="pt-2 text-[13px] text-grey-h">A retry uses the same approval and re-reads the variant first; it never writes twice or over someone else&apos;s change.</p>
              </div>
            )}
          </ProposalCard>
        </Section>
      )}
      {!proposal && issue.kind === 'correctable' && live && issue.status === 'open' && (
        <Section title="Proposed change"><Empty title="No proposal yet">Run a scan to create a proposal for this issue.</Empty></Section>
      )}

      <Section id="why" title="Why this is flagged">
        <Panel>
          {check ? (
            <div className="flex flex-col gap-3 text-[15px]">
              <p className="text-ink">{check.description}</p>
              <p className="text-grey">{check.whyItIsAnError}</p>
            </div>
          ) : <p className="text-grey">This check is no longer available.</p>}
          <div className="mt-4">
            <Facts items={[
              ['Rule version', issue.rule_version ?? '—'],
              ...(ruleEv?.exemptTags ? [['Exempt tags', ruleEv.exemptTags.length ? <TagList tags={ruleEv.exemptTags} /> : 'none'] as [string, ReactNode]] : []),
              ...(typeof ruleEv?.exemptProductCount === 'number' ? [['Exempt products', ruleEv.exemptProductCount] as [string, ReactNode]] : []),
            ]} />
          </div>
        </Panel>
      </Section>

      <Section id="evidence" title="Evidence" sub={typeof ev.fetchedAt === 'string' ? `Read from the store ${fmtTime(ev.fetchedAt)}` : undefined}>
        {levels.length > 0 && (
          <div className="table-wrap mb-4">
            <table className="dg-table">
              <caption className="sr-only">Stock by location</caption>
              <thead><tr><th scope="col">Location</th><th scope="col" style={{ textAlign: 'right' }}>Available</th><th scope="col" style={{ textAlign: 'right' }}>On hand</th><th scope="col" style={{ textAlign: 'right' }}>Committed</th></tr></thead>
              <tbody>
                {levels.map((l, i) => (
                  <tr key={l.locationId ?? i}>
                    <td className="ink">{l.location ?? 'Location'}</td>
                    <td className={`text-right ${typeof l.available === 'number' && l.available < 0 ? 'text-danger' : 'text-ink'}`}>{num(l.available)}</td>
                    <td className="text-right">{num(l.onHand)}</td>
                    <td className="text-right">{num(l.committed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Panel>
          <Facts items={[
            ['Total available', <span key="t" className={typeof ev.totalAvailable === 'number' && ev.totalAvailable < 0 ? 'text-danger' : ''}>{num(ev.totalAvailable)}</span>],
            ...(typeof ev.oversoldUnits === 'number' && ev.oversoldUnits > 0 ? [['Oversold units', ev.oversoldUnits] as [string, ReactNode]] : []),
            ...(typeof ev.shortUnits === 'number' ? [['Short by', `${ev.shortUnits} unit${ev.shortUnits === 1 ? '' : 's'}`] as [string, ReactNode]] : []),
            ['Inventory policy', typeof ev.inventoryPolicy === 'string' ? INVENTORY_POLICY_WORDS[ev.inventoryPolicy] ?? ev.inventoryPolicy : '—'],
            ['Inventory tracked', typeof ev.tracked === 'boolean' ? (ev.tracked ? 'Yes' : 'No') : '—'],
            ['Product status', typeof ev.productStatus === 'string' ? PRODUCT_STATUS_LABEL[ev.productStatus] ?? ev.productStatus : '—'],
            ['Tags', tags.length ? <TagList tags={tags} /> : 'none'],
            ...(typeof ev.sellingPlanGroupsCount === 'number' ? [['Selling plans', ev.sellingPlanGroupsCount === 0 ? 'none' : String(ev.sellingPlanGroupsCount)] as [string, ReactNode]] : []),
            ...(typeof ev.sku === 'string' && ev.sku ? [['SKU', ev.sku] as [string, ReactNode]] : []),
            ['Read at', typeof ev.fetchedAt === 'string' ? fmtTime(ev.fetchedAt) : '—'],
          ]} />
          {ev.levelsComplete === false && <p className="pt-3 text-[13px] text-warn">Some locations could not be read; totals may be incomplete.</p>}
        </Panel>
      </Section>

      {live && (
        <Section id="other" title="Other options">
          <div className="flex flex-wrap gap-2">
            {issue.kind === 'correctable' && (
              <Button variant="ghost" size="sm" onClick={exempt} disabled={!canApprove || busy !== null} aria-label="Exempt this product from this check">
                <Icon name="shield" size={15} />{busy === 'exempt' ? 'Exempting…' : 'Exempt this product'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setAckOpen(true)} disabled={!canApprove || busy !== null} aria-label="Acknowledge this issue">
              <Icon name="check" size={15} />Acknowledge
            </Button>
          </div>
          <p className="pt-2 text-[13px] text-grey-h">
            {issue.kind === 'correctable' ? 'Exempting records the product in your rule so Deploi stops flagging it. ' : ''}Acknowledging closes the issue without changing the store; it reopens only if the problem goes away and comes back.
          </p>
        </Section>
      )}

      <Section id="history" title="History">
        <h3 className="pb-2 text-[1rem]">Proposals</h3>
        {proposals.length === 0 ? <p className="text-[15px] text-grey">No proposals.</p> : (
          <ul className="flex flex-col gap-2">
            {proposals.map(p => {
              const c = changeInWords(p.change)
              return (
                <li key={p.id} className="rounded-[16px] border border-line p-3 md:p-4">
                  <div className="flex flex-wrap items-center gap-2"><OutcomeBadge outcome={p.outcome} /><span className="text-ink text-[15px]">{PROPOSAL_STATUS_LABEL[p.status] ?? p.status}</span><span className="text-[13px] text-grey-h">{fmtTime(p.created_at)}</span></div>
                  <div className="mt-1 text-[14px] text-grey break-words">{c.label}: {c.from} → {c.to} · rule v{p.rule_version ?? '—'} · <span className="font-mono">{p.change_hash.slice(0, 8)}</span></div>
                  {p.status_reason && <div className="mt-1 text-[14px] text-grey-h break-words">{p.status_reason}</div>}
                </li>
              )
            })}
          </ul>
        )}

        <h3 className="pb-2 pt-6 text-[1rem]">Runs</h3>
        {executions.length === 0 ? <p className="text-[15px] text-grey">Nothing has been run for this issue.</p> : (
          <ul className="flex flex-col gap-2">
            {executions.map(e => <ExecutionItem key={e.id} e={e} />)}
          </ul>
        )}

        <h3 className="pb-2 pt-6 text-[1rem]">Audit trail</h3>
        {trail.length === 0 ? <p className="text-[15px] text-grey">No events.</p> : (
          <ol className="rounded-[16px] border border-line" aria-label="Audit trail">
            {trail.map(t => (
              <li key={t.id} className="flex flex-col gap-0.5 border-b border-line px-3 py-2.5 last:border-b-0 md:flex-row md:items-baseline md:gap-4 md:px-4">
                <span className="text-[13px] text-grey-h md:w-[130px] md:shrink-0 whitespace-nowrap">{fmtTime(t.at)}</span>
                <span className="min-w-0 flex-1 text-[15px] text-ink">{eventLabel(t.event)}{typeof t.detail?.reason === 'string' && t.detail.reason ? <span className="block text-[13px] text-grey-h">{t.detail.reason}</span> : null}</span>
                <span className="min-w-0 text-[13px] text-grey break-words md:max-w-[38%] md:text-right">{actorLabel(t.actor)}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Sheet open={ackOpen} onClose={() => setAckOpen(false)} title="Acknowledge this issue">
        <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void dismiss() }}>
          <p className="text-[15px] text-grey">Nothing in the store changes. The issue closes and stays closed unless the problem goes away and comes back.</p>
          <Field label="Note (optional)" htmlFor="ack-note" hint="For example: we are fulfilling these orders from a supplier.">
            <Textarea id="ack-note" value={note} maxLength={500} rows={3} onChange={e => setNote(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy !== null}>{busy === 'dismiss' ? 'Saving…' : 'Acknowledge'}</Button>
        </form>
      </Sheet>
    </>
  )
}

function BackLink() {
  const { base } = useStore()
  return <Link href={`${base}/issues`} className="mb-4 inline-flex items-center gap-1 text-[14px]"><span className="inline-flex items-center gap-1 text-grey hover:text-ink"><Icon name="arrow-right" size={14} style={{ transform: 'rotate(180deg)' }} />All issues</span></Link>
}

function TagList({ tags }: { tags: string[] }) {
  return <span className="inline-flex flex-wrap gap-1.5">{tags.map(t => <Badge key={t} tone="muted">{t}</Badge>)}</span>
}

function ProposalCard({ p, pending, expired, children }: { p: ProposalView; pending: boolean; expired: boolean; children?: ReactNode }) {
  const c = changeInWords(p.change)
  return (
    <div className={`rounded-[20px] border p-4 md:p-6 ${pending ? 'border-white/40' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={p.outcome} />
        {(PROPOSAL_STATUS_LABEL[p.status] ?? p.status) !== OUTCOME_LABEL[p.outcome] && <span className="text-[14px] text-grey">{PROPOSAL_STATUS_LABEL[p.status] ?? p.status}</span>}
      </div>
      <div className="mt-3 text-[14px] text-grey-h">Change on</div>
      <div className="text-ink font-medium break-words">{p.target_label ?? shortId(p.target_id)}</div>
      <div className="mt-3 rounded-[14px] border border-line bg-[#0A0A0A] p-3 md:p-4">
        <div className="text-[14px] text-grey-h">{c.label}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[1.25rem] font-semibold text-ink">
          <span>{c.from}</span><Icon name="arrow-right" size={18} aria-hidden="true" /><span>{c.to}</span>
        </div>
        <div className="mt-1 text-[12px] text-grey-h break-all">Shopify field <span className="font-mono">{p.change.field}</span>: {String(p.change.from)} → {String(p.change.to)}</div>
      </div>
      {p.preconditions.length > 0 && (
        <div className="mt-4">
          <div className="text-[14px] text-ink">Deploi re-reads the variant before writing and stops if any of these changed:</div>
          <ul className="mt-2 flex flex-col gap-1 text-[14px] text-grey">
            {p.preconditions.map(pc => <li key={pc.path} className="flex gap-2"><Icon name="check" size={14} className="mt-1 shrink-0 text-grey-h" /><span>{pc.description}</span></li>)}
          </ul>
        </div>
      )}
      <div className="mt-4 grid grid-cols-1 gap-1 text-[13px] text-grey-h sm:grid-cols-2">
        <span>{pending ? <>Expires {expired ? <span className="text-warn">{fmtUntil(p.expires_at)}</span> : fmtUntil(p.expires_at)}</> : <>Proposed {fmtTime(p.created_at)}</>}</span>
        <span>Change fingerprint <span className="font-mono text-grey">{p.change_hash.slice(0, 8)}</span> · rule v{p.rule_version ?? '—'}</span>
      </div>
      {p.status_reason && !pending && <p className="pt-2 text-[14px] text-grey break-words">{p.status_reason}</p>}
      {children}
    </div>
  )
}

function observedLine(field: string, label: string, v: unknown) {
  return `${label}: ${fmtValue(field, v)}`
}

function ExecutionItem({ e }: { e: ExecutionView }) {
  const pre = e.precheck as { field?: string; current?: unknown; fetchedAt?: string; failed?: { path: string; expected: unknown; actual: unknown; description: string }[]; error?: string; found?: boolean } | null
  const ver = e.verification as { field?: string; expected?: unknown; observed?: unknown; readAt?: string | null } | null
  const field = pre?.field ?? ver?.field ?? e.change.field
  return (
    <li className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={e.outcome} />
        <span className="text-ink text-[15px]">{EXECUTION_STATUS_LABEL[e.status] ?? e.status}</span>
        <span className="text-[13px] text-grey-h">attempt {e.attempt}</span>
        {e.is_synthetic && <Badge tone="warn">Synthetic test store</Badge>}
      </div>
      <div className="mt-2 flex flex-col gap-1 text-[14px] text-grey">
        <span>Approved by {actorLabel(e.approved_by)} · {fmtTime(e.approved_at)}</span>
        {pre && (pre.error ? <span>Before writing: {pre.error}</span>
          : pre.found === false ? <span>Before writing: the variant no longer exists</span>
          : <span>Before writing ({fmtTime(pre.fetchedAt)}): {observedLine(field, fieldLabel(field), pre.current)}{pre.failed?.length ? ` · changed: ${pre.failed.map(f => f.description).join('; ')}` : ''}</span>)}
        {ver && <span>After writing ({fmtTime(ver.readAt ?? null)}): expected {fmtValue(field, ver.expected)}, fresh read shows {fmtValue(field, ver.observed)}</span>}
        {e.status_reason && <span className="text-grey-h break-words">{e.status_reason}</span>}
        <span className="text-[13px] text-grey-h">Started {fmtTime(e.started_at)}{e.finished_at ? ` · finished ${fmtTime(e.finished_at)}` : ''}</span>
      </div>
    </li>
  )
}

function NoticeBanner({ n, onRetry, busy, canApprove }: { n: Notice; onRetry: (executionId: string) => void; busy: boolean; canApprove: boolean }) {
  if (n.kind === 'done') return <Banner icon="check"><strong>Done.</strong> {n.message}</Banner>
  if (n.kind === 'error') return <ErrorState error={n.e} />
  if (n.kind === 'conflict') return <Banner tone="warn"><strong>{n.title}.</strong> {n.message}</Banner>
  const r = n.r
  const reason = r.reason ? ` (${r.reason})` : ''
  switch (r.status) {
    case 'verified':
      return <Banner icon="check"><strong>Verified: a fresh read shows the change.</strong>{r.duplicate ? ' This approval had already run; nothing was written twice.' : ''}</Banner>
    case 'stale':
      return <Banner tone="warn"><strong>Not run: the store changed since this proposal{reason}.</strong> Nothing was written.</Banner>
    case 'blocked':
      return <Banner tone="warn"><strong>Blocked{reason}.</strong> Nothing was written.</Banner>
    case 'failed':
    case 'verification_failed':
      return (
        <div className="flex flex-col gap-2">
          <Banner tone="warn"><strong>Failed{r.status === 'verification_failed' ? ': a fresh read does not show the change' : ''}{reason}.</strong> The issue is still open.</Banner>
          {r.executionId && <div><Button variant="ghost" size="sm" disabled={busy || !canApprove} onClick={() => onRetry(r.executionId!)} aria-label="Retry this change"><Icon name="bolt" size={15} />Retry</Button></div>}
        </div>
      )
    case 'not_approved':
      return <Banner tone="warn"><strong>Not run{reason}.</strong></Banner>
    default:
      return (
        <div className="flex flex-col gap-2">
          <Banner icon="clock"><strong>Pending: {EXECUTION_STATUS_LABEL[r.status] ?? r.status}.</strong> Deploi has no definite answer yet. Do not count this as done until it shows Verified.</Banner>
          {r.status === 'unknown' && r.executionId && <div><Button variant="ghost" size="sm" disabled={busy || !canApprove} onClick={() => onRetry(r.executionId!)} aria-label="Retry this change"><Icon name="bolt" size={15} />Retry</Button></div>}
        </div>
      )
  }
}
