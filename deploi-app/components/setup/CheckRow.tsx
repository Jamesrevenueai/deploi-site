import type { Check } from '@/lib/setup/readiness'

export function CheckRow({ c }: { c: Check }) {
  return (
    <li className="flex items-start gap-3 border-b border-line py-4 last:border-b-0">
      <span aria-label={c.ok ? 'ready' : 'not ready'} className={`mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full ${c.ok ? 'bg-ok' : 'bg-danger'}`} />
      <div className="min-w-0">
        <div className="text-ink font-medium">{c.label}</div>
        <div className="text-grey text-[15px] break-words">{c.detail}</div>
        {c.note && <div className="text-grey-h text-[13px] mt-1">{c.note}</div>}
      </div>
    </li>
  )
}
