'use client'
/**
 * Settings → How your agents act: per action type, "Do it and tell me" (the agent acts, checks its work and tells
 * you after, with an undo link where it can be undone) or "Ask me first" (it prepares the exact action and waits
 * for your approval). Money actions are listed on their own. Owners and admins change it; everyone else sees it.
 * The server checks the role and audits every change (/api/store/autonomy).
 */
import { useState } from 'react'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { Chips, ErrorState, Loading } from '@/components/store/bits'

type Mode = 'act_and_tell' | 'ask_first'
type Row = { key: string; label: string; money: boolean; mode: Mode; custom: boolean; updatedBy: string | null; updatedAt: string | null }
type View = { actions: Row[]; money: Row[]; canChange: boolean; defaultMode: Mode }

export const AUTONOMY_API = '/api/store/autonomy'
const OPTIONS: [Mode, string][] = [['act_and_tell', 'Do it and tell me'], ['ask_first', 'Ask me first']]

function List({ rows, canChange, busy, onSet }: { rows: Row[]; canChange: boolean; busy: string | null; onSet: (key: string, mode: Mode) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map(r => (
        <li key={r.key} className="panel flex flex-col gap-2 p-4 md:flex-row md:items-center md:justify-between" data-action={r.key} data-mode={r.mode}>
          <div className="min-w-0">
            <div className="font-semibold text-ink">{r.label}</div>
            <p className="pt-1 text-[13px] text-grey-h">{r.mode === 'act_and_tell' ? 'Your agent does it, checks it worked and tells you.' : 'Your agent prepares it and waits for your yes.'}{r.custom && r.updatedBy ? ` Set by ${r.updatedBy.replace(/^user:/, '')}.` : ''}</p>
          </div>
          {canChange
            ? <div aria-busy={busy === r.key}><Chips value={r.mode} options={OPTIONS} label={`How your agents ${r.label.toLowerCase()}`} onChange={m => { if (m !== r.mode && !busy) onSet(r.key, m) }} /></div>
            : <Badge tone="muted">{OPTIONS.find(o => o[0] === r.mode)![1]}</Badge>}
        </li>
      ))}
    </ul>
  )
}

export function AgentModesPanel() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<View & { ok: true }>(AUTONOMY_API), 'autonomy')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  if (loading && !data) return <Loading label="Loading how your agents act" rows={3} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (!data) return null
  const set = async (actionType: string, mode: Mode) => {
    setBusy(actionType); setNote(null)
    try { await storeFetch(AUTONOMY_API, { method: 'POST', body: { actionType, mode } }); await reload() } catch (e) { setNote(asApiError(e).message) } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="agent-modes">
      <div aria-live="polite">{note && <Banner tone="warn">{note}</Banner>}</div>
      {!data.canChange && <p className="text-[14px] text-grey">Only an owner or admin can change these.</p>}
      <List rows={data.actions} canChange={data.canChange} busy={busy} onSet={set} />
      <div>
        <div className="font-semibold text-ink">Money</div>
        <p className="pt-1 pb-2 text-[14px] text-grey">Refunds, discounts, disputes, invoices and credit notes. Your limits on amounts and how many per day apply either way.</p>
        <List rows={data.money} canChange={data.canChange} busy={busy} onSet={set} />
      </div>
    </div>
  )
}
