import Link from 'next/link'
import type { Session } from '@/lib/session'
import { withUser } from '@/lib/db'
import { requestIp } from '@/lib/auth'
import { listExceptions, billingHold, exceptionCounts } from '@/lib/evv/queries'
import { RULE_LABELS, type ExceptionRule } from '@/lib/evv/types'
import { daysLeft, windowTone, windowLabel } from '@/lib/evv/window'
import { Empty } from '@/components/ui/Empty'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { ExceptionTable } from './ExceptionTable'
import { correctAction, dismissAction, reopenAction } from '@/app/staff/evv/actions'

export type Tab = 'open' | 'corrected' | 'hold'
const TABS: { key: Tab; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'corrected', label: 'Corrected' }, { key: 'hold', label: 'Billing hold' }]

/** Shared body for /staff/evv and /app/evv: tabs, counts, the sorted list, billing hold export. */
export async function EvvView({ session, agencyId, tab, basePath, extraQuery = '' }: { session: Session; agencyId: string; tab: Tab; basePath: string; extraQuery?: string }) {
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const counts = await exceptionCounts(db, agencyId)
    if (tab === 'hold') return { counts, hold: await billingHold(db, agencyId), rows: [] }
    const rows = await listExceptions(db, agencyId, tab === 'open' ? 'open' : 'corrected')
    const dismissed = tab === 'corrected' ? await listExceptions(db, agencyId, 'dismissed') : []
    return { counts, hold: [], rows: [...rows, ...dismissed].sort((a, b) => (b.corrected_at ?? b.opened_at).localeCompare(a.corrected_at ?? a.opened_at)) }
  }, { ip })
  const q = (t: Tab) => `${basePath}?tab=${t}${extraQuery}`
  const redCount = tab === 'open' ? data.rows.filter(r => r.days_left != null && r.days_left <= 7).length : 0

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Exception views">
        {TABS.map(t => {
          const n = t.key === 'open' ? data.counts.open : t.key === 'corrected' ? data.counts.corrected + data.counts.dismissed : data.counts.hold
          return (
            <Link key={t.key} href={q(t.key)} role="tab" aria-selected={tab === t.key} className={`glass ${tab === t.key ? '' : 'muted'}`} style={tab === t.key ? { background: 'rgba(255,255,255,0.16)' } : undefined}>
              {t.label}<span className="divider" aria-hidden="true" />{n}
            </Link>
          )
        })}
        {tab === 'hold' && data.hold.length > 0 && (
          <a className="btn ghost xs ml-auto" href={`/api/evv/billing-hold.csv?agency=${agencyId}`}><Icon name="download" size={14} />Export CSV</a>
        )}
      </div>

      {tab === 'open' && redCount > 0 && (
        <p className="mb-4 text-[15px]"><span className="text-danger font-medium">{redCount} {redCount === 1 ? 'exception closes' : 'exceptions close'} within 7 days.</span> Fix those first; after the window closes the visit cannot be corrected and will not pay.</p>
      )}

      {tab !== 'hold' && (data.rows.length === 0
        ? <Empty title={tab === 'open' ? 'No open exceptions' : 'Nothing corrected or dismissed yet'}>{tab === 'open' ? 'Every visit on file matches EVV and the authorization.' : 'Corrected and dismissed exceptions show here with their notes.'}</Empty>
        : <ExceptionTable rows={data.rows} status={tab === 'open' ? 'open' : data.rows[0].status as 'corrected' | 'dismissed'} actions={{ correct: correctAction, dismiss: dismissAction, reopen: reopenAction }} />)}

      {tab === 'hold' && (data.hold.length === 0
        ? <Empty title="Nothing on hold">No unbilled visit has an open exception. Safe to bill.</Empty>
        : (
          <>
            <p className="mb-4 text-[15px]"><span className="text-ink font-medium">Do not bill yet.</span> These visits have at least one open exception. Clear the exception or the claim will deny.</p>
            <div className="table-wrap hidden md:block">
              <table className="dg-table">
                <thead><tr><th>Visit key</th><th>Visit date</th><th>Service</th><th>Units</th><th>Aide</th><th>Client</th><th>Open rules</th><th>Window closes</th></tr></thead>
                <tbody>
                  {data.hold.map(h => { const dl = h.window_closes_at ? daysLeft(new Date(h.window_closes_at)) : null; return (
                    <tr key={h.visit_id}>
                      <td className="ink">{h.vendor_visit_key ?? h.visit_id.slice(0, 8)}</td>
                      <td className="whitespace-nowrap">{h.scheduled_start ? new Date(h.scheduled_start).toLocaleDateString('en-US', { timeZone: h.timezone, month: 'short', day: 'numeric' }) : '—'}</td>
                      <td>{h.service_code}</td><td>{h.units ?? '—'}</td><td>{h.aide_initials ?? '—'}</td><td>{h.client_initials ?? '—'}</td>
                      <td>{h.open_rules.map(r => RULE_LABELS[r as ExceptionRule] ?? r).join(', ')}</td>
                      <td>{dl == null ? '—' : <Badge tone={windowTone(dl) === 'none' ? 'none' : windowTone(dl)}>{windowLabel(dl)}</Badge>}</td>
                    </tr>) })}
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col gap-3 md:hidden">
              {data.hold.map(h => { const dl = h.window_closes_at ? daysLeft(new Date(h.window_closes_at)) : null; return (
                <li key={h.visit_id} className="rounded-2xl border border-line p-4">
                  <div className="flex items-center justify-between gap-2"><span className="text-ink font-medium">{h.vendor_visit_key ?? h.visit_id.slice(0, 8)}</span>{dl != null && <Badge tone={windowTone(dl) === 'none' ? 'none' : windowTone(dl)}>{windowLabel(dl)}</Badge>}</div>
                  <div className="mt-1 text-[14px]">{h.open_rules.map(r => RULE_LABELS[r as ExceptionRule] ?? r).join(', ')}</div>
                  <div className="mt-1 text-[13px] text-grey-h">{h.scheduled_start ? new Date(h.scheduled_start).toLocaleDateString('en-US', { timeZone: h.timezone, month: 'short', day: 'numeric' }) : '—'} · {h.service_code} · {h.units ?? '—'} units · aide {h.aide_initials ?? '—'} · client {h.client_initials ?? '—'}</div>
                </li>) })}
            </ul>
            <div className="mt-4 md:hidden"><Button variant="ghost" size="sm" href={`/api/evv/billing-hold.csv?agency=${agencyId}`}><Icon name="download" size={14} />Export CSV</Button></div>
          </>
        ))}
    </>
  )
}
