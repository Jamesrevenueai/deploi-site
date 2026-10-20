import { money, type Leak } from '@/lib/leaks'
import { GlassPill } from '@/components/ui/GlassPill'

export function LeakCards({ leaks }: { leaks: Leak[] }) {
  if (!leaks?.length) return <p className="text-grey">Leaks have not been calculated yet.</p>
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {leaks.map((l, i) => (
        <div key={l.key} className="metal p-5">
          <div className="relative flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <GlassPill icon="dollar">Leak {i + 1}</GlassPill>
              <span className="text-xs uppercase tracking-wide text-grey-h">{l.door}</span>
            </div>
            <div className="text-ink font-semibold text-2xl tracking-tight">{money(l.dollars_per_year)}<span className="text-grey-h text-base font-normal"> / yr</span></div>
            <div className="text-ink font-medium">{l.label}</div>
            <div className="text-[13px] text-grey-h">{l.formula}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
