'use client'
/** Integrations: every tool Deploi connects to, with its honest status, what it is used for and what it grants. */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { useProbes, type Availability } from './probe'
import { INTEGRATION_WORDS, type Integration, type IntegrationStatus, type IntegrationsResponse } from './types'

const GROUPS: { key: Integration['group']; title: string; sub: string }[] = [
  { key: 'commerce', title: 'Deploi Commerce', sub: 'Your store. Connect one platform; that is all Deploi Commerce needs.' },
  { key: 'email', title: 'Email', sub: 'Where agents write from. Connecting an account authorizes no agent; each agent gets its own email permission.' },
  { key: 'office', title: 'Deploi Office', sub: 'CRM and calendar for lead follow-up and scheduling.' },
  { key: 'billing', title: 'Billing', sub: 'Your subscription.' },
]

/** A page that is not deployed yet turns any status into "not available yet" and hides its link. */
export function effectiveStatus(i: Integration, availability: Availability | undefined): { status: IntegrationStatus; linkable: boolean } {
  if (!i.probe) return { status: i.status, linkable: true }
  if (availability === 'missing') return { status: i.status === 'connected' ? 'connected' : 'not_available', linkable: false }
  return { status: i.status, linkable: availability === 'available' }
}

export function IntegrationsScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<IntegrationsResponse>('/api/store/control-room/integrations'), 'integrations')
  const pages = [...new Set((data?.integrations ?? []).filter(i => i.probe).map(i => i.href))]
  const probes = useProbes(pages)
  const header = <PageHeader title="Integrations" sub="One place for every connection. Each says what it is used for and what it lets Deploi do. Connecting a tool never lets an agent act: agents get permissions only when you grant them." />
  if (loading && !data) return <>{header}<Loading label="Loading integrations" rows={4} /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  return (
    <>
      {header}
      {GROUPS.map(g => {
        const items = data.integrations.filter(i => i.group === g.key)
        if (!items.length) return null
        return (
          <Section key={g.key} id={`int-${g.key}`} title={g.title} sub={g.sub}>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {items.map(i => {
                const e = effectiveStatus(i, probes[i.href])
                const w = INTEGRATION_WORDS[e.status]
                return (
                  <li key={i.key} data-integration={i.key} data-status={e.status}>
                    <Panel className="h-full">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-[1.05rem]">{i.name}</h3>
                        <span className="flex flex-wrap gap-2">{(i.key === 'gmail' || i.key === 'microsoft') && <Badge tone="muted">Not live-verified</Badge>}<Badge tone={w.tone}>{w.label}</Badge></span>
                      </div>
                      <p className="pt-2 text-[14px] text-grey-h break-words">{e.status === 'not_available' && i.probe ? 'Not available in this deployment yet.' : i.detail}</p>
                      <p className="pt-3 text-[15px] text-grey"><span className="text-ink">Used for: </span>{i.usedFor}</p>
                      <div className="pt-3">
                        <div className="text-[14px] text-ink">What it lets Deploi do</div>
                        <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[14px] text-grey">{i.permissions.map(p => <li key={p}>{p}</li>)}</ul>
                      </div>
                      {e.linkable && (
                        <Link href={i.href} className="btn ghost xs mt-4" aria-label={`${e.status === 'connected' ? 'Manage' : 'Set up'} ${i.name}`}>
                          {e.status === 'connected' ? 'Manage' : 'Set up'}<Icon name="arrow-right" size={14} />
                        </Link>
                      )}
                    </Panel>
                  </li>
                )
              })}
            </ul>
          </Section>
        )
      })}
      <p className="pt-6 text-[13px] text-grey-h">&ldquo;Connected&rdquo; means Deploi holds a working connection for your organization. &ldquo;Needs setup&rdquo; means it is available and waiting for you. &ldquo;Not available yet&rdquo; means it is not switched on in this deployment.</p>
    </>
  )
}
