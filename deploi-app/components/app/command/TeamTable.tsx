import Link from 'next/link'
import type { TeamAgent } from '@/lib/app/contract'
import { BotAvatar } from '@/components/app/BotAvatar'
import { StatusPill, Table } from '@/components/app/ui'

export const agentHref = (id: string) => `/agents/${encodeURIComponent(id)}`

/** "Your team": every agent of this side, what it is doing now and how much it did today. Scrolls sideways inside its box. */
export function TeamTable({ agents }: { agents: TeamAgent[] }) {
  return (
    <Table label="Your team" minWidth={780} testId="team-table">
      <thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Doing right now</th><th scope="col">Today</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
      <tbody>
        {agents.map(a => (
          <tr key={a.id} data-testid="team-row">
            <td>
              <div className="cc-agent">
                <BotAvatar color={a.color} size={34} />
                <div style={{ minWidth: 0 }}><p className="cc-agent-name">{a.name}</p><p className="cc-agent-area">{a.area}</p></div>
              </div>
            </td>
            <td><StatusPill status={a.status} /></td>
            <td>{a.doingNow}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{a.todayActions} {a.todayActions === 1 ? 'action' : 'actions'}</td>
            <td style={{ textAlign: 'right' }}><Link href={agentHref(a.id)} className="app-btn app-btn--secondary" aria-label={`Open ${a.name}`}>Open</Link></td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
