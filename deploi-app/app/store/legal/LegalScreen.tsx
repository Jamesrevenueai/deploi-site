'use client'
/**
 * Clickwrap (/store/legal): each agreement the organization's product needs, shown in full with its
 * version and fingerprint, one checkbox per document, and an Accept button. Drafts are labelled as such:
 * nothing here is a published, reviewed agreement until counsel signs off.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type LegalDoc = { key: string; title: string; version: string; sha256: string; effectiveDate: string; draft: boolean; published: boolean; scope: 'org' | 'user'; accepted: boolean; acceptedAt: string | null; content: string }
type LegalResponse = { mode: 'off' | 'draft' | 'enforce'; product: 'commerce' | 'office'; documents: LegalDoc[]; missing: string[] }

export function LegalScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<LegalResponse>('/api/store/legal'), 'legal')
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null)
  const header = <PageHeader title="Agreements" sub="Read and accept the agreements before connecting a store, switching on or granting an agent, or starting a subscription." />
  if (loading && !data) return <>{header}<Loading label="Loading agreements" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const pending = data.documents.filter(d => !d.accepted)
  const chosen = pending.filter(d => ticked[d.key])
  async function accept() {
    setBusy(true); setNote(null)
    try {
      await storeFetch('/api/store/legal', { method: 'POST', body: { product: data!.product, agreed: true, documents: chosen.map(d => ({ key: d.key, version: d.version, sha256: d.sha256 })) } })
      setTicked({}); setNote({ tone: 'info', text: `Accepted ${chosen.map(d => d.title).join(', ')}.` })
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(false); await reload() }
  }
  return (
    <>
      {header}
      {data.documents.some(d => d.draft) && (
        <div className="mb-4"><Banner tone="warn"><strong>DRAFT — NOT REVIEWED BY COUNSEL.</strong> These are draft agreements for the private pilot. {data.mode === 'draft' ? 'Pilots accept the current draft text, and the acceptance is recorded as of a draft.' : data.mode === 'off' ? 'Acceptance is not required in this environment yet.' : ''}</Banner></div>
      )}
      <div aria-live="polite">{note && <div className="mb-4"><Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner></div>}</div>
      <ul className="grid gap-3" aria-label="Agreements">
        {data.documents.map(d => (
          <li key={d.key} className="au-panel p-4" data-doc={d.key}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[1.05rem]">{d.title}</h2>
              <Badge tone="muted">v{d.version}</Badge>
              {d.draft && <Badge tone="warn">Draft</Badge>}
              {d.accepted ? <Badge tone="ok">Accepted{d.acceptedAt ? ` ${d.acceptedAt.slice(0, 10)}` : ''}</Badge> : <Badge tone="none">Not accepted</Badge>}
              <span className="text-[12px] text-grey">{d.scope === 'org' ? 'for your organization' : 'for you personally'} · fingerprint {d.sha256.slice(0, 12)}</span>
            </div>
            <div className="mt-2"><Button size="sm" variant="ghost" type="button" onClick={() => setOpen(open === d.key ? null : d.key)} aria-expanded={open === d.key}>{open === d.key ? 'Hide text' : 'Read the full text'}</Button></div>
            {open === d.key && <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded border border-line p-3 text-[13px] leading-relaxed" tabIndex={0}>{d.content}</pre>}
            {!d.accepted && (
              <label className="mt-3 flex items-start gap-2 text-[14px]">
                <input type="checkbox" checked={Boolean(ticked[d.key])} onChange={e => setTicked(t => ({ ...t, [d.key]: e.target.checked }))} />
                <span>I have read the {d.title} (version {d.version}{d.draft ? ', draft' : ''}) and accept it{d.scope === 'org' ? ' on behalf of my organization, which I am authorized to bind' : ''}.</span>
              </label>
            )}
          </li>
        ))}
      </ul>
      {pending.length > 0 && <div className="mt-4"><Button type="button" disabled={busy || chosen.length === 0} onClick={accept}>{busy ? 'Saving' : `Accept ${chosen.length || ''} selected`.trim()}</Button></div>}
      {pending.length === 0 && <p className="mt-4 text-[14px] text-grey">Every required agreement is accepted. A new version will ask you again.</p>}
    </>
  )
}
