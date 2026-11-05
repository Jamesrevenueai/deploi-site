'use client'
/**
 * Settings: one place for the business's rules, agreements, setup, people and roles, and data and deletion.
 * Roles/members and data & deletion are delivered by the platform workstream under /api/store/settings/**;
 * each section is shown when its API answers and says so plainly when it is not available yet.
 */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { useLoad } from '@/components/store/useLoad'
import { Section } from '@/components/store/bits'
import { probe } from '@/components/cx/probe'

export const SETTINGS_APIS = {
  members: '/api/store/settings/members',
  data: '/api/store/settings/data',
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

export function SettingsScreen() {
  const { data } = useLoad(async () => {
    const out: Record<string, Probe> = {}
    for (const [k, path] of Object.entries(SETTINGS_APIS)) {
      const p = await probe(path)
      out[k] = { available: p.availability === 'available' && p.status < 500, json: p.json && typeof p.json === 'object' ? p.json as Record<string, unknown> : null }
    }
    return out
  }, 'settings')
  const members = data?.members
  const memberList = Array.isArray(members?.json?.members) ? (members!.json!.members as Record<string, unknown>[]) : null
  const pending = <Badge tone="muted">{data ? 'Not available yet' : 'Checking…'}</Badge>
  return (
    <>
      <PageHeader title="Settings" sub="How your AI team works for your business: rules, agreements, people and your data." />
      <Section id="work" title="How your team works">
        <ul className="flex flex-col gap-2">
          <Row href="/store/rules" title="Store rules" body="What counts as a problem in your store, and which products are exempt." />
          <Row href="/store/onboarding" title="Setup" body="Business details, products, connections and your first agents." />
          <Row href="/store/legal" title="Agreements" body="The terms you accepted for Deploi Commerce and Deploi Office." />
        </ul>
      </Section>
      <Section id="people" title="People and roles" sub="Who can see and approve work for your business.">
        <ul className="flex flex-col gap-2" data-settings="members" data-available={members?.available ? 'true' : 'false'}>
          {members?.available
            ? <Row href={null} title="Members" body={memberList ? memberList.map(m => `${String(m.email ?? m.name ?? 'member')}${m.role ? ` (${String(m.role)})` : ''}`).join(', ') || 'Only you.' : 'Your members and their roles.'} badge={<Badge tone="ok">Available</Badge>} />
            : <Row href={null} title="Members and roles" body="Owner, admin and member roles, with owner-only grants. Until this is available, every member of your business can approve." badge={pending} />}
        </ul>
      </Section>
      <Section id="data" title="Data and deletion" sub="What Deploi keeps, for how long, and how to delete it.">
        <ul className="flex flex-col gap-2" data-settings="data" data-available={data?.data?.available ? 'true' : 'false'}>
          {data?.data?.available
            ? <Row href={null} title="Your data" body="Retention and deletion for your business." badge={<Badge tone="ok">Available</Badge>} />
            : <Row href={null} title="Retention and account deletion" body="Not available in the app yet. To delete your business's data, write to hello@getdeploi.com." badge={pending} />}
          <Row href="/store/activity" title="Activity and audit" body="Every change your agents made, with its verification." />
        </ul>
      </Section>
      <Section id="billing" title="Billing">
        <ul className="flex flex-col gap-2"><Row href="/store/billing" title="Plan and billing" body="Your plan, usage this month and invoices." /></ul>
      </Section>
    </>
  )
}
