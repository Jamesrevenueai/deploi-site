'use client'
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Field, Select } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, Panel, Section, SyntheticBadge, useStore } from './bits'
import { CONNECTION_STATUS_LABEL, PLATFORM_LABEL, fmtAgo, fmtTime } from './format'
import type { Connection, IssuesResponse, IssueView, OverviewResponse } from './types'

const PLANNED_COPY: Record<string, string> = {
  woocommerce: 'Planned. Deploi will read WooCommerce products and stock settings with the same approve-then-verify workflow. Not available yet.',
  amazon: 'Planned. Deploi will read Amazon Seller Central listings with the same approve-then-verify workflow. Not available yet.',
}

export function ConnectScreen() {
  const { embedded } = useStore()
  const { data, error, loading, reload } = useLoad(async () => {
    const o = await storeFetch<OverviewResponse>('/api/store/overview')
    const synthetic = o.connections.some(c => c.is_synthetic)
    const issues = synthetic ? await storeFetch<IssuesResponse>('/api/store/issues?status=live').catch(() => null) : null
    return { o, issues: issues?.issues ?? [] }
  }, 'connect')

  if (loading && !data) return <><PageHeader title="Store" /><Loading label="Loading store connection" /></>
  if (error && !data) return <><PageHeader title="Store" /><ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const { o, issues } = data
  const shopify = o.connections.find(c => c.platform === 'shopify')
  const planned = o.platforms.filter(p => p.status === 'planned')

  return (
    <>
      <PageHeader title="Store" sub="The store Deploi is connected to and what it is allowed to do there. One store is all Deploi needs." />
      {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}

      {o.connections.map(c => <ConnectionDetails key={c.id} c={c} />)}

      {!shopify && !embedded && (
        <Panel className="mt-4">
          <div className="flex flex-wrap items-center gap-2"><span className="text-ink font-medium">Shopify</span><Badge tone="ok">Available</Badge></div>
          <p className="pt-2 text-[15px] text-grey">
            The Deploi Shopify app installs from your Shopify admin, not from this page. In your Shopify admin, open Apps, find Deploi and install it; Shopify asks you to approve the permissions it needs. When the installation finishes, your store appears here.
          </p>
          <p className="pt-2 text-[14px] text-grey-h">Install from your Shopify admin → Apps → Deploi</p>
        </Panel>
      )}

      <Section title="Other platforms">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {planned.map(p => (
            <Panel key={p.platform}>
              <div className="flex flex-wrap items-center gap-2"><span className="text-ink font-medium">{PLATFORM_LABEL[p.platform] ?? p.platform}</span><Badge tone="muted">Planned</Badge></div>
              <p className="pt-2 text-[14px] text-grey">{PLANNED_COPY[p.platform] ?? 'Planned. Not available yet.'}</p>
            </Panel>
          ))}
        </div>
      </Section>

      {o.connections.filter(c => c.is_synthetic).map(c => <DemoControls key={c.id} conn={c} issues={issues} onDone={reload} canAct={o.actor.canApprove} />)}
    </>
  )
}

export function ConnectionDetails({ c }: { c: Connection }) {
  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="glass" style={{ fontSize: 13, padding: '6px 12px' }}><Icon name="building" size={14} />{PLATFORM_LABEL[c.platform] ?? c.platform}</span>
        <Badge tone={c.status === 'active' ? 'ok' : 'warn'}>{CONNECTION_STATUS_LABEL[c.status] ?? c.status}</Badge>
        {c.is_synthetic && <SyntheticBadge />}
      </div>
      <div className="mt-3 text-ink font-medium break-all">{c.display_name ?? c.external_id}</div>
      <div className="mt-4">
        <Facts items={[
          ['Store domain', <span key="d" className="break-all">{c.external_id}</span>],
          ['Permissions granted', c.scopes.length ? <span key="s" className="inline-flex flex-wrap gap-1.5">{c.scopes.map(s => <Badge key={s} tone="muted">{s}</Badge>)}</span> : 'none'],
          ['API version', c.api_version ?? 'Not reported'],
          ['Installed', fmtTime(c.installed_at)],
          ['Last scan', c.last_scan_at ? fmtAgo(c.last_scan_at) : 'Not scanned yet'],
        ]} />
      </div>
      {c.status !== 'active' && <div className="mt-4"><Banner tone="warn"><strong>Blocked.</strong> This connection is {CONNECTION_STATUS_LABEL[c.status]?.toLowerCase() ?? c.status}. Deploi cannot read or change the store until the app is installed again from the Shopify admin.</Banner></div>}
      <p className="pt-4 text-[13px] text-grey-h">Deploi reads products, inventory, locations and sales channels, and writes only the changes you or an agent you authorized approve: a variant&rsquo;s out-of-stock setting, whether a product is published on a sales channel, a variant&rsquo;s price or compare-at price, and a variant&rsquo;s SKU. It never changes stock counts, product status, customers or orders.</p>
    </Panel>
  )
}

type Done = { ok: true; message: string } | { ok: false; e: StoreApiError }
const FAULTS: [string, string][] = [
  ['user_error', 'Store refuses the write (Failed)'],
  ['lost_response_applied', 'Response lost after the write applied'],
  ['lost_response_not_applied', 'Response lost and the write did not apply'],
  ['write_does_not_stick', 'Write accepted but a fresh read does not show it'],
  ['read_error', 'Read fails before writing'],
]

