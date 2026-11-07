import type { Allowance } from '@/lib/app/contract'

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "X of Y" (or "X used · no monthly limit" while the plan sets none), from the real allowance. */
export function usageText(a: Allowance): string {
  return a.limit === null ? `${a.used.toLocaleString('en-US')} used · no monthly limit` : `${a.used.toLocaleString('en-US')} of ${a.limit.toLocaleString('en-US')}`
}

/** The sidebar's "Actions this month" card. The bar shows only when there is a limit to measure against. */
export function Usage({ allowance }: { allowance: Allowance }) {
  const pct = allowance.limit ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : null
  return (
    <section className="app-usage" aria-label="Actions this month" data-testid="usage">
      <p className="app-usage-title">Actions this month</p>
      <p className="app-usage-value">{usageText(allowance)}</p>
      {pct !== null && (
        <div className="app-bar" role="progressbar" aria-label="Actions used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
      )}
      <p className="app-usage-sub">{allowance.planName} · resets {day(allowance.resetsAt)}</p>
    </section>
  )
}
