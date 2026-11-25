'use client'
import { useId, useState } from 'react'
import type { Instruction } from '@/lib/app/contract'
import { Button } from './bits'
import { css } from '@/components/dp/css'

const MAX = 500

type Ops = {
  add: (text: string) => Promise<Instruction>
  update: (instructionId: string, text: string) => Promise<Instruction>
  remove: (instructionId: string) => Promise<void>
}

/** "Standing instructions": the agent's list, added, edited and deleted inline through the API. */
export function InstructionsCard({ agentName, initial, ops }: { agentName: string; initial: Instruction[]; ops: Ops }) {
  const [items, setItems] = useState<Instruction[]>(initial)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const titleId = useId()

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true); setError(null)
    try { await fn(); setNotice(done) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const text = draft.trim()
    if (!text) throw new Error('Write the instruction first.')
    const i = await ops.add(text)
    setItems(xs => [...xs, i]); setDraft(''); setAdding(false)
    document.getElementById(`${titleId}-add`)?.focus()
  }, 'Instruction added')
  const saveEdit = (id: string) => run(async () => {
    const text = editText.trim()
    if (!text) throw new Error('An instruction cannot be empty; delete it instead.')
    const i = await ops.update(id, text)
    setItems(xs => xs.map(x => (x.id === id ? i : x))); setEditing(null)
  }, 'Instruction saved')
  const remove = (i: Instruction) => run(async () => {
    await ops.remove(i.id)
    setItems(xs => xs.filter(x => x.id !== i.id))
    if (editing === i.id) setEditing(null)
  }, 'Instruction deleted')

  return (
    <section aria-labelledby={titleId} data-testid="instructions" style={css('border: 1px solid #E0E7FF; border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px;')}>
      <div style={css('display: flex; align-items: center; justify-content: space-between;')}>
        <h2 id={titleId} style={css('margin: 0; font-size: 17px; font-weight: 800; color: #1E1B4B;')}>Standing instructions</h2>
        {!adding && <button id={`${titleId}-add`} type="button" onClick={() => { setAdding(true); setError(null) }} aria-label={`Add a standing instruction for ${agentName}`} style={css('min-height: 44px; padding: 0 12px; border: 0; background: transparent; color: #4F46E5; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;')}>+ Add</button>}
      </div>
      {items.length === 0 && !adding && <p style={css('margin: 0; font-size: 14px; color: #3730A3;')}>No standing instructions yet. Tell {agentName} how you want things done; it reads them on every run.</p>}
      {items.length > 0 && (
        <ol style={css('margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px;')} aria-labelledby={titleId}>
          {items.map((i, n) => (
            <li key={i.id} style={css('padding: 12px 14px; background: #F5F7FF; border-radius: 12px; font-size: 14px; line-height: 1.45;')}>
              {editing === i.id ? (
                <form onSubmit={e => { e.preventDefault(); void saveEdit(i.id) }} className="flex flex-col gap-2">
                  <label htmlFor={`edit-${i.id}`} className="text-[13px] font-semibold text-[#1E1B4B]">Edit instruction {n + 1}</label>
                  <textarea id={`edit-${i.id}`} value={editText} onChange={e => setEditText(e.target.value)} maxLength={MAX} rows={2} autoFocus
                    className="w-full resize-y rounded-[10px] border border-[#E0E7FF] bg-white px-3 py-2 text-[14px] text-[#1E1B4B]" />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" disabled={busy}>Save</Button>
                    <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <div style={css('display: flex; flex-wrap: wrap; align-items: center; gap: 10px;')}>
                  <span style={css("font-family: 'JetBrains Mono', monospace; color: #4F46E5;")} aria-hidden="true">{String(n + 1).padStart(2, '0')}</span>
                  <p style={css('margin: 0; min-width: 0; flex: 1; word-break: break-word; color: #1E1B4B;')}>{i.text}</p>
                  <div className="flex flex-none gap-1">
                    <Button variant="text" style={{ minWidth: 44 }} onClick={() => { setEditing(i.id); setEditText(i.text); setError(null) }} disabled={busy} aria-label={`Edit instruction: ${i.text}`}>Edit</Button>
                    <Button variant="text" style={{ minWidth: 44 }} onClick={() => void remove(i)} disabled={busy} aria-label={`Delete instruction: ${i.text}`}>Delete</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {adding && (
        <form onSubmit={e => { e.preventDefault(); void save() }} style={css('display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: #F5F7FF; border-radius: 12px;')}>
          <label htmlFor={`${titleId}-new`} className="text-[13px] font-semibold text-[#1E1B4B]">New instruction for {agentName}</label>
          <textarea id={`${titleId}-new`} value={draft} onChange={e => setDraft(e.target.value)} maxLength={MAX} rows={2} autoFocus placeholder="For example: never reorder from a supplier on a weekend"
            className="w-full resize-y rounded-[10px] border border-[#E0E7FF] bg-white px-3 py-2 text-[14px] text-[#1E1B4B] placeholder:text-[#4F46E5]" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>Save instruction</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setDraft(''); setError(null) }} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" style={css('margin: 0; font-size: 13px; font-weight: 600; color: #B42318;')}>{error}</p>}
      <p role="status" aria-live="polite" className="sr-only">{notice}</p>
    </section>
  )
}
