import { money, CATEGORY_LABEL, GRADE_LABEL, type Leak } from '@/lib/leaks'
import { GlassPill } from '@/components/ui/GlassPill'
import { Badge } from '@/components/ui/Badge'

const gradeTone = (g: Leak['grade']) => (g === 'A' ? 'ok' : g === 'B' ? 'warn' : 'muted') as 'ok' | 'warn' | 'muted'

export function LeakCards({ leaks }: { leaks: Leak[] }) {
  if (!leaks?.length) return <p className="text-grey">Leaks have not been calculated yet.</p>
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {leaks.map((l, i) => {
        const base = Number(l.base ?? l.dollars_per_year) || 0
        const low = Number(l.low ?? base) || 0
        const high = Number(l.high ?? base) || 0
        return (
          <div key={l.key} className="metal p-5">
            <div className="relative flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <GlassPill icon="dollar">Leak {i + 1}</GlassPill>
                <span className="text-xs uppercase tracking-wide text-grey-h">{l.door}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="none">{l.category ? CATEGORY_LABEL[l.category] : 'uncategorised'}</Badge>
                {l.grade && <Badge tone={gradeTone(l.grade)}>{GRADE_LABEL[l.grade]}</Badge>}
                {l.illustrative && <Badge tone="warn">illustrative</Badge>}
              </div>
              <div className="text-ink font-semibold text-2xl tracking-tight">{money(base)}<span className="text-grey-h text-base font-normal"> / yr base</span></div>
              <div className="text-[13px] text-grey-h">low {money(low)} · high {money(high)}</div>
              <div className="text-ink font-medium">{l.label}</div>
              <div className="text-[13px] text-grey-h">{l.formula}</div>
              {l.illustrative && l.frequency_basis && <div className="text-[12px] text-warn">Frequency: {l.frequency_basis.description}</div>}
              {l.missing_inputs?.length ? <div className="text-[12px] text-grey-h">Missing: {l.missing_inputs.join(', ')}</div> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
