import Link from 'next/link'
import type { Allowance } from '@/lib/app/contract'
import { css } from '@/components/dp/css'

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "X / Y" (or "X used · no monthly limit" while the plan sets none), from the real allowance. */
export function usageText(a: Allowance): string {
  return a.limit === null ? `${a.used.toLocaleString('en-US')} used · no monthly limit` : `${a.used.toLocaleString('en-US')} / ${a.limit.toLocaleString('en-US')}`
}

/** The sidebar's "Actions this month" card (design): used / allowance, the bar, the plan and its renewal date. */
export function Usage({ allowance }: { allowance: Allowance }) {
  const pct = allowance.limit ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : null
  return (
    <section aria-label="Actions this month" data-testid="usage" style={css('padding: 16px; border: 1px solid #E0E7FF; border-radius: 14px; display: flex; flex-direction: column; gap: 10px;')}>
      <div style={css('display: flex; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; color: #4F46E5;')}><span>Actions this month</span><span style={css("font-family: 'JetBrains Mono', monospace;")}>{usageText(allowance)}</span></div>
      {pct !== null && (
        <div role="progressbar" aria-label="Actions used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={css('height: 8px; background: #EEF2FF; border-radius: 999px; overflow: hidden;')}>
          <div style={{ ...css('height: 100%; background: #4F46E5; border-radius: 999px;'), width: `${pct}%` }} />
        </div>
      )}
      <Link href="/store/plan" style={css('font-size: 12px; color: #3730A3; text-decoration: none;')}>{allowance.planName.replace(/ plan$/, '')} plan · {allowance.enforced ? 'renews' : 'resets'} {day(allowance.resetsAt)}</Link>
    </section>
  )
}
