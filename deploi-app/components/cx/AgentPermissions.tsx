'use client'
/** Agent configuration helpers: the permissions an agent holds at a glance, and what an edit would change. */
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Panel } from '@/components/store/bits'
import { fmtTime } from '@/components/store/format'
import type { AgentPolicy } from '@/components/store/types'
import { TIER_WORDS, type Tier } from './types'
import { describePolicyChange, needsNewGrant } from './policyDiff'

const modeTier = (m: string | undefined): Tier => (m === 'review' ? 'send_approved' : m === 'autonomous' ? 'send_autonomous' : 'draft')

/** One row per tool: its tier, its end date, and what it covers. */
export function PermissionsAtAGlance({ policy, version, granted }: { policy: AgentPolicy; version: number | null; granted: boolean }) {
  const store = modeTier(policy.approvalMode)
  const scope = policy.productScope.mode === 'all' ? 'Every product' : policy.productScope.mode === 'products' ? `${policy.productScope.productIds.length} selected product${policy.productScope.productIds.length === 1 ? '' : 's'}` : `Tagged ${policy.productScope.tags.map(t => `"${t}"`).join(', ')}`
  const except = [...policy.exceptions.tags.map(t => `"${t}"`), ...(policy.exceptions.productIds.length ? [`${policy.exceptions.productIds.length} product(s)`] : [])]
  const e = policy.email
  const rows: { tool: string; tier: Tier | null; until: string | null; covers: string[] }[] = [
    { tool: 'Store', tier: policy.correctionTypes.length || policy.watch.length ? store : null, until: store === 'send_autonomous' ? policy.validUntil : null,
      covers: [scope, ...(except.length ? [`except ${except.join(', ')}`] : []), `at most ${policy.limits.maxChangesPerRun} changes a run, ${policy.limits.maxChangesPerDay} a day`] },
    ...(e ? [{ tool: 'Email', tier: e.permission as Tier, until: e.permission === 'send_autonomous' ? e.validUntil : null,
      covers: [`to ${[...e.recipients.addresses, ...e.recipients.domains.map(d => `anyone at ${d}`)].join(', ') || 'nobody yet'}`, `at most ${e.limits.perRun} a run, ${e.limits.perDay} a day`, ...(e.read.enabled ? ['notices replies to its own messages'] : [])] }] : []),
    ...(policy.competitors ? [{ tool: 'Competitor pages', tier: null, until: null, covers: [`reads ${policy.competitors.stores.length} public store${policy.competitors.stores.length === 1 ? '' : 's'}; never your store`] }] : []),
  ]
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[1.05rem]">Permissions at a glance</h3>
        <span className="text-[13px] text-grey-h">{version ? `Version ${version}${granted ? '' : ' (not granted yet)'}` : 'Not granted'}</span>
      </div>
      <div className="table-wrap mt-3">
        <table className="dg-table" data-testid="permissions-glance">
          <caption className="sr-only">What each tool may do</caption>
          <thead><tr><th scope="col">Tool</th><th scope="col">Level</th><th scope="col">Ends</th><th scope="col">Covers</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.tool}>
                <th scope="row" className="ink">{r.tool}</th>
                <td>{r.tier ? <Badge tone={r.tier === 'draft' ? 'muted' : r.tier === 'send_approved' ? 'none' : 'warn'}>{TIER_WORDS[r.tier]}</Badge> : <span className="text-grey-h">Read only</span>}</td>
                <td className="whitespace-nowrap">{r.until ? fmtTime(r.until) : r.tier === 'send_autonomous' ? 'Required' : '—'}</td>
                <td>{r.covers.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pt-3 text-[13px] text-grey-h">Raising a level, adding products, recipients or tasks, or ending later needs a new grant. Lowering any of them takes effect at once. <a href="#worklog" className="text-ink underline">Work log</a></p>
    </Panel>
  )
}

/** Shown while editing: what the edit changes, and whether it will need a new grant. */
export function EditPreview({ current, next }: { current: AgentPolicy | null; next: AgentPolicy | null }) {
  if (!next) return null
  const changes = describePolicyChange(current, next)
  const grant = needsNewGrant(changes)
  return (
    <div className={`rounded-[20px] border p-4 ${grant ? 'border-warn-line' : 'border-line'}`} aria-live="polite" data-testid="edit-preview" data-needs-grant={grant}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name={grant ? 'alert' : 'check'} size={16} />
        <span className="font-medium text-ink">{grant ? 'This needs a new grant' : 'Takes effect when you save'}</span>
      </div>
      <ul className="mt-2 flex flex-col gap-1 text-[14px]">
        {changes.map(c => <li key={c.text} className={c.kind === 'wider' ? 'text-warn' : 'text-grey'}><span className="sr-only">{c.kind === 'wider' ? 'Allows more: ' : c.kind === 'narrower' ? 'Allows less: ' : ''}</span>{c.kind === 'wider' ? '+ ' : c.kind === 'narrower' ? '− ' : ''}{c.text}</li>)}
      </ul>
      <p className="pt-2 text-[13px] text-grey-h">{grant ? 'The current version keeps running unchanged until you grant the new one.' : 'Deploi checks this again when you save.'}</p>
    </div>
  )
}