function DemoControls({ conn, issues, onDone, canAct }: { conn: Connection; issues: IssueView[]; onDone: () => Promise<void>; canAct: boolean }) {
  const variants = issues.filter(i => i.resource_type === 'variant')
  const unique = [...new Map(variants.map(i => [i.resource_id, i])).values()]
  const [variantId, setVariantId] = useState(unique[0]?.resource_id ?? '')
  const [what, setWhat] = useState<'policy_deny' | 'policy_continue' | 'tag_preorder' | 'tags_clear'>('policy_deny')
  const [mode, setMode] = useState('user_error')
  const [busy, setBusy] = useState<null | string>(null)
  const [done, setDone] = useState<Done | null>(null)
  const selected = unique.find(i => i.resource_id === variantId)

  async function post(kind: string, body: Record<string, unknown>, message: string) {
    setBusy(kind); setDone(null)
    try {
      await storeFetch('/api/store/demo', { method: 'POST', body: { connectionId: conn.id, ...body } })
      setDone({ ok: true, message })
      await onDone()
    } catch (e) { setDone({ ok: false, e: asApiError(e) }) } finally { setBusy(null) }
  }

  function outsideChange() {
    if (!variantId) return
    const curTags = Array.isArray(selected?.evidence.productTags) ? (selected!.evidence.productTags as unknown[]).map(String) : []
    const body: Record<string, unknown> = { action: 'external_change', variantId }
    let label = ''
    if (what === 'policy_deny') { body.inventoryPolicy = 'DENY'; label = '“Continue selling when out of stock” turned off outside Deploi' }
    if (what === 'policy_continue') { body.inventoryPolicy = 'CONTINUE'; label = '“Continue selling when out of stock” turned on outside Deploi' }
    if (what === 'tag_preorder') { body.tags = [...new Set([...curTags, 'preorder'])]; label = 'Tag “preorder” added to the product outside Deploi' }
    if (what === 'tags_clear') { body.tags = []; label = 'All product tags removed outside Deploi' }
    void post('external', body, `${label}. Deploi has not scanned since, so an open proposal for it is now out of date: approving it shows what happens.`)
  }

  return (
    <Section id="demo" title={<span className="inline-flex flex-wrap items-center gap-2">Demo controls <Badge tone="warn">Synthetic store only</Badge></span>}
      sub="These controls exist only for synthetic test stores. They change the simulated store directly, as the merchant or another app would, or make the simulated platform misbehave once.">
      <Panel tone="warn">
        <div aria-live="polite">
          {done?.ok && <div className="mb-4"><Banner icon="check"><strong>Done.</strong> {done.message}</Banner></div>}
          {done && !done.ok && <div className="mb-4"><ErrorState error={done.e} /></div>}
        </div>
        {!canAct && <div className="mb-4"><Banner tone="warn"><strong>Read-only.</strong> Staff cannot use demo controls on a merchant store.</Banner></div>}

        <div className="flex flex-col gap-6">
          <div>
            <h3 className="text-[1rem]">Reset the store</h3>
            <p className="pt-1 text-[14px] text-grey">Restores the synthetic catalogue to its starting state. Issues update on the next scan.</p>
            <Button className="mt-3" variant="ghost" size="sm" disabled={!canAct || busy !== null} onClick={() => post('reset', { action: 'reset' }, 'The synthetic store was reset. Run a scan to see the starting issues.')} aria-label="Reset the synthetic store">
              <Icon name="bolt" size={15} />{busy === 'reset' ? 'Resetting…' : 'Reset synthetic store'}
            </Button>
          </div>

          <div className="border-t border-line pt-5">
            <h3 className="text-[1rem]">Make an outside change</h3>
            <p className="pt-1 text-[14px] text-grey">Changes a variant without telling Deploi. Approving its open proposal afterwards ends Not run (Stale), with nothing written.</p>
            {unique.length === 0 ? <p className="pt-3 text-[14px] text-grey-h">No open issues to pick a variant from. Run a scan first.</p> : (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Variant" htmlFor="demo-variant">
                  <Select id="demo-variant" value={variantId} onChange={e => setVariantId(e.target.value)}>
                    {unique.map(i => <option key={i.resource_id} value={i.resource_id}>{i.resource_label ?? i.resource_id}</option>)}
                  </Select>
                </Field>
                <Field label="Change" htmlFor="demo-change">
                  <Select id="demo-change" value={what} onChange={e => setWhat(e.target.value as typeof what)}>
                    <option value="policy_deny">Inventory policy: stop selling at zero</option>
                    <option value="policy_continue">Inventory policy: continue selling at zero</option>
                    <option value="tag_preorder">Tags: add &ldquo;preorder&rdquo;</option>
                    <option value="tags_clear">Tags: remove all</option>
                  </Select>
                </Field>
                <div className="md:col-span-2">
                  <Button variant="ghost" size="sm" disabled={!canAct || busy !== null || !variantId} onClick={outsideChange} aria-label="Apply the outside change to the synthetic store">
                    <Icon name="edit" size={15} />{busy === 'external' ? 'Changing…' : 'Make outside change'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-line pt-5">
            <h3 className="text-[1rem]">Inject a platform fault</h3>
            <p className="pt-1 text-[14px] text-grey">The next matching call to the synthetic store misbehaves once. Then approve a change to see the outcome.</p>
            <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end">
              <div className="md:flex-1">
                <Field label="Fault" htmlFor="demo-fault">
                  <Select id="demo-fault" value={mode} onChange={e => setMode(e.target.value)}>
                    {FAULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
              </div>
              <Button variant="ghost" size="sm" disabled={!canAct || busy !== null} aria-label="Inject the selected fault"
                onClick={() => post('fault', { action: 'fault', mode, ...(mode === 'read_error' ? { op: 'DeploiNodes' } : {}) }, `Fault armed: ${FAULTS.find(f => f[0] === mode)?.[1]}. It applies to the next ${mode === 'read_error' ? 'fresh read' : 'write'}.`)}>
                <Icon name="alert" size={15} />{busy === 'fault' ? 'Arming…' : 'Inject fault'}
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </Section>
  )
}
