'use client'
import { useState, useTransition } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Icon } from '@/components/ui/Icon'
import { STAGES, STAGE_LABEL, type Stage } from '@/lib/sales/stages'
import { setStage } from '@/lib/sales/actions'

/** Stage changer for the list view and prospect page: a bottom sheet on phones, dialog on desktop. */
export function StageSheet({ id, stage, label }: { id: string; stage: Stage; label?: string }) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<Stage>(stage)
  const [pending, start] = useTransition()
  return (
    <>
      <button type="button" className="badge" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Change stage, currently ${STAGE_LABEL[current]}`}>
        {label ?? STAGE_LABEL[current]} <Icon name="edit" size={12} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Move to stage">
        <div className="flex flex-col gap-2" aria-busy={pending}>
          {STAGES.map(s => (
            <button key={s} type="button" disabled={pending}
              className={`flex min-h-12 items-center justify-between rounded-xl border px-4 text-left text-[15px] ${s === current ? 'border-white text-ink' : 'border-line text-grey hover:text-ink'}`}
              onClick={() => start(async () => { await setStage(id, s); setCurrent(s); setOpen(false) })}>
              {STAGE_LABEL[s]} {s === current && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  )
}
