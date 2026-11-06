import { useId } from 'react'
import { Card as UiCard } from '@/components/app/ui'
import type { AgentScope, AgentStat, WorkRow } from '@/lib/app/contract'
import { Card, EmptyState, ProofChip, SCOPE_STYLE, Table, formatStat, formatWhen, HEADING_FONT } from './bits'

/** Four stat cards (auto-fit, 180px minimum) from the dashboard's agent-specific stats. */
export function StatCards({ stats }: { stats: AgentStat[] }) {
  return (
    <ul className="m-0 grid list-none gap-3 p-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }} aria-label="This agent in numbers">
      {stats.map(s => (
        <UiCard as="li" key={s.key}>
          <p className="m-0 text-[13px] font-medium text-[#5C5C70]">{s.label}</p>
          <p className="m-0 mt-1 text-[28px] font-bold leading-tight text-[#14141F]" style={{ fontFamily: HEADING_FONT }}>{formatStat(s.value, s.unit)}</p>
        </UiCard>
      ))}
    </ul>
  )
}

/** "What it can touch": one pill per real scope, its colour and its word both saying the level. */
export function ScopesCard({ scopes }: { scopes: AgentScope[] }) {
  const titleId = useId()
  return (
    <Card title="What it can touch" titleId={titleId}>
      {scopes.length === 0 ? (
        <EmptyState title="Nothing granted yet">It can touch nothing until you connect a system and switch it on.</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-labelledby={titleId}>
          {scopes.map(s => {
            const st = SCOPE_STYLE[s.level]
            return (
              <li key={`${s.label}-${s.level}`} className="inline-flex items-center gap-2 rounded-full px-3 py-[6px] text-[13px]" style={{ background: st.bg, color: st.text }} data-level={s.level}>
                <span className="font-medium">{s.label}</span>
                <span className="font-bold">· {st.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/** "Work done, with proof": scrolls sideways inside its own box on a phone. */
export function WorkTable({ rows }: { rows: WorkRow[] }) {
  const titleId = useId()
  return (
    <Card title="Work done, with proof" titleId={titleId}>
      {rows.length === 0 ? (
        <EmptyState title="No work yet — finished work shows here with its proof" />
      ) : (
        <Table label="Work done, table (scrolls sideways on small screens)" minWidth={640}>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What it did</th>
                <th scope="col">Result</th>
                <th scope="col">Proof</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.when}-${i}`}>
                  <td className="whitespace-nowrap text-[#5C5C70]"><time dateTime={r.when} suppressHydrationWarning>{formatWhen(r.when)}</time></td>
                  <td className="text-[#14141F]">{r.what}</td>
                  <td className="whitespace-nowrap">{r.result}</td>
                  <td>{r.proof ? <ProofChip proof={r.proof} context={r.what} /> : <span className="text-[#5C5C70]">None yet</span>}</td>
                </tr>
              ))}
            </tbody>
        </Table>
      )}
    </Card>
  )
}
