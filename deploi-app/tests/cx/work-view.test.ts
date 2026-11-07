import { describe, it, expect } from 'vitest'
import { navActive } from '../../lib/nav'
import { MERCHANT_NAV, NAV_LABELS, LEGACY_REDIRECTS, CASE_VIEWS, caseHref } from '../../lib/store/nav'
import { OFFICE_NAV } from '../../app/office/nav'
import {
  STATUS_WORDS, agentLabel, approvalContentRows, approvalsWithoutCase, caseTimeline, humanize, mergeCases,
  pendingDecisionsFor, teamMembers, EMPTY_DIRECTORY, type ApprovalEntry, type CaseEventItem, type CaseItem,
} from '../../components/work/caseView'
import { readDiscovery } from '../../components/discover/firstRun'
import { CASE_STATUSES } from '../../lib/cases'

const nav = (label: string) => MERCHANT_NAV.find(n => n.label === label)!
const kase = (over: Partial<CaseItem> = {}): CaseItem => ({
  id: 'c1', ref: 'DC-000001', suite: 'commerce', kind: 'supplier_exception', source_app: 'shopify', title: 'PO 1001 not confirmed', problem: 'No confirmation',
  why_it_matters: null, priority: 'normal', status: 'detected', status_reason: null, agent_kind: null, agent_ref: null, next_action: null, approval_required: false,
  next_check_at: null, deadline_at: null, verification: { criteria: 'confirmed' }, outcome: null, evidence: [], records: [], attempts: 0,
  opened_at: '2026-11-01T00:00:00Z', closed_at: null, updated_at: '2026-11-01T00:00:00Z', ...over,
})
const approval = (over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({ source: 'email', id: 'a1', orgId: 'o', kind: 'email', title: 'Send', agent: null, createdAt: '2026-11-01T00:00:00Z', expiresAt: null, version: 'v', decisions: ['approve', 'reject'], why: null, content: {}, ...over })

describe('customer navigation', () => {
  it('has the exact labels in order (approved redesign)', () => {
    expect(NAV_LABELS).toEqual(['Command center', 'Needs you', 'My agents', 'Team room', 'Agent library', 'Proof log', 'Connections', 'Plan & actions'])
  })
  it('maps each label to its page and keeps old pages under the right entry', () => {
    expect(nav('Command center').href).toBe('/store')
    expect(nav('Needs you')).toMatchObject({ href: '/store/approvals', count: 'needsYou' })
    expect(nav('My agents')).toMatchObject({ href: '/store/my-team', count: 'agents' })
    expect(nav('Team room').href).toBe('/store/room')
    expect(nav('Agent library').href).toBe('/store/team')
    expect(nav('Proof log').href).toBe('/store/completed')
    expect(nav('Plan & actions').href).toBe('/store/plan')
    expect(navActive(nav('Command center'), '/store/control-room')).toBe(true)
    expect(navActive(nav('Command center'), '/store/work')).toBe(false)
    expect(navActive(nav('My agents'), '/store/agents/x')).toBe(true)
    expect(navActive(nav('My agents'), '/agents/store%3Ainventory_watcher')).toBe(true)
    expect(navActive(nav('My agents'), '/office/agents')).toBe(true)
    expect(navActive(nav('Proof log'), '/store/activity')).toBe(true)
    expect(navActive(nav('Plan & actions'), '/store/billing')).toBe(true)
    expect(navActive(nav('Connections'), '/store/connect/woocommerce')).toBe(true)
    // every path is claimed by at most one entry
    for (const p of ['/store', '/store/approvals', '/store/my-team', '/store/team/listing_writer', '/store/completed', '/office/approvals', '/office/connections']) expect(MERCHANT_NAV.filter(n => navActive(n, p))).toHaveLength(1)
    expect(OFFICE_NAV.every(n => n.href.startsWith('/office'))).toBe(true)
  })
  it('redirects old URLs to their new homes', () => {
    expect(LEGACY_REDIRECTS).toEqual({ '/store/control-room': '/store', '/store/inbox': '/store/approvals' })
    for (const to of Object.values(LEGACY_REDIRECTS)) expect(MERCHANT_NAV.some(n => n.href === to)).toBe(true)
  })
  it('reads the right case views per page', () => {
    expect(CASE_VIEWS.work).toEqual(['in_progress', 'attention'])
    expect(CASE_VIEWS.approvals).toEqual(['needs_approval'])
    expect(CASE_VIEWS.completed).toEqual(['completed'])
    expect(caseHref('DC-000001')).toBe('/store/work/DC-000001')
  })
})

describe('case view shaping', () => {
  it('words every case status', () => {
    for (const s of CASE_STATUSES) expect(STATUS_WORDS[s].label).toBeTruthy()
    expect(STATUS_WORDS.resolved.label).toMatch(/verified/i)
    expect(STATUS_WORDS.waiting_external.stage).toBe('waiting_others')
  })
  it('merges views without duplicates, attention first', () => {
    const a = kase({ id: 'a', updated_at: '2026-11-03T00:00:00Z' }), b = kase({ id: 'b', status: 'failed', updated_at: '2026-11-01T00:00:00Z' }), c = kase({ id: 'c', priority: 'urgent', updated_at: '2026-11-02T00:00:00Z' })
    expect(mergeCases([[a, c], [b, a]]).map(x => x.id)).toEqual(['b', 'c', 'a'])
  })
  it('names the owner agent or says it is unassigned', () => {
    const dir = { ...EMPTY_DIRECTORY, engine: { e1: 'Stock Guardian' } }
    expect(agentLabel(dir, 'engine', 'e1')).toEqual({ name: 'Stock Guardian', href: '/store/agents/e1' })
    expect(agentLabel(dir, 'library', 'listing_writer')).toEqual({ name: 'Listing writer', href: '/store/team/listing_writer' })
    expect(agentLabel(dir, null, null)).toBeNull()
  })
  it('builds the timeline from case events', () => {
    const ev = (type: string, over: Partial<CaseEventItem> = {}): CaseEventItem => ({ id: type, at: '2026-11-01T00:00:00Z', actor: 'agent', type, from_status: null, to_status: null, summary: `${type} summary`, detail: {}, ref_type: null, ref_id: null, ...over })
    const t = caseTimeline([ev('opened'), ev('status', { to_status: 'awaiting_approval' }), ev('action'), ev('verification', { to_status: 'resolved' })])
    expect(t.map(x => x.title)).toEqual(['Discovered', 'Needs your approval', 'Action taken', 'Verified'])
    expect(t[3].tone).toBe('ok')
  })
  it('finds the decisions that belong to a case, and the ones that belong to none', () => {
    const c = kase({ id: 'case-1', records: [{ type: 'email_message', id: 'm1' }] })
    const items = [approval({ id: 'm1' }), approval({ source: 'case', id: 'case-1' }), approval({ id: 'other' }), approval({ id: 'evt' })]
    expect(pendingDecisionsFor(c, [{ ref_id: 'evt' }], items).map(i => i.id)).toEqual(['m1', 'case-1', 'evt'])
    expect(approvalsWithoutCase(items, [c]).map(i => i.id)).toEqual(['other', 'evt'])
  })
  it('shows the exact content of a decision as rows, nothing dropped', () => {
    const rows = approvalContentRows({ to: ['a@example.com'], subject: 'Hi', body: 'Line 1\nLine 2', empty: '', change: { field: 'price', from: 1, to: 2 } })
    expect(rows).toEqual([{ label: 'To', value: 'a@example.com' }, { label: 'Subject', value: 'Hi' }, { label: 'Body', value: 'Line 1\nLine 2' }, { label: 'Change', value: 'Field: price\nFrom: 1\nTo: 2' }])
    expect(humanize('supplier_exception')).toBe('Supplier exception')
  })
  it('lists every agent source in one team, hiding locked library agents that are off', () => {
    const m = teamMembers({ engine: [{ id: 'e', name: 'Stock Guardian', status: 'active', health: 'active' }], office: [{ id: 'o', name: 'Lead Follow-up', status: 'paused' }],
      library: [{ key: 'listing_writer', name: 'Listing Writer', enabled: true, locked: false, permission: 'draft', waiting: 2 }, { key: 'order_tracker', name: 'Order Tracker', enabled: false, locked: true, permission: 'draft', waiting: 0 }] })
    expect(m.map(x => [x.group, x.name, x.status])).toEqual([['Store agents', 'Stock Guardian', 'Working'], ['Office agents', 'Lead Follow-up', 'Paused'], ['Agent library', 'Listing Writer', 'On']])
    expect(m[2].detail).toBe('Drafts only · 2 waiting for you')
    expect(teamMembers({ engine: [], office: null, library: null })).toEqual([])
  })
})

describe('first-run discovery reading', () => {
  it('takes findings and recommendations only when they carry real text', () => {
    const d = readDiscovery({ ok: true, findings: [{ title: 'PO 1001 not confirmed', problem: 'No reply', dedupeKey: 'po:1', caseRef: 'DC-000004' }, { problem: 'no title' }],
      recommendations: [{ template: 'supplier_chaser', name: 'Supplier Chaser', reason: '3 unconfirmed POs', needs: [{ label: 'supplier email' }] }, { template: 'x' }], sourcesRead: ['shopify'], ranAt: '2026-11-05T00:00:00Z' })
    expect(d.state).toBe('ready')
    expect(d.findings).toHaveLength(1)
    expect(d.findings[0]).toMatchObject({ key: 'po:1', caseRef: 'DC-000004' })
    expect(d.recommendations).toEqual([{ template: 'supplier_chaser', name: 'Supplier Chaser', reason: '3 unconfirmed POs', suite: null, needs: ['supplier email'] }])
  })
  it('is honest about nothing run, running and nothing connected', () => {
    expect(readDiscovery({ ok: true }).state).toBe('not_run')
    expect(readDiscovery({ discovery: { status: 'running' } }).state).toBe('running')
    expect(readDiscovery({ connected: false }).state).toBe('nothing_connected')
    expect(readDiscovery(null)).toMatchObject({ findings: [], recommendations: [], state: 'not_run' })
  })
})

describe('an Office approval shows what goes out, not internal bookkeeping', () => {
  it('recipient, subject and body first, then the purpose; no ids, metadata or machine names', async () => {
    const { shownContent } = await import('../../lib/approvals/office-source')
    const c = shownContent({ purpose: 'Payment reminder 1 for invoice 1037', payload: { type: 'email', to: 'accounts@brightpath.example', subject: 'Invoice 1037', body: 'Hello', inReplyToMessageId: null,
      recipientSource: { kind: 'invoice', invoiceId: '32bf6cc6-825d-452c-b295-eac05890147a' }, meta: { reminder: 1, invoiceRowId: '32bf6cc6-825d-452c-b295-eac05890147a' } } as never })
    expect(Object.keys(c)).toEqual(['to', 'subject', 'body', 'purpose'])
    expect(JSON.stringify(approvalContentRows(c))).not.toMatch(/32bf6cc6|send_email|Policy/)
  })
})

describe('the case page evidence list', () => {
  it('shows a repeated observation of the same fact once', async () => {
    const { distinctEvidence } = await import('../../components/work/caseView')
    const a = { label: 'QuickBooks: invoice 1037 has USD 1,250.00 open', source: 'quickbooks', observedAt: '1', ref: { type: 'qbo_invoice', id: 'r:1037' } }
    const b = { ...a, label: 'QuickBooks: invoice 1037 balance USD 0.00 (paid)' }
    expect(distinctEvidence([a, { ...a, observedAt: '2' }, b])).toEqual([a, b])
    expect(distinctEvidence(null)).toEqual([])
  })
})
