'use client'
/**
 * The structured task and permission form an agent is authorized from. Used to review a fresh draft
 * (create) and to edit an existing agent. Nothing here grants anything: submitting produces a policy
 * version that the merchant still has to grant after reading its summary.
 */
import { useId, useState, type ReactNode } from 'react'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input, Select } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { Panel } from './bits'
import { AGENT_CORRECTION_HELP, AGENT_CORRECTION_LABEL, AGENT_CORRECTION_TYPES, referenceKindLabel, type AgentCorrectionType } from './format'
import type { AgentPolicy, Connection, PublicationsResponse, ReferenceKindName, ReferenceSourceView, ReferencesResponse, TaskDraft, UploadReferenceResponse } from './types'

// ---------------------------------------------------------------- form state

export type AgentFormState = {
  connectionId: string
  types: Record<AgentCorrectionType, boolean>
  scopeMode: '' | 'all' | 'products' | 'tags'
  scopeProductIds: string
  scopeTags: string
  exceptTags: string
  exceptProductIds: string
  oversellExemptTags: string
  flagInStock: boolean
  pubId: string
  pubName: string
  pubSource: 'file' | 'tags'
  pubSourceId: string
  pubTags: string
  allowUnpublish: boolean
  priceSourceId: string
  priceField: boolean
  compareAtField: boolean
  maxChangePct: string
  noPriceLimit: boolean
  skipSale: boolean
  skuSourceId: string
  skuOverwrite: boolean
  scheduleKind: 'manual' | 'interval' | 'daily'
  everyHours: string
  dailyTime: string
  maxPerRun: string
  maxPerDay: string
  approvalMode: '' | 'review' | 'autonomous'
}

const DEFAULT_EXEMPT = ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']
const noTypes = (): Record<AgentCorrectionType, boolean> => ({ oversell_policy: false, publication: false, price: false, sku: false })
const pad2 = (n: number) => String(n).padStart(2, '0')
const list = (s: string) => [...new Set(s.split(/[,\n]/).map(x => x.trim()).filter(Boolean))]
const tagList = (s: string) => list(s).map(t => t.toLowerCase())

