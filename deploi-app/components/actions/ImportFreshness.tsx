import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import type { ImportFreshness as Freshness } from '@/lib/imports/provenance'
import type { ImportKind } from '@/lib/imports/specs'

const LABEL: Record<ImportKind, string> = { evv_visits: 'EVV visits', applicants: 'applicants', aides: 'aide roster' }

/** "Last successful import" line with a stale flag. Server component. */
export function ImportFreshness({ kind, info, href }: { kind: ImportKind; info: Freshness; href?: string }) {
  const when = info.at ? new Date(info.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line px-4 py-3 text-[14px]">
      <span className="text-grey-h">Last successful {LABEL[kind]} import:</span>
      <span className="text-ink">{when ? `${when}${info.filename ? ` · ${info.filename}` : ''}` : 'never'}</span>
      {info.stale ? <Badge tone="warn">stale · {info.days == null ? 'no import yet' : `${info.days}d old, limit ${info.thresholdDays}d`}</Badge> : <Badge tone="ok">fresh · {info.days}d old</Badge>}
      {href && <Link href={href} className="ml-auto text-ink underline">Import</Link>}
    </div>
  )
}
