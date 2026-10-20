import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import type { Prospect } from '@/lib/sales/queries'
import { creditLabel, creditState } from '@/lib/credit/label'

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return 'no touches'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function ProspectCard({ p, compact }: { p: Prospect; compact?: boolean }) {
  const credit = creditLabel({ assessment_credit_cents: p.assessment_credit_cents ?? 0, credit_expires_at: p.credit_expires_at ?? null, assessment_credit_applied_at: p.assessment_credit_applied_at, credit_expired: p.credit_expired })
  const cstate = creditState({ assessment_credit_cents: p.assessment_credit_cents ?? 0, credit_expires_at: p.credit_expires_at ?? null, assessment_credit_applied_at: p.assessment_credit_applied_at, credit_expired: p.credit_expired })
  return (
    <Link href={`/staff/pipeline/${p.id}`} className="block rounded-2xl border border-line bg-black p-3 hover:bg-ground-alt" draggable={false}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">{p.agency_name}</div>
          <div className="truncate text-[13px] text-grey">{p.owner_name ?? '—'}{p.city || p.county ? ` · ${[p.city, p.county].filter(Boolean).join(', ')}` : ''}</div>
        </div>
        {p.email_invalid && <Badge tone="danger">bounced</Badge>}
      </div>
      {credit && (
        <div className={`mt-2 text-[12px] ${cstate === 'expired' ? 'text-danger' : cstate === 'applied' ? 'text-ok' : 'text-grey-nav'}`}>{credit}</div>
      )}
      {!compact && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {p.programs.map(pr => <span key={pr} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-grey-nav">{pr}</span>)}
          <span className="ml-auto text-[12px] text-grey-h">{timeAgo(p.last_touch_at)}</span>
        </div>
      )}
    </Link>
  )
}
