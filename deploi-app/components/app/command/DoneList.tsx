import type { DoneItem } from '@/lib/app/contract'
import { ProofChip } from '@/components/app/ui'
import { FALLBACK_COLOR } from './NeedsYouCard'

/** "Done, with proof": who did what, when, and the proof of it. */
export function DoneList({ items }: { items: DoneItem[] }) {
  return (
    <ul className="cc-list" style={{ gap: 0 }} data-testid="done-list">
      {items.map(d => (
        <li key={d.id} className="cc-done" data-testid="done-row">
          <span className="cc-dot" style={{ background: d.agent.color ?? FALLBACK_COLOR }} aria-hidden="true" />
          <div className="cc-done-text">
            <p><strong>{d.agent.name}</strong> {d.what}</p>
            <div className="cc-done-meta">
              <time dateTime={d.at}>{d.ago}</time>
              {d.onItsOwn && <span>On its own</span>}
              <ProofChip proof={d.proof} context={`${d.agent.name}: ${d.what}`} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
