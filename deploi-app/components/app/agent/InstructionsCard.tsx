'use client'
import { useId, useState } from 'react'
import type { Instruction } from '@/lib/app/contract'
import { Button, Card, EmptyState } from './bits'

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
    <Card title="Standing instructions" titleId={titleId}
      action={!adding && <Button id={`${titleId}-add`} variant="secondary" onClick={() => { setAdding(true); setError(null) }} aria-label={`Add a standing instruction for ${agentName}`}>Add</Button>}>
      {items.length === 0 && !adding && <EmptyState title="No standing instructions yet">Tell {agentName} how you want things done; it follows them on every run.</EmptyState>}
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-labelledby={titleId}>
          {items.map((i, n) => (
            <li key={i.id} className="rounded-[12px] bg-[#FAFAFC] px-4 py-3">
              {editing === i.id ? (
                <form onSubmit={e => { e.preventDefault(); void saveEdit(i.id) }} className="flex flex-col gap-2">
                  <label htmlFor={`edit-${i.id}`} className="text-[13px] font-semibold text-[#14141F]">Edit instruction {n + 1}</label>
                  <textarea id={`edit-${i.id}`} value={editText} onChange={e => setEditText(e.target.value)} maxLength={MAX} rows={2} autoFocus
                    className="w-full resize-y rounded-[10px] border border-[#E3E3EC] bg-white px-3 py-2 text-[14px] text-[#14141F]" />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" disabled={busy}>Save</Button>
                    <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 min-w-0 flex-1 break-words text-[14px] text-[#2A2A3A]">{i.text}</p>
                  <div className="flex flex-none gap-1">
                    <Button variant="text" style={{ minWidth: 44 }} onClick={() => { setEditing(i.id); setEditText(i.text); setError(null) }} disabled={busy} aria-label={`Edit instruction: ${i.text}`}>Edit</Button>
                    <Button variant="text" style={{ minWidth: 44 }} onClick={() => void remove(i)} disabled={busy} aria-label={`Delete instruction: ${i.text}`}>Delete</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form onSubmit={e => { e.preventDefault(); void save() }} className={`flex flex-col gap-2 rounded-[12px] bg-[#FAFAFC] px-4 py-3 ${items.length ? 'mt-2' : ''}`}>
          <label htmlFor={`${titleId}-new`} className="text-[13px] font-semibold text-[#14141F]">New instruction for {agentName}</label>
          <textarea id={`${titleId}-new`} value={draft} onChange={e => setDraft(e.target.value)} maxLength={MAX} rows={2} autoFocus placeholder="For example: never reorder from a supplier on a weekend"
            className="w-full resize-y rounded-[10px] border border-[#E3E3EC] bg-white px-3 py-2 text-[14px] text-[#14141F] placeholder:text-[#6B6B80]" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>Save instruction</Button>
            <Button variant="secondary" onClick={() => { setAdding(false); setDraft(''); setError(null) }} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mb-0 mt-2 text-[13px] font-semibold text-[#B42318]">{error}</p>}
      <p role="status" aria-live="polite" className="sr-only">{notice}</p>
    </Card>
  )
}
