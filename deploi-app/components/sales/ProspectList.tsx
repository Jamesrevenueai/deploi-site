import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import type { Prospect } from '@/lib/sales/queries'
import { STAGE_LABEL } from '@/lib/sales/stages'
import { StageSheet } from './StageSheet'
import { timeAgo, WebsiteTag } from './ProspectCard'

export function ProspectList({ prospects }: { prospects: Prospect[] }) {
  if (prospects.length === 0) return <Empty title="No prospects match">Import a CSV or clear the filters.</Empty>
  return (
    <>
      <ul className="flex flex-col gap-3 min-[960px]:hidden">
        {prospects.map(p => (
          <li key={p.id} className="rounded-2xl border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/staff/pipeline/${p.id}`} className="min-w-0">
                <div className="truncate text-[16px] font-medium text-ink">{p.agency_name}</div>
                <div className="truncate text-[13px] text-grey">{p.owner_name ?? '—'} · {[p.city, p.county].filter(Boolean).join(', ') || 'no location'}</div>
              </Link>
              <StageSheet id={p.id} stage={p.stage} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-grey-h">
              {p.programs.map(pr => <span key={pr} className="rounded-full border border-line px-2 py-0.5 text-grey-nav">{pr}</span>)}
              <WebsiteTag p={p} />
              {p.email_invalid && <Badge tone="danger">bounced</Badge>}
              <span className="ml-auto">{timeAgo(p.last_touch_at)}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="table-wrap hidden min-[960px]:block">
        <table className="dg-table">
          <thead><tr><th>Agency</th><th>Owner</th><th>Location</th><th>Programs</th><th>Stage</th><th>Last touch</th><th>Follow-up</th></tr></thead>
          <tbody>
            {prospects.map(p => (
              <tr key={p.id}>
                <td className="ink"><Link href={`/staff/pipeline/${p.id}`}>{p.agency_name}</Link>{p.email_invalid && <> <Badge tone="danger">bounced</Badge></>} <WebsiteTag p={p} /></td>
                <td>{p.owner_name ?? '—'}</td>
                <td>{[p.city, p.county].filter(Boolean).join(', ') || '—'}</td>
                <td>{p.programs.join(', ') || '—'}</td>
                <td><StageSheet id={p.id} stage={p.stage} label={STAGE_LABEL[p.stage]} /></td>
                <td>{timeAgo(p.last_touch_at)}</td>
                <td>{p.follow_up_at ? String(p.follow_up_at).slice(0, 10) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
