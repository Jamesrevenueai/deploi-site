import Link from 'next/link'
import { Icon } from '@/components/ui/Icon'
import { Badge } from '@/components/ui/Badge'
import type { NeedsHuman as Item } from '@/lib/dashboard/metrics'
import type { RankedActionItem } from '@/lib/dashboard/urgency'
import { LEVEL_TONE } from '@/lib/dashboard/urgency'

const ICON: Record<string, string> = { exception: 'shield', shift: 'calendar', authorization: 'clipboard', referral: 'inbox', credential: 'badge', approval: 'check', freshness: 'upload' }

type Row = Item | RankedActionItem
const hasLevel = (r: Row): r is RankedActionItem => 'level' in r

/** "Needs a human today" (3 items from metrics) or the ranked agency action items, same card list. */
export function NeedsHuman({ items, title = 'Needs a human today', id = 'needs-human', empty = 'Nothing is waiting on a person this morning.', intro }: { items: Row[]; title?: string; id?: string; empty?: string; intro?: React.ReactNode }) {
  return (
    <section className="mt-8 fade-up" aria-labelledby={id}>
      <h2 id={id} className="mb-3">{title}</h2>
      {intro && <p className="mb-3 text-[15px] text-grey">{intro}</p>}
      {items.length === 0 ? (
        <p className="text-grey">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((it, i) => {
            const inner = (
              <>
                <span className="glass shrink-0" style={{ padding: '8px 10px' }}><Icon name={ICON[it.kind] ?? 'spark'} size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-ink font-medium">{i + 1}. {it.title}</span>
                    {hasLevel(it) && <Badge tone={LEVEL_TONE[it.level]}>{it.level}</Badge>}
                  </span>
                  <span className="block text-[15px] text-grey">{it.detail}</span>
                </span>
                {it.href && <Icon name="arrow-right" size={16} className="mt-1 shrink-0 text-grey-h" />}
              </>
            )
            const cls = 'card flex items-start gap-4 rounded-[20px] border border-line p-4 md:p-5'
            return <li key={i}>{it.href ? <Link href={it.href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>}</li>
          })}
        </ol>
      )}
    </section>
  )
}
