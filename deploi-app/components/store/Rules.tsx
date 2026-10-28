'use client'
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, NoStore, Panel } from './bits'
import { actorLabel, fmtTime } from './format'
import { OVERSELL_CHECK, type RuleView, type RulesResponse } from './types'

type SaveResult = { ok: true; rule: { version: number }; scan: { resourcesScanned?: number; issuesOpened?: number; issuesResolved?: number; proposalsCreated?: number; proposalsInvalidated?: number; error?: string } }

export function RulesScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<RulesResponse>('/api/store/rules'), 'rules')
  return (
    <>
      <PageHeader title="Rules" sub="Your rules decide what Deploi calls an error. Deploi never treats an intentional setting as a problem: checks that depend on your policy stay off until you turn them on." />
      {loading && !data ? <Loading label="Loading rules" /> : error && !data ? (error.status === 404 ? <NoStore /> : <ErrorState error={error} onRetry={reload} />) : data && (
        <>
          <div className="mb-5"><Banner icon="alert">Saving a rule re-reads your store and re-checks every product. Open proposals made under the old rule are replaced by new ones (or closed if the product no longer matches).</Banner></div>
          {data.rules.length === 0 ? <Empty title="No rules">This store has no checks yet.</Empty> : (
            <ul className="flex flex-col gap-4">
              {data.rules.map(r => <RuleCard key={r.id} rule={r} connectionId={data.connectionId} onSaved={reload} />)}
            </ul>
          )}
        </>
      )}
    </>
  )
}

function RuleCard({ rule, connectionId, onSaved }: { rule: RuleView; connectionId: string; onSaved: () => Promise<void> }) {
  const isOversell = rule.check_key === OVERSELL_CHECK
  const cfg = rule.config as { exemptTags?: string[]; exemptProductIds?: string[]; flagInStockVariants?: boolean }
  const [tags, setTags] = useState<string[]>(cfg.exemptTags ?? [])
  const [flagInStock, setFlagInStock] = useState<boolean>(cfg.flagInStockVariants ?? true)
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState<null | 'toggle' | 'save'>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [saved, setSaved] = useState<SaveResult | null>(null)
  const exemptCount = (cfg.exemptProductIds ?? []).length
  const dirty = isOversell && (JSON.stringify(tags) !== JSON.stringify(cfg.exemptTags ?? []) || flagInStock !== (cfg.flagInStockVariants ?? true))

  async function put(kind: 'toggle' | 'save', body: Record<string, unknown>) {
    setBusy(kind); setErr(null); setSaved(null)
    try {
      const r = await storeFetch<SaveResult>('/api/store/rules', { method: 'PUT', body: { connectionId, checkKey: rule.check_key, ...body } })
      setSaved(r)
      await onSaved()
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  function addTag() {
    const t = newTag.trim().toLowerCase()
    if (!t) return
    if (!tags.includes(t)) setTags([...tags, t])
    setNewTag('')
  }

  const toggleId = `toggle-${rule.id}`
  return (
    <li>
      <Panel>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[1.1rem]" id={`${toggleId}-label`}>{rule.title}</h2>
              <Badge tone={rule.enabled ? 'ok' : 'muted'}>{rule.enabled ? 'On' : 'Off'}</Badge>
              <Badge tone="muted">{rule.kind === 'correctable' ? 'Correctable' : 'Needs a person'}</Badge>
            </div>
            <p className="pt-2 text-[15px] text-ink">{rule.description}</p>
            <p className="pt-2 text-[14px] text-grey">{rule.whyItIsAnError}</p>
          </div>
          <button
            id={toggleId} type="button" role="switch" aria-checked={rule.enabled} aria-labelledby={`${toggleId}-label`}
            disabled={busy !== null}
            onClick={() => put('toggle', { enabled: !rule.enabled })}
            className={`relative mt-1 inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${rule.enabled ? 'border-white bg-white' : 'border-line-ghost bg-transparent'}`}
          >
            <span className="sr-only">{rule.enabled ? 'Turn off' : 'Turn on'}</span>
            <span aria-hidden="true" className={`inline-block h-6 w-6 rounded-full transition-transform ${rule.enabled ? 'translate-x-7 bg-black' : 'translate-x-1 bg-grey-h'}`} />
          </button>
        </div>

        {isOversell && (
          <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
            <div>
              <div className="text-[14px] font-medium text-ink" id={`${rule.id}-tags`}>Exempt tags</div>
              <p className="text-[13px] text-grey-h">Products with any of these tags may keep selling past zero (pre-orders, backorders, made-to-order).</p>
              <ul className="mt-2 flex flex-wrap gap-2" aria-labelledby={`${rule.id}-tags`}>
                {tags.length === 0 && <li className="text-[14px] text-grey">No exempt tags.</li>}
                {tags.map(t => (
                  <li key={t} className="badge" style={{ paddingRight: 4 }}>
                    {t}
                    <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter(x => x !== t))}>
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
              <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); addTag() }}>
                <Input aria-label="New exempt tag" placeholder="Add a tag, e.g. preorder" value={newTag} maxLength={60} onChange={e => setNewTag(e.target.value)} />
                <Button type="submit" variant="ghost" size="sm" disabled={!newTag.trim()} aria-label="Add exempt tag"><Icon name="plus" size={15} />Add</Button>
              </form>
            </div>
            <label className="flex items-start gap-3 text-[15px] text-ink cursor-pointer">
              <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={flagInStock} onChange={e => setFlagInStock(e.target.checked)} />
              <span>Also flag in-stock variants that would oversell later<span className="block text-[13px] text-grey-h">Variants that still have stock but would keep taking orders after the last unit sells (medium severity).</span></span>
            </label>
            <div className="text-[14px] text-grey">Exempt products: <span className="text-ink">{exemptCount}</span> <span className="text-grey-h">(added with &ldquo;Exempt this product&rdquo; on an issue)</span></div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => put('save', { config: { exemptTags: tags, exemptProductIds: cfg.exemptProductIds ?? [], flagInStockVariants: flagInStock } })} disabled={busy !== null || !dirty}>
                {busy === 'save' ? 'Saving and re-scanning…' : 'Save rule'}
              </Button>
              {dirty && <span className="text-[13px] text-warn">Unsaved changes</span>}
            </div>
          </div>
        )}

        <div aria-live="polite">
          {busy === 'toggle' && <p className="pt-3 text-[14px] text-grey">Saving and re-scanning…</p>}
          {err && <div className="mt-3"><Banner tone="warn"><strong>Not saved.</strong> {err.message}</Banner></div>}
          {saved && (
            <div className="mt-3">
              <Banner icon="check">
                <strong>Saved as version {saved.rule.version}.</strong>{' '}
                {saved.scan.error ? `The re-scan did not finish: ${saved.scan.error}.` : `Re-scanned ${saved.scan.resourcesScanned ?? 0} variants: ${saved.scan.issuesOpened ?? 0} new, ${saved.scan.issuesResolved ?? 0} resolved, ${saved.scan.proposalsInvalidated ?? 0} proposal${saved.scan.proposalsInvalidated === 1 ? '' : 's'} replaced or closed.`}
              </Banner>
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-3 text-[13px]">
          <Facts items={[['Version', rule.version], ['Updated', `${fmtTime(rule.updated_at)} by ${actorLabel(rule.updated_by)}`]]} />
        </div>
      </Panel>
    </li>
  )
}
