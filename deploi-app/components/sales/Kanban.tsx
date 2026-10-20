'use client'
import { useState, useTransition, type DragEvent } from 'react'
import { STAGES, STAGE_LABEL, type Stage } from '@/lib/sales/stages'
import type { Prospect } from '@/lib/sales/queries'
import { setStage } from '@/lib/sales/actions'
import { ProspectCard } from './ProspectCard'

export function Kanban({ prospects }: { prospects: Prospect[] }) {
  const [items, setItems] = useState(prospects)
  const [over, setOver] = useState<Stage | null>(null)
  const [pending, start] = useTransition()

  function onDrop(e: DragEvent<HTMLDivElement>, stage: Stage) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/prospect')
    setOver(null)
    if (!id) return
    const prev = items
    setItems(xs => xs.map(p => (p.id === id && p.stage !== stage ? { ...p, stage } : p)))
    start(async () => { try { await setStage(id, stage) } catch { setItems(prev) } })
  }

  return (
    <div className="hidden min-[960px]:block" aria-busy={pending}>
      <div className="flex gap-3 overflow-x-auto pb-4" style={{ scrollSnapType: 'x proximity' }}>
        {STAGES.map(stage => {
          const col = items.filter(p => p.stage === stage)
          return (
            <div key={stage}
              onDragOver={e => { e.preventDefault(); if (over !== stage) setOver(stage) }}
              onDragLeave={() => setOver(null)}
              onDrop={e => onDrop(e, stage)}
              className={`flex w-[250px] shrink-0 flex-col gap-2 rounded-2xl border p-2 transition-colors ${over === stage ? 'border-white bg-ground-alt' : 'border-line'}`}
              style={{ scrollSnapAlign: 'start', minHeight: 320 }}>
              <div className="flex items-center justify-between px-1 pt-1">
                <span className="text-[13px] font-medium text-ink">{STAGE_LABEL[stage]}</span>
                <span className="glass" style={{ padding: '4px 10px', fontSize: 12 }}>{col.length}</span>
              </div>
              {col.map(p => (
                <div key={p.id} draggable onDragStart={e => { e.dataTransfer.setData('text/prospect', p.id); e.dataTransfer.effectAllowed = 'move' }} className="cursor-grab active:cursor-grabbing">
                  <ProspectCard p={p} />
                </div>
              ))}
              {col.length === 0 && <div className="flex-1 rounded-xl border border-dashed border-line" aria-hidden="true" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
