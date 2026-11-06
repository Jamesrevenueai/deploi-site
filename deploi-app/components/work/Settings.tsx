'use client'
/**
 * Settings: one place for the business's rules, agreements, setup, people and roles, and data and deletion.
 * Members and roles, retention and organization deletion come from /api/store/settings/{members,retention,deletion};
 * each section is shown when its API answers and says so plainly when it does not. Deletion is owner-only on the
 * server; the page only asks for it (with a cooling-off period the owner can cancel).
 */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { useLoad } from '@/components/store/useLoad'
import { Section } from '@/components/store/bits'
import { probe } from '@/components/cx/probe'
import { useState } from 'react'
import { storeFetch, asApiError } from '@/components/store/api'
import { MembersPanel } from './Members'
import { AgentModesPanel } from './AgentModes'

export const SETTINGS_APIS = {
  members: '/api/store/settings/members',
  retention: '/api/store/settings/retention',
  deletion: '/api/store/settings/deletion',
  autonomy: '/api/store/autonomy',
} as const

type Probe = { available: boolean; json: Record<string, unknown> | null }

function Row({ href, title, body, badge }: { href: string | null; title: string; body: string; badge?: React.ReactNode }) {
  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><div className="font-semibold text-ink">{title}</div><p className="pt-1 text-[14px] text-grey">{body}</p></div>
      <div className="flex shrink-0 items-center gap-2">{badge}{href && <Icon name="arrow-right" size={16} className="text-grey-h" />}</div>
    </div>
  )
  return <li>{href ? <Link href={href} className="panel block p-4 transition-colors hover:border-[var(--c-accent-line)]">{inner}</Link> : <div className="panel p-4">{inner}</div>}</li>
}

type Period = { key: string; days: number; adjusted: boolean }
type Deletion = { status: string; execute_after: string } | null
const PERIOD_LABEL: Record<string, string> = { emailBodies: 'Email message bodies', inboundRaw: 'Raw incoming webhooks and mail', jobs: 'Background job records', rateLimits: 'Rate-limit counters', webhookReceipts: 'Webhook receipts' }

function DeletionControl({ request, coolingOffDays, onChange }: { request: Deletion; coolingOffDays: number | null; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (action: 'request' | 'cancel') => {
    setError(null)
    try { await storeFetch('/api/store/settings/deletion', { method: 'POST', body: { action } }); setConfirming(false); onChange() } catch (e) { setError(asApiError(e).message) }
  }
  const pending = request && (request.status === 'pending' || request.status === 'executing')
  return (
    <div className="panel p-4" data-testid="deletion">
      <div className="font-semibold text-ink">Delete this business from Deploi</div>
      {pending
        ? <p className="pt-1 text-[14px] text-grey">Deletion is scheduled for {new Date(request!.execute_after).toLocaleString()}. Connections are disconnected and your data is removed then; legal acceptance and billing records are kept as the law requires.</p>
        : <p className="pt-1 text-[14px] text-grey">Only the owner can ask. Nothing is deleted for {coolingOffDays ?? 7} days, and you can cancel until then.</p>}
      <div className="flex flex-wrap gap-2 pt-3">
        {pending
          ? request!.status === 'pending' && <button className="btn ghost xs" onClick={() => act('cancel')}>Cancel the deletion</button>
          : confirming
            ? <><button className="btn danger xs" onClick={() => act('request')}>Yes, schedule deletion</button><button className="btn ghost xs" onClick={() => setConfirming(false)}>Keep my business</button></>
            : <button className="btn ghost xs" onClick={() => setConfirming(true)}>Ask to delete</button>}
      </div>
      {error && <p className="pt-2 text-[14px]" style={{ color: "var(--c-danger)" }} role="alert">{error}</p>}
    </div>
  )
}

export function SettingsScreen() {
  const { data, reload } = useLoad(async () => {
    const out: Record<string, Probe> = {}
    for (const [k, path] of Object.entries(SETTINGS_APIS)) {
      const p = await probe(path)
      out[k] = { available: p.availability === 'available' && p.status < 500, json: p.json && typeof p.json === 'object' ? p.json as Record<string, unknown> : null }
    }
    return out
  }, 'settings')
  const members = data?.members
  const pending = <Badge tone="muted">{data ? 'Not available yet' : 'Checking…'}</Badge>
  return (
    <>
      <PageHeader title="Settings" sub="How your AI team works for your business: rules, agreements, people and your data." />
      <Section id="work" title="How your team works">
        <ul className="flex flex-col gap-2">
          <Row href="/store/rules" title="Store rules" body="What counts as a problem in your store, and which products are exempt." />
          <Row href="/store/setup" title="Setup" body="Business details, agreements, products, connections and the team discovery recommends." />
          <Row href="/store/legal" title="Agreements" body="The terms you accepted for Deploi Commerce and Deploi Office." />
        </ul>
      </Section>
      <Section id="autonomy" title="How your agents act" sub="For each kind of action: should your agents do it and tell you after, or ask you first? Every action is checked with a fresh read and recorded with its proof.">
        <div data-settings="autonomy" data-available={data?.autonomy?.available ? 'true' : 'false'}>
          {data?.autonomy?.available ? <AgentModesPanel /> : <ul className="flex flex-col gap-2"><Row href={null} title="Do it and tell me, or ask me first" body="Choose per action how your agents work." badge={pending} /></ul>}
        </div>
      </Section>
      <Section id="people" title="People and roles" sub="Who can see and approve work for your business. Only owners and admins grant agents.">
        <div data-settings="members" data-available={members?.available ? 'true' : 'false'}>
          {members?.available ? <MembersPanel /> : <ul className="flex flex-col gap-2"><Row href={null} title="Members and roles" body="Owner, admin, member and viewer roles; only owners and admins grant agents." badge={pending} /></ul>}
        </div>
      </Section>
      <Section id="data" title="Data and deletion" sub="What Deploi keeps, for how long, and how to delete it.">
        <ul className="flex flex-col gap-2" data-settings="data" data-available={data?.retention?.available ? 'true' : 'false'}>
          {data?.retention?.available && Array.isArray(data.retention.json?.periods)
            ? <Row href={null} title="How long Deploi keeps your data" body={(data.retention.json!.periods as Period[]).map(p => `${PERIOD_LABEL[p.key] ?? p.key}: ${p.days} days${p.adjusted ? ' (yours)' : ''}`).join(' · ') + '. Case history is kept while your business uses Deploi.'} badge={<Badge tone="ok">Available</Badge>} />
            : <Row href={null} title="Retention" body="Not available here right now." badge={pending} />}
          {data?.deletion?.available
            ? <li><DeletionControl request={(data.deletion.json?.request as Deletion) ?? null} coolingOffDays={typeof data.deletion.json?.coolingOffDays === 'number' ? data.deletion.json.coolingOffDays : null} onChange={reload} /></li>
            : <Row href={null} title="Account deletion" body="Not available here right now. To delete your business's data, write to hello@getdeploi.com." badge={pending} />}
          <Row href="/store/activity" title="Activity and audit" body="Every change your agents made, with its verification." />
          <Row href="/store/privacy" title="Privacy requests" body="Customer data requests and erasures from Shopify, and the exports to send your customers." />
        </ul>
      </Section>
      <Section id="billing" title="Billing">
        <ul className="flex flex-col gap-2"><Row href="/store/billing" title="Plan and billing" body="Your plan, usage this month and invoices." /></ul>
      </Section>
    </>
  )
}
