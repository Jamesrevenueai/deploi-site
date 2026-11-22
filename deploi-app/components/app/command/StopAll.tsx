'use client'
/**
 * The emergency stop on the Command center: "Stop all agents" asks first, then sets the organization stop
 * (POST /api/store/control-room/stop-all: every agent paused, queued changes and emails cancelled, library agents
 * switched off). While the stop is on, a notice says so and offers to turn it off (nothing restarts by itself).
 * The "Pause everything" link of the owner's first-run update (/store?pause=all) opens the confirmation.
 */
import { useEffect, useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/app/ui'
import { storeFetch, StoreApiError } from '@/components/store/api'

type StopResult = { paused: number; librarySwitchedOff?: number; alreadyStopped?: number; failed: { name: string; message: string }[] }
const msg = (e: unknown) => (e instanceof StoreApiError ? e.message : 'That did not go through. Try again.')

/** While the organization stop is on: says so, and lets an owner or admin turn it off. */
export function StopNotice({ stopped, canAct, onChanged }: { stopped: string | null; canAct: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!stopped) return null
  const clear = async () => {
    setBusy(true); setError(null)
    try { await storeFetch('/api/store/control-room/stop-all', { method: 'POST', body: { action: 'clear' } }); onChanged() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="app-card" role="status" data-testid="org-stopped" style={{ background: 'var(--app-waiting-bg)', borderColor: 'transparent', color: 'var(--app-waiting-text)' }}>
      <p style={{ fontWeight: 600 }}>All agents are stopped.</p>
      <p style={{ marginTop: 4 }}>Nothing runs, changes your store or sends email until you turn the stop off; then resume each agent from its page.</p>
      {canAct && <div style={{ marginTop: 12 }}><Button variant="secondary" onClick={() => void clear()} disabled={busy} data-testid="clear-stop">Turn the stop off</Button></div>}
      {error && <p role="alert" className="cc-need-error">{error}</p>}
    </div>
  )
}

/** "Stop all agents": asks first, then sets the organization stop. Hidden while the stop is on and for read-only roles. */
export function StopAllButton({ stopped, canAct, onChanged }: { stopped: string | null; canAct: boolean; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { try { if (canAct && !stopped && new URLSearchParams(window.location.search).get('pause') === 'all') setConfirm(true) } catch { /* no window */ } }, [canAct, stopped])
  if (!canAct || stopped) return null
  const stop = async () => {
    setBusy(true); setError(null)
    try { await storeFetch<StopResult>('/api/store/control-room/stop-all', { method: 'POST', body: { confirm: 'stop' } }); setConfirm(false); onChanged() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }
  return (
    <>
      <Button variant="secondary" onClick={() => { setError(null); setConfirm(true) }} disabled={busy} data-testid="stop-all">Stop all agents</Button>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Stop all agents?">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p className="app-muted">Every agent is paused now and every library agent is switched off. Nothing runs, reads or writes. Changes waiting for approval or already queued are cancelled, and queued emails are not sent. Authorizations are kept, so you can resume each agent from its page without granting again.</p>
          {error && <p role="alert" className="cc-need-error">{error}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Button onClick={() => void stop()} disabled={busy}>{busy ? 'Stopping…' : 'Yes, stop all agents'}</Button>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
