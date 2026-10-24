import type { Budget } from '@/lib/website/states'

/** Labor hours against the five-hour budget: warning at 80%, blocker note at 100%. Never reduces scope silently. */
export function BudgetBar({ budget }: { budget: Budget }) {
  const color = budget.level === 'blocked' ? 'var(--color-danger)' : budget.level === 'warn' ? 'var(--color-warn)' : 'var(--color-ok)'
  return (
    <div>
      <div className="flex items-baseline justify-between text-[14px]">
        <span className="text-ink">{budget.hours.toFixed(2)} h logged of {budget.budget} h budget</span>
        <span className={budget.level === 'blocked' ? 'text-danger' : budget.level === 'warn' ? 'text-warn' : 'text-grey-h'}>{budget.pct}%</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full border border-line" role="progressbar" aria-valuenow={Math.min(100, budget.pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Labor budget used">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, budget.pct)}%`, background: color }} />
      </div>
      {budget.message && (
        <p className={`mt-2 text-[14px] ${budget.level === 'blocked' ? 'text-danger' : 'text-warn'}`} role="status">
          <strong>{budget.level === 'blocked' ? 'Blocker: ' : 'Warning: '}</strong>{budget.message}
        </p>
      )}
    </div>
  )
}
