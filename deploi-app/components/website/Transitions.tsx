import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Field'
import { transitionForm } from '@/lib/website/actions'
import { nextSteps, STATUS_LABEL, isStatus, type Engagement, type Status } from '@/lib/website/states'
import type { Transition } from '@/lib/website/queries'
import { StatusBadge } from './StatusBadge'

/** Only legal transitions are shown; a blocked one is disabled and shows its gate reason. */
export function TransitionButtons({ e }: { e: Engagement }) {
  const steps = nextSteps(e)
  if (!steps.length) return <p className="text-grey text-[15px]">This engagement is {STATUS_LABEL[e.status].toLowerCase()}; no further transitions.</p>
  return (
    <ul className="flex flex-col gap-3">
      {steps.map(s => (
        <li key={s.to} className="rounded-2xl border border-line p-3">
          <form action={transitionForm} className="flex flex-col gap-2 min-[560px]:flex-row min-[560px]:items-center">
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="to" value={s.to} />
            <Input name="note" placeholder="Note (optional)" aria-label={`Note for ${s.label}`} />
            <Button type="submit" variant={s.to === 'cancelled' ? 'danger' : 'ghost'} size="sm" disabled={!s.gate.ok} className="shrink-0">
              {s.to === 'improving' && e.status === 'preview_ready' ? 'Back to improving (revision)' : s.to === 'cancelled' ? 'Cancel engagement' : `Move to ${s.label}`}
            </Button>
          </form>
          {!s.gate.ok && <p className="mt-2 text-[13px] text-warn">Blocked: {s.gate.reason}</p>}
        </li>
      ))}
    </ul>
  )
}

export function TransitionHistory({ rows }: { rows: Transition[] }) {
  if (!rows.length) return <p className="text-grey text-[15px]">No transitions yet.</p>
  return (
    <ol className="flex flex-col gap-2">
      {rows.map(t => (
        <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line p-3 text-[14px]">
          <span className="text-grey-h">{t.from_status ? STATUS_LABEL[t.from_status as Status] ?? t.from_status : 'created'} →</span>
          {isStatus(t.to_status) ? <StatusBadge status={t.to_status} /> : <span>{t.to_status}</span>}
          <span className="text-grey-h">{new Date(t.at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })}</span>
          {t.note && <span className="w-full text-grey">{t.note}</span>}
        </li>
      ))}
    </ol>
  )
}
