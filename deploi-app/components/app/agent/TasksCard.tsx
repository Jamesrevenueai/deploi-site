'use client'
import { useId, useState } from 'react'
import type { AgentTask } from '@/lib/app/contract'
import { Button, Card, EmptyState } from './bits'

const MAX = 500

type Ops = {
  give: (text: string) => Promise<{ ref: string; reply: string }>
  finish: (ref: string, op: 'done' | 'cancel') => Promise<void>
}

/**
 * "Give a task": the owner delegates a job to this agent. It becomes a case the agent owns (it shows in the work
 * table and the team room); the agent says plainly what it will do. Open tasks can be marked done or cancelled.
 */
export function TasksCard({ agentName, tasks, ops }: { agentName: string; tasks: AgentTask[]; ops: Ops }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const id = useId()

  async function give() {
    const t = draft.trim()
    if (!t) { setError('Write the task first.'); return }
    setBusy(true); setError(null); setReply(null)
    try { const r = await ops.give(t); setDraft(''); setReply(`Task ${r.ref}: ${r.reply}`) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function finish(ref: string, op: 'done' | 'cancel') {
    setBusy(true); setError(null)
    try { await ops.finish(ref, op) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card title={`Give ${agentName} a task`} titleId={id}>
      <form onSubmit={e => { e.preventDefault(); void give() }} className="flex flex-col gap-2">
        <label htmlFor={`${id}-text`} className="text-[13px] font-semibold text-[#14141F]">What should {agentName} do?</label>
        <textarea id={`${id}-text`} value={draft} onChange={e => setDraft(e.target.value)} maxLength={MAX} rows={2} data-testid="task-input"
          placeholder="For example: chase the supplier for the blue mugs this week"
          className="w-full resize-y rounded-[10px] border border-[#E3E3EC] bg-white px-3 py-2 text-[14px] text-[#14141F] placeholder:text-[#6B6B80]" />
        <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Giving it…' : 'Give task'}</Button></div>
      </form>
      {reply && <p role="status" className="mb-0 mt-3 rounded-[12px] bg-[#F3F5FF] px-4 py-3 text-[14px] text-[#2A2A3A]" data-testid="task-reply">{reply}</p>}
      {error && <p role="alert" className="mb-0 mt-2 text-[13px] font-semibold text-[#B42318]">{error}</p>}
      <h3 className="mb-2 mt-4 text-[14px] font-semibold text-[#14141F]">Tasks you gave {agentName}</h3>
      {tasks.length === 0 ? <EmptyState title="No tasks yet">Tasks you give show up here and in the team room.</EmptyState> : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="task-list">
          {tasks.map(t => (
            <li key={t.ref} className="flex flex-col gap-2 rounded-[12px] bg-[#FAFAFC] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="task-row">
              <div className="min-w-0 sm:flex-1">
                <p className="m-0 break-words text-[14px] text-[#2A2A3A]">{t.text}</p>
                <p className="m-0 mt-1 text-[12px] text-[#5C5C70]"><a href={`/store/work/${encodeURIComponent(t.ref)}`} className="text-[#2333A8] underline">{t.ref}</a> · {t.result}</p>
              </div>
              {t.open && (
                <div className="flex flex-none gap-1">
                  <Button variant="secondary" onClick={() => void finish(t.ref, 'done')} disabled={busy} aria-label={`Mark done: ${t.text}`}>Mark done</Button>
                  <Button variant="text" onClick={() => void finish(t.ref, 'cancel')} disabled={busy} aria-label={`Cancel task: ${t.text}`}>Cancel</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
