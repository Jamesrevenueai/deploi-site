'use client'
import { useState } from 'react'
import type { NeedsYouItem } from '@/lib/app/contract'
import { BotAvatar } from '@/components/app/BotAvatar'
import { Button, Card } from '@/components/app/ui'
import { storeFetch, StoreApiError } from '@/components/store/api'

export const FALLBACK_COLOR = '#5C5C70'

/** POST /api/app/needs-you/:id with the owner's decision (the existing approval logic decides it). */
export async function decide(id: string, decision: 'approve' | 'decline') {
  return storeFetch(`/api/app/needs-you/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } })
}

/**
 * One thing an agent needs the owner for: who, when, what it spotted and what it prepared, then the decision.
 * The primary button carries the item's own label (approve, or decline for an item that can only be declined);
 * once decided, `onDecided` refreshes the page so the item leaves this column.
 */
export function NeedsYouCard({ item, onDecided, onReply }: { item: NeedsYouItem; onDecided: () => void; onReply: (item: NeedsYouItem) => void }) {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const primary: 'approve' | 'decline' = item.decisions.includes('approve') ? 'approve' : 'decline'
  const canSecondary = item.secondaryAction !== null && primary === 'approve' && item.decisions.includes('decline')
  const run = async (d: 'approve' | 'decline') => {
    setBusy(d); setError(null)
    try { await decide(item.id, d); onDecided() } catch (e) { setError(e instanceof StoreApiError ? e.message : 'That did not go through. Try again.') } finally { setBusy(null) }
  }
  const titleId = `need-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return (
    <Card as="li" size="lg" aria-labelledby={titleId} data-testid="needs-you-card">
      <div className="cc-need-top">
        <BotAvatar color={item.agent.color ?? FALLBACK_COLOR} size={40} />
        <div style={{ minWidth: 0 }}>
          <p className="cc-need-name">{item.agent.name}</p>
          <p className="cc-need-time"><time dateTime={item.createdAt}>{item.ago}</time></p>
        </div>
      </div>
      <p className="cc-need-title" id={titleId}>{item.title}</p>
      <p className="cc-need-body">{item.explanation}</p>
      <div className="cc-need-actions">
        <Button variant="primary" onClick={() => void run(primary)} disabled={busy !== null}>{busy === primary ? 'Working…' : item.primaryAction}</Button>
        {canSecondary && <Button variant="secondary" onClick={() => void run('decline')} disabled={busy !== null}>{busy === 'decline' ? 'Working…' : item.secondaryAction}</Button>}
        <Button variant="text" onClick={() => onReply(item)} aria-label={`Reply to ${item.agent.name}`}>Reply</Button>
      </div>
      {error && <p className="cc-need-error" role="alert">{error}</p>}
    </Card>
  )
}
