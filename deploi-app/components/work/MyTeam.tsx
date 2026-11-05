'use client'
/** My AI Team: every agent in one list — store agents, Office agents and the agent library — with live status. */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { useLoad } from '@/components/store/useLoad'
import { Loading, Section } from '@/components/store/bits'
import { loadTeam } from './data'
import { teamMembers, type TeamMember } from './caseView'

const GROUPS: { key: TeamMember['group']; sub: string; manage: { href: string; label: string } }[] = [
  { key: 'Store agents', sub: 'Check and correct your store within what you granted.', manage: { href: '/store/agents', label: 'Manage store agents' } },
  { key: 'Office agents', sub: 'Lead follow-up, scheduling and CRM notes.', manage: { href: '/office/agents', label: 'Manage Office agents' } },
  { key: 'Agent library', sub: 'Ready-made agents included in your plan.', manage: { href: '/store/team', label: 'Open the agent library' } },
]

export function MyTeamScreen() {
  const { data, loading } = useLoad(loadTeam, 'my-team')
  const header = <PageHeader title="My AI Team" sub="Every agent working for your business, in one list. Each one acts only within the permissions you granted, and you can pause any of them." actions={<Link href="/store/agents/new" className="btn sm"><Icon name="plus" size={15} />Add an agent</Link>} />
  if (loading && !data) return <>{header}<Loading label="Loading your team" rows={3} /></>
  const members = data ? teamMembers({ engine: data.cr?.agents ?? [], office: data.office, library: data.library }) : []
  return (
    <>
      {header}
      {members.length === 0 && <Empty title="No agents yet">See what Deploi found and the team it recommends. <Link href="/store/welcome" className="link">Find work for my team</Link>.</Empty>}
      {GROUPS.map(g => {
        const list = members.filter(m => m.group === g.key)
        const unread = (g.key === 'Office agents' && data?.office === null) || (g.key === 'Agent library' && data?.library === null) || (g.key === 'Store agents' && data?.cr === null)
        if (!list.length && !unread) return null
        return (
          <Section key={g.key} id={g.key.toLowerCase().replace(/\s+/g, '-')} title={g.key} sub={g.sub} actions={<Link href={g.manage.href} className="btn ghost xs">{g.manage.label}<Icon name="arrow-right" size={14} /></Link>}>
            {unread && !list.length ? <p className="text-[14px] text-grey-h">{g.key === 'Office agents' ? 'Deploi Office is not switched on for your business.' : 'Could not be read right now.'}</p> : (
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={g.key}>
                {list.map(m => (
                  <li key={m.key} data-team-member={m.key}>
                    <Link href={m.href} className="panel flex h-full flex-col gap-2 p-4 transition-colors hover:border-[var(--c-accent-line)]">
                      <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-semibold text-ink">{m.name}</span><Badge tone={m.tone}>{m.status}</Badge></div>
                      <span className="text-[13.5px] text-grey">{m.detail}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )
      })}
    </>
  )
}
