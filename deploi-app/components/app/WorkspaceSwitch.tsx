'use client'
/**
 * The Store | Office switch. It switches the whole app (POST /api/app/workspace, a per-person preference), then
 * opens the Command center of the chosen side. A radiogroup: Tab reaches the checked segment, the arrow keys move
 * and choose, Space or Enter chooses the focused one.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Workspace } from '@/lib/app/contract'
import { storeFetch, StoreApiError } from '@/components/store/api'

const OPTIONS: { value: Workspace; label: string }[] = [{ value: 'store', label: 'Store' }, { value: 'office', label: 'Office' }]

export function WorkspaceSwitch({ workspace }: { workspace: Workspace }) {
  const router = useRouter()
  const path = usePathname()
  const [current, setCurrent] = useState<Workspace>(workspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const choose = async (next: Workspace) => {
    if (busy || next === current) return
    const before = current
    setCurrent(next); setBusy(true); setError(null)
    try {
      await storeFetch('/api/app/workspace', { method: 'POST', body: { workspace: next } })
      if (path === '/store') router.refresh()
      else router.push('/store')
    } catch (e) {
      setCurrent(before)
      setError(e instanceof StoreApiError ? e.message : 'Could not switch. Try again.')
    } finally { setBusy(false) }
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? OPTIONS.length - 1 : (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + OPTIONS.length) % OPTIONS.length
    refs.current[n]?.focus()
    void choose(OPTIONS[n].value)
  }

  return (
    <div>
      <div className="app-switch" role="radiogroup" aria-label="Workspace" aria-busy={busy || undefined}>
        {OPTIONS.map((o, i) => {
          const on = o.value === current
          return (
            <button key={o.value} ref={el => { refs.current[i] = el }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              onClick={() => void choose(o.value)} onKeyDown={e => onKey(e, i)} data-testid={`workspace-${o.value}`}>
              {o.label}
            </button>
          )
        })}
      </div>
      {error && <p role="alert" className="app-ws-sources" style={{ color: '#A11B1B' }}>{error}</p>}
    </div>
  )
}
