import type { ReactNode } from 'react'

/** Stacked card list used on phones instead of a table. */
export function MobileRows({ rows }: { rows: { key: string; title: ReactNode; lines: ReactNode[]; badge?: ReactNode }[] }) {
  return (
    <ul className="flex flex-col gap-3 md:hidden">
      {rows.map(r => (
        <li key={r.key} className="rounded-2xl border border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <span className="text-ink font-medium">{r.title}</span>
            {r.badge}
          </div>
          {r.lines.map((l, i) => <div key={i} className="mt-1 text-[14px] text-grey">{l}</div>)}
        </li>
      ))}
    </ul>
  )
}
