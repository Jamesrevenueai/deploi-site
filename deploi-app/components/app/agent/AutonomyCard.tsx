'use client'
import { useId, useState } from 'react'
import type { AgentAutonomy } from '@/lib/app/contract'
import { Card } from './bits'

export const AUTONOMY_OPTIONS: { value: AgentAutonomy; title: string; hint: string }[] = [
  { value: 'ask_first', title: 'Ask first', hint: 'Spots issues, drafts the fix, waits for you.' },
  { value: 'act_then_tell', title: 'Act, then tell me', hint: 'Fixes small things, texts you a summary.' },
  { value: 'autonomous', title: 'Fully autonomous', hint: 'Handles everything inside its limits.' },
]
export const MONEY_NOTE = 'Anything that spends money always asks first, on every level.'

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** "How much can it do alone?": real radios in a fieldset; a change saves at once (POST autonomy) and says so. */
export function AutonomyCard({ agentName, value, chosen, onSave }: { agentName: string; value: AgentAutonomy; chosen: boolean; onSave: (v: AgentAutonomy) => Promise<void> }) {
  const [selected, setSelected] = useState<AgentAutonomy>(value)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  // the saved level can change elsewhere (the chat can set it): follow it unless a save is in flight
  const [seen, setSeen] = useState<AgentAutonomy>(value)
  if (seen !== value) { setSeen(value); if (state.kind !== 'saving') setSelected(value) }
  const name = useId()
  const titleId = useId()

  async function choose(v: AgentAutonomy) {
    // one save at a time; the radios stay focusable (a disabled fieldset would drop keyboard focus)
    if (state.kind === 'saving' || v === selected) return
    const previous = selected
    setSelected(v)
    setState({ kind: 'saving' })
    try { await onSave(v); setState({ kind: 'saved' }) } catch (e) { setSelected(previous); setState({ kind: 'error', message: (e as Error).message }) }
  }

  return (
    <Card>
      <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={`${titleId}-note`} aria-busy={state.kind === 'saving'}>
        <legend id={titleId} className="app-h2 p-0" style={{ fontSize: 18, marginBottom: 12 }}>How much can it do alone?</legend>
        {!chosen && <p className="mb-3 mt-0 text-[13px] text-[#5C5C70]">Not chosen yet: this is what {agentName}&apos;s current settings amount to.</p>}
        <div className="flex flex-col gap-2">
          {AUTONOMY_OPTIONS.map(o => {
            const on = selected === o.value
            return (
              <label key={o.value} className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[12px] px-4 py-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#2333A8] ${on ? 'border-2 border-[#14141F] bg-white' : 'border border-[#E3E3EC] bg-[#FAFAFC]'}`}
                style={on ? undefined : { margin: 1 }}>
                <input type="radio" name={name} value={o.value} checked={on} onChange={() => choose(o.value)} className="mt-1 h-[18px] w-[18px] flex-none accent-[#14141F]" />
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold text-[#14141F]">{o.title}</span>
                  <span className="block text-[13px] text-[#5C5C70]">{o.hint}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <p role="status" aria-live="polite" className="mb-0 mt-2 min-h-[20px] text-[13px] font-semibold" style={{ color: state.kind === 'error' ? '#B42318' : state.kind === 'saved' ? '#17663F' : '#5C5C70' }}>
        {state.kind === 'saving' ? 'Saving…' : state.kind === 'saved' ? 'Saved' : state.kind === 'error' ? `Not saved: ${state.message}` : ''}
      </p>
      <p id={`${titleId}-note`} className="mb-0 mt-1 text-[13px] text-[#2A2A3A]">{MONEY_NOTE}</p>
    </Card>
  )
}
