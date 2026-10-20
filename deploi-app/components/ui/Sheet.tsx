'use client'
import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'

/** Bottom sheet on mobile, centered dialog on desktop. Controlled by the parent. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-black/70" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-t-[20px] border border-line bg-black p-5 md:rounded-[20px] fade-up max-h-[88vh] overflow-y-auto">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg">{title}</h2>
          <button className="btn ghost xs" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