/** 1234 or gid://shopify/Product/1234 -> gid; anything else is reported */
function productIds(s: string): { ids: string[]; bad: string[] } {
  const ids: string[] = [], bad: string[] = []
  for (const x of list(s)) {
    if (/^\d+$/.test(x)) ids.push(`gid://shopify/Product/${x}`)
    else if (/^gid:\/\/shopify\/Product\/\d+$/.test(x)) ids.push(x)
    else bad.push(x)
  }
  return { ids: [...new Set(ids)], bad }
}
const showIds = (ids: string[]) => ids.map(id => id.replace(/^gid:\/\/shopify\/Product\//, '')).join(', ')

export function emptyForm(connectionId: string): AgentFormState {
  return {
    connectionId, types: noTypes(), scopeMode: '', scopeProductIds: '', scopeTags: '', exceptTags: '', exceptProductIds: '',
    oversellExemptTags: DEFAULT_EXEMPT.join(', '), flagInStock: true,
    pubId: '', pubName: '', pubSource: 'file', pubSourceId: '', pubTags: '', allowUnpublish: false,
    priceSourceId: '', priceField: true, compareAtField: false, maxChangePct: '20', noPriceLimit: false, skipSale: true,
    skuSourceId: '', skuOverwrite: false,
    scheduleKind: 'manual', everyHours: '6', dailyTime: '06:00', maxPerRun: '25', maxPerDay: '100', approvalMode: '',
  }
}

/** Prefill from the plain-English draft. Only what the text said is filled in; the rest stays for the merchant to choose. */
export function formFromDraft(d: TaskDraft, connectionId: string): AgentFormState {
  const f = emptyForm(connectionId)
  for (const t of d.correctionTypes) f.types[t] = true
  if (d.productScope.mode) f.scopeMode = d.productScope.mode
  f.scopeTags = d.productScope.tags.join(', ')
  f.exceptTags = d.exceptionTags.join(', ')
  if (d.approvalMode) f.approvalMode = d.approvalMode
  if (d.schedule?.kind === 'interval') { f.scheduleKind = 'interval'; f.everyHours = String(d.schedule.everyHours) }
  if (d.schedule?.kind === 'daily') { f.scheduleKind = 'daily'; f.dailyTime = `${pad2(d.schedule.hour)}:${pad2(d.schedule.minute)}` }
  if (d.priceFields.length) { f.priceField = d.priceFields.includes('price'); f.compareAtField = d.priceFields.includes('compareAtPrice') }
  if (d.publicationName) f.pubName = d.publicationName
  f.allowUnpublish = d.allowUnpublish
  f.skuOverwrite = d.allowSkuOverwrite
  return f
}

/** Prefill from an existing policy version (edit). */
export function formFromPolicy(p: AgentPolicy): AgentFormState {
  const f = emptyForm(p.connectionId)
  for (const t of p.correctionTypes) f.types[t] = true
  f.scopeMode = p.productScope.mode
  f.scopeProductIds = showIds(p.productScope.productIds ?? [])
  f.scopeTags = (p.productScope.tags ?? []).join(', ')
  f.exceptTags = (p.exceptions?.tags ?? []).join(', ')
  f.exceptProductIds = showIds(p.exceptions?.productIds ?? [])
  if (p.rules.oversell_policy) { f.oversellExemptTags = p.rules.oversell_policy.exemptTags.join(', '); f.flagInStock = p.rules.oversell_policy.flagInStockVariants }
  if (p.rules.publication) {
    const b = p.rules.publication
    f.pubId = b.publicationId; f.pubName = b.publicationName; f.pubSource = b.sourceId ? 'file' : 'tags'; f.pubSourceId = b.sourceId ?? ''; f.pubTags = b.publishTags.join(', '); f.allowUnpublish = b.allowUnpublish
  }
  if (p.rules.price) {
    const r = p.rules.price
    f.priceSourceId = r.sourceId; f.priceField = r.fields.includes('price'); f.compareAtField = r.fields.includes('compareAtPrice')
    f.noPriceLimit = r.maxChangePct === null; f.maxChangePct = r.maxChangePct === null ? '20' : String(r.maxChangePct); f.skipSale = r.skipVariantsOnSale
  }
  if (p.rules.sku) { f.skuSourceId = p.rules.sku.sourceId; f.skuOverwrite = p.rules.sku.allowOverwrite }
  f.scheduleKind = p.schedule.kind
  if (p.schedule.kind === 'interval') f.everyHours = String(p.schedule.everyHours)
  if (p.schedule.kind === 'daily') f.dailyTime = `${pad2(p.schedule.hour)}:${pad2(p.schedule.minute)}`
  f.maxPerRun = String(p.limits.maxChangesPerRun)
  f.maxPerDay = String(p.limits.maxChangesPerDay)
  f.approvalMode = p.approvalMode
  return f
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)

/**
 * Form -> policy, with every problem in words. A policy is only produced when nothing is missing:
 * a vague task ("fix my store") leaves correction types, product scope and approval mode unchosen,
 * and the form refuses to continue until the merchant picks them.
 */
export function policyFromForm(f: AgentFormState, timezone: string): { policy: AgentPolicy | null; problems: string[] } {
  const problems: string[] = []
  const types = AGENT_CORRECTION_TYPES.filter(t => f.types[t])
  if (!f.connectionId) problems.push('Choose the store.')
  if (!types.length) problems.push('Choose at least one correction type.')
  if (!f.scopeMode) problems.push('Choose which products the agent may work on.')
  const scopeIds = productIds(f.scopeProductIds), exceptIds = productIds(f.exceptProductIds)
  if (f.scopeMode === 'products' && !scopeIds.ids.length) problems.push('List at least one product ID for the product scope.')
  if (f.scopeMode === 'products' && scopeIds.bad.length) problems.push(`These are not Shopify product IDs: ${scopeIds.bad.join(', ')}.`)
  if (f.scopeMode === 'tags' && !tagList(f.scopeTags).length) problems.push('List at least one tag for the product scope.')
  if (exceptIds.bad.length) problems.push(`These exception entries are not Shopify product IDs: ${exceptIds.bad.join(', ')}.`)
  if (f.types.publication) {
    if (!f.pubId) problems.push('Product publication: choose the sales channel.')
    if (f.pubSource === 'file' && !f.pubSourceId) problems.push('Product publication: choose or upload a publication list.')
    if (f.pubSource === 'tags' && !tagList(f.pubTags).length) problems.push('Product publication: list the tags whose products should be published.')
  }
  if (f.types.price) {
    if (!f.priceSourceId) problems.push('Prices: choose or upload a price list.')
    if (!f.priceField && !f.compareAtField) problems.push('Prices: choose at least one field (price or compare-at price).')
    const pct = Number(f.maxChangePct)
    if (!f.noPriceLimit && (!f.maxChangePct.trim() || !Number.isFinite(pct) || pct < 0 || pct > 1000)) problems.push('Prices: the largest change must be a number from 0 to 1000 (%).')
  }
  if (f.types.sku && !f.skuSourceId) problems.push('SKUs: choose or upload a SKU mapping.')
  const everyHours = int(f.everyHours)
  if (f.scheduleKind === 'interval' && !(everyHours >= 1 && everyHours <= 168)) problems.push('Schedule: every 1 to 168 hours.')
  const tm = /^(\d{2}):(\d{2})$/.exec(f.dailyTime)
  if (f.scheduleKind === 'daily' && (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59)) problems.push('Schedule: choose a time of day.')
  const perRun = int(f.maxPerRun), perDay = int(f.maxPerDay)
  if (!(perRun >= 1 && perRun <= 500)) problems.push('Limits: changes per run must be 1 to 500.')
  if (!(perDay >= 1 && perDay <= 5000)) problems.push('Limits: changes per day must be 1 to 5000.')
  if (!f.approvalMode) problems.push('Choose how changes are approved: review each change, or act within limits.')
  if (problems.length) return { policy: null, problems }

  const rules: AgentPolicy['rules'] = {}
  if (f.types.oversell_policy) rules.oversell_policy = { exemptTags: tagList(f.oversellExemptTags), flagInStockVariants: f.flagInStock }
  if (f.types.publication) rules.publication = { publicationId: f.pubId, publicationName: f.pubName || 'Sales channel', sourceId: f.pubSource === 'file' ? f.pubSourceId : null, publishTags: f.pubSource === 'tags' ? tagList(f.pubTags) : [], allowUnpublish: f.allowUnpublish }
  if (f.types.price) rules.price = { sourceId: f.priceSourceId, fields: [...(f.priceField ? ['price' as const] : []), ...(f.compareAtField ? ['compareAtPrice' as const] : [])], maxChangePct: f.noPriceLimit ? null : Number(f.maxChangePct), skipVariantsOnSale: f.skipSale }
  if (f.types.sku) rules.sku = { sourceId: f.skuSourceId, allowOverwrite: f.skuOverwrite }
  const policy: AgentPolicy = {
    connectionId: f.connectionId,
    correctionTypes: types,
    productScope: { mode: f.scopeMode as 'all' | 'products' | 'tags', productIds: f.scopeMode === 'products' ? scopeIds.ids : [], tags: f.scopeMode === 'tags' ? tagList(f.scopeTags) : [] },
    exceptions: { productIds: exceptIds.ids, tags: tagList(f.exceptTags) },
    rules,
    limits: { maxChangesPerRun: perRun, maxChangesPerDay: perDay },
    approvalMode: f.approvalMode as 'review' | 'autonomous',
    schedule: f.scheduleKind === 'manual' ? { kind: 'manual' } : f.scheduleKind === 'interval' ? { kind: 'interval', everyHours } : { kind: 'daily', hour: Number(tm![1]), minute: Number(tm![2]), timezone },
  }
  return { policy, problems: [] }
}

// ---------------------------------------------------------------- form

type Props = {
  value: AgentFormState
  onChange: (f: AgentFormState) => void
  connections: Connection[]
  timezone: string
  /** connection can only be chosen on create */
  lockConnection?: boolean
  showProblems: boolean
}

export function AgentPolicyForm({ value: f, onChange, connections, timezone, lockConnection, showProblems }: Props) {
  const set = (patch: Partial<AgentFormState>) => onChange({ ...f, ...patch })
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const refs = useLoad(() => f.connectionId ? storeFetch<ReferencesResponse>(`/api/store/references?connection=${encodeURIComponent(f.connectionId)}`) : Promise.resolve(null), `refs:${f.connectionId}`)
  const pubs = useLoad(() => f.connectionId && f.types.publication ? storeFetch<PublicationsResponse>(`/api/store/publications?connection=${encodeURIComponent(f.connectionId)}`) : Promise.resolve(null), `pubs:${f.connectionId}:${f.types.publication}`)
  const { problems } = policyFromForm(f, timezone)
  const references = refs.data?.references ?? []

  return (
    <div className="flex flex-col gap-4">
      <FormBlock title="Store" n={1}>
        <label className="block text-[14px] text-grey" htmlFor={id('store')}>Connected store</label>
        <Select id={id('store')} value={f.connectionId} disabled={lockConnection} onChange={e => set({ connectionId: e.target.value, priceSourceId: '', skuSourceId: '', pubSourceId: '', pubId: '' })}>
          {connections.map(c => <option key={c.id} value={c.id}>{c.display_name ?? c.external_id}</option>)}
        </Select>
        {lockConnection && <p className="text-[13px] text-grey-h">An agent stays on the store it was created for.</p>}
      </FormBlock>

      <FormBlock title="What it may correct" n={2} sub="Only the corrections you tick here are authorized. Each one writes only its own field.">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Correction types</legend>
          {AGENT_CORRECTION_TYPES.map(t => (
            <label key={t} className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
              <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={f.types[t]} onChange={e => set({ types: { ...f.types, [t]: e.target.checked } })} />
              <span>{AGENT_CORRECTION_LABEL[t]}<span className="block text-[13px] text-grey-h">{AGENT_CORRECTION_HELP[t]}</span></span>
            </label>
          ))}
        </fieldset>
      </FormBlock>

      <FormBlock title="Which products" n={3} sub="The agent never reads past or changes products outside this scope. Exceptions always win.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Product scope</legend>
          {([['all', 'All products in the store'], ['products', 'Specific products (by product ID)'], ['tags', 'Products with any of these tags']] as const).map(([m, l]) => (
            <label key={m} className="flex cursor-pointer items-center gap-3 text-[15px] text-ink">
              <input type="radio" name={id('scope')} className="h-5 w-5 accent-white" checked={f.scopeMode === m} onChange={() => set({ scopeMode: m })} />{l}
            </label>
          ))}
        </fieldset>
        {f.scopeMode === 'products' && <TextField id={id('scope-ids')} label="Product IDs" hint="Comma or line separated, e.g. 1001, 1002 (the number at the end of the product's admin URL)." value={f.scopeProductIds} onChange={v => set({ scopeProductIds: v })} />}
        {f.scopeMode === 'tags' && <TextField id={id('scope-tags')} label="Tags in scope" hint="Comma separated. Matching ignores upper and lower case." value={f.scopeTags} onChange={v => set({ scopeTags: v })} />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField id={id('ex-tags')} label="Exception tags (never touched)" hint="Comma separated, e.g. wholesale, do-not-change." value={f.exceptTags} onChange={v => set({ exceptTags: v })} />
          <TextField id={id('ex-ids')} label="Exception product IDs (never touched)" hint="Comma separated product IDs." value={f.exceptProductIds} onChange={v => set({ exceptProductIds: v })} />
        </div>
      </FormBlock>

      {(f.types.oversell_policy || f.types.publication || f.types.price || f.types.sku) && (
        <FormBlock title="Rules and reference files" n={4} sub="Files are treated as data only: Deploi reads the columns it knows and ignores everything else. Nothing in a file can widen what the agent may do.">
          {refs.error && <Banner tone="warn"><strong>Could not load your files.</strong> {refs.error.message}</Banner>}
          {f.types.oversell_policy && (
            <RuleCard title={AGENT_CORRECTION_LABEL.oversell_policy}>
              <TextField id={id('os-tags')} label="Exempt tags (pre-order, backorder and similar)" hint="Products with any of these tags may keep selling past zero and are never changed." value={f.oversellExemptTags} onChange={v => set({ oversellExemptTags: v })} />
              <Check checked={f.flagInStock} onChange={v => set({ flagInStock: v })} label="Also correct in-stock variants that would oversell after the last unit sells" />
            </RuleCard>
          )}
          {f.types.publication && (
            <RuleCard title={AGENT_CORRECTION_LABEL.publication}>
              <label className="block text-[14px] text-grey" htmlFor={id('pub')}>Sales channel</label>
              <Select id={id('pub')} value={f.pubId} onChange={e => set({ pubId: e.target.value, pubName: pubs.data?.publications.find(p => p.id === e.target.value)?.title ?? '' })}>
                <option value="">{pubs.loading ? 'Loading sales channels…' : 'Choose a sales channel'}</option>
                {(pubs.data?.publications ?? []).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
              {pubs.error && <p className="text-[13px] text-warn">Could not read the store&apos;s sales channels: {pubs.error.message}</p>}
              {f.pubName && !f.pubId && <p className="text-[13px] text-grey-h">Your task mentioned {f.pubName}; choose it above to confirm.</p>}
              <fieldset className="flex flex-col gap-2">
                <legend className="text-[14px] text-grey">What says a product should be published</legend>
                <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('pubsrc')} className="h-5 w-5 accent-white" checked={f.pubSource === 'file'} onChange={() => set({ pubSource: 'file' })} />A publication list file</label>
                <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('pubsrc')} className="h-5 w-5 accent-white" checked={f.pubSource === 'tags'} onChange={() => set({ pubSource: 'tags' })} />Publish products with these tags</label>
              </fieldset>
              {f.pubSource === 'file'
                ? <ReferencePicker kind="publication_list" value={f.pubSourceId} onChange={v => set({ pubSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
                : <TextField id={id('pub-tags')} label="Publish tags" hint="Comma separated." value={f.pubTags} onChange={v => set({ pubTags: v })} />}
              <Check checked={f.allowUnpublish} onChange={v => set({ allowUnpublish: v })} label="Also allow unpublishing products the list says should not be published" />
            </RuleCard>
          )}
          {f.types.price && (
            <RuleCard title={AGENT_CORRECTION_LABEL.price}>
              <ReferencePicker kind="price_list" value={f.priceSourceId} onChange={v => set({ priceSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
              <fieldset className="flex flex-col gap-2">
                <legend className="text-[14px] text-grey">Fields it may set (store currency only)</legend>
                <Check checked={f.priceField} onChange={v => set({ priceField: v })} label="Price" />
                <Check checked={f.compareAtField} onChange={v => set({ compareAtField: v })} label="Compare-at price" />
              </fieldset>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextField id={id('pct')} label="Largest change it may make without asking (%)" hint="Larger changes always wait for your approval." value={f.maxChangePct} onChange={v => set({ maxChangePct: v })} disabled={f.noPriceLimit} inputMode="decimal" />
              </div>
              <Check checked={f.noPriceLimit} onChange={v => set({ noPriceLimit: v })} label="No limit on the size of a price change" />
              <Check checked={f.skipSale} onChange={v => set({ skipSale: v })} label="Protect sale prices (leave variants with a compare-at price above the price alone)" />
            </RuleCard>
          )}
          {f.types.sku && (
            <RuleCard title={AGENT_CORRECTION_LABEL.sku}>
              <ReferencePicker kind="sku_mapping" value={f.skuSourceId} onChange={v => set({ skuSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
              <Check checked={f.skuOverwrite} onChange={v => set({ skuOverwrite: v })} label="Also correct existing SKUs that differ from the mapping (otherwise it only fills missing SKUs)" />
            </RuleCard>
          )}
        </FormBlock>
      )}

      <FormBlock title="When it runs" n={5}>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Schedule</legend>
          <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'manual'} onChange={() => set({ scheduleKind: 'manual' })} />Only when I press Run now</label>
          <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[15px] text-ink">
            <input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'interval'} onChange={() => set({ scheduleKind: 'interval' })} />Every
            <span className="w-20"><Input aria-label="Hours between runs" inputMode="numeric" value={f.everyHours} onFocus={() => set({ scheduleKind: 'interval' })} onChange={e => set({ everyHours: e.target.value, scheduleKind: 'interval' })} /></span>hours
          </label>
          <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[15px] text-ink">
            <input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'daily'} onChange={() => set({ scheduleKind: 'daily' })} />Daily at
            <span className="w-32"><Input type="time" aria-label="Time of day" value={f.dailyTime} onChange={e => set({ dailyTime: e.target.value, scheduleKind: 'daily' })} /></span>
            <span className="text-[13px] text-grey-h">({timezone})</span>
          </label>
        </fieldset>
      </FormBlock>

      <FormBlock title="How changes are approved" n={6}>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Approval mode</legend>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="radio" name={id('mode')} className="mt-1 h-5 w-5 accent-white" checked={f.approvalMode === 'review'} onChange={() => set({ approvalMode: 'review' })} />
            <span>Review each change<span className="block text-[13px] text-grey-h">The agent finds problems and proposes exact changes. Nothing is written until you approve each one.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="radio" name={id('mode')} className="mt-1 h-5 w-5 accent-white" checked={f.approvalMode === 'autonomous'} onChange={() => set({ approvalMode: 'autonomous' })} />
            <span>Authorized to act within limits<span className="block text-[13px] text-grey-h">Changes this authorization covers are made without asking, up to the limits below. Anything it does not cover (outside the scope, over a limit, ambiguous) waits for you.</span></span>
          </label>
        </fieldset>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField id={id('per-run')} label="Changes per run, at most" value={f.maxPerRun} onChange={v => set({ maxPerRun: v })} inputMode="numeric" />
          <TextField id={id('per-day')} label="Changes per day, at most" value={f.maxPerDay} onChange={v => set({ maxPerDay: v })} inputMode="numeric" />
        </div>
        <p className="text-[13px] text-grey-h">Limits apply to changes made without asking. Changes beyond them wait for your approval.</p>
      </FormBlock>

      {showProblems && problems.length > 0 && (
        <div role="alert">
          <Banner tone="warn">
            <strong>Still to choose before this can be reviewed:</strong>
            <ul className="mt-1 list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
          </Banner>
        </div>
      )}
    </div>
  )
}

function FormBlock({ title, sub, n, children }: { title: string; sub?: string; n: number; children: ReactNode }) {
  return (
    <Panel>
      <h3 className="text-[1.05rem]"><span className="text-grey-h">{n}.</span> {title}</h3>
      {sub && <p className="pt-1 text-[13px] text-grey-h">{sub}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </Panel>
  )
}

function RuleCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="text-[15px] font-medium text-ink">{title}</div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </div>
  )
}

function TextField({ id, label, hint, value, onChange, disabled, inputMode }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; disabled?: boolean; inputMode?: 'numeric' | 'decimal' }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[14px] text-grey" htmlFor={id}>{label}</label>
      <Input id={id} value={value} disabled={disabled} inputMode={inputMode} onChange={e => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <span id={`${id}-hint`} className="text-[13px] text-grey-h">{hint}</span>}
    </div>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
      <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------- reference files

type UploadState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; r: UploadReferenceResponse } | { kind: 'error'; e: StoreApiError }

export function ReferencePicker({ kind, value, onChange, references, connectionId, onUploaded }: {
  kind: ReferenceKindName; value: string; onChange: (id: string) => void; references: ReferenceSourceView[]; connectionId: string; onUploaded: () => Promise<void>
}) {
  const uid = useId()
  const options = references.filter(r => r.kind === kind)
  const selected = options.find(r => r.id === value)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [up, setUp] = useState<UploadState>({ kind: 'idle' })
  const label = referenceKindLabel(kind)

  async function upload() {
    if (!file) return
    setUp({ kind: 'busy' })
    try {
      const csv = await file.text()
      const r = await storeFetch<UploadReferenceResponse>('/api/store/references', { method: 'POST', body: { connectionId, kind, name: name.trim() || file.name.replace(/\.csv$/i, ''), csv } })
      setUp({ kind: 'done', r })
      await onUploaded()
      onChange(r.source.id)
      setFile(null)
    } catch (e) { setUp({ kind: 'error', e: asApiError(e) }) }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[14px] text-grey" htmlFor={`${uid}-sel`}>{label}</label>
      <Select id={`${uid}-sel`} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{options.length ? `Choose a ${label.toLowerCase()}` : `No ${label.toLowerCase()} uploaded yet`}</option>
        {options.map(r => <option key={r.id} value={r.id}>{r.name} · version {r.version} · {r.row_count} row{r.row_count === 1 ? '' : 's'}</option>)}
      </Select>
      {selected && (
        <div className="flex flex-wrap gap-2 text-[13px]">
          <Badge tone="muted">{selected.row_count} row{selected.row_count === 1 ? '' : 's'} read</Badge>
          {selected.error_count > 0 && <Badge tone="warn">{selected.error_count} row{selected.error_count === 1 ? '' : 's'} skipped</Badge>}
          {selected.ambiguous_keys > 0 && <Badge tone="warn">{selected.ambiguous_keys} ambiguous (blocked, never guessed)</Badge>}
        </div>
      )}
      <details className="rounded-[14px] border border-line p-3">
        <summary className="cursor-pointer text-[14px] text-ink">Upload a {label.toLowerCase()} (CSV)</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[13px] text-grey-h">
            Uploading a file with the same name as an existing one replaces it with a new version; changes based on the old version are recomputed.{' '}
            <a href={`/api/store/references?template=${kind}`} download className="text-ink underline">Download the {label.toLowerCase()} template</a>
          </p>
          <label className="text-[14px] text-grey" htmlFor={`${uid}-file`}>CSV file</label>
          <input id={`${uid}-file`} type="file" accept=".csv,text/csv" className="text-[14px] text-grey file:mr-3 file:rounded-full file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-ink"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setUp({ kind: 'idle' }) }} />
          <label className="text-[14px] text-grey" htmlFor={`${uid}-name`}>Name</label>
          <Input id={`${uid}-name`} value={name} maxLength={120} placeholder={file ? file.name.replace(/\.csv$/i, '') : `e.g. ${label} autumn`} onChange={e => setName(e.target.value)} />
          <div><Button type="button" variant="ghost" size="sm" onClick={upload} disabled={!file || up.kind === 'busy'} aria-label={`Upload ${label.toLowerCase()}`}><Icon name="upload" size={15} />{up.kind === 'busy' ? 'Uploading…' : 'Upload'}</Button></div>
          <div aria-live="polite">
            {up.kind === 'error' && <Banner tone="warn"><strong>Not uploaded.</strong> {up.e.message}</Banner>}
            {up.kind === 'done' && (
              <Banner icon="check">
                <strong>{up.r.unchanged ? 'Same as the current version; nothing changed.' : `Uploaded "${up.r.source.name}" as version ${up.r.source.version}.`}</strong>{' '}
                {up.r.source.row_count} row{up.r.source.row_count === 1 ? '' : 's'} read{up.r.source.ambiguous_keys ? `, ${up.r.source.ambiguous_keys} ambiguous (the agent blocks on these instead of guessing)` : ''}.
                {up.r.rowErrors.length > 0 && (
                  <span className="block pt-1">{up.r.rowErrors.length} row{up.r.rowErrors.length === 1 ? '' : 's'} skipped:
                    <ul className="list-disc pl-5">{up.r.rowErrors.slice(0, 10).map(e => <li key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</li>)}</ul>
                  </span>
                )}
              </Banner>
            )}
          </div>
        </div>
      </details>
    </div>
  )
}
