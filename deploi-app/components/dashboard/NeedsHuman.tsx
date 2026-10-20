import Link from 'next/link'
import { Icon } from '@/components/ui/Icon'
import type { NeedsHuman as Item } from '@/lib/dashboard/metrics'

const ICON: Record<Item['kind'], string> = { exception: 'shield', shift: 'calendar', authorization: 'clipboard', referral: 'inbox' }

export function NeedsHuman({ items }: { items: Item[] }) {
  return (
    <section className="mt-8 fade-up" aria-labelledby="needs-human">
      <h2 id="needs-human" className="mb-3">Needs a human today</h2>
      {items.length === 0 ? (
        <p className="text-grey">Nothing is waiting on a person this morning.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((it, i) => (
            <li key={i}>
              <Link href={it.href} className="card flex items-start gap-4 rounded-[20px] border border-line p-4 md:p-5">
                <span className="glass shrink-0" style={{ padding: '8px 10px' }}><Icon name={ICON[it.kind]} size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ink font-medium">{i + 1}. {it.title}</span>
                  <span className="block text-[15px] text-grey">{it.detail}</span>
                </span>
                <Icon name="arrow-right" size={16} className="mt-1 shrink-0 text-grey-h" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
