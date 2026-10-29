import { describe, it, expect } from 'vitest'
import { emptyForm, emailRules, formFromDraft, formFromPolicy, policyFromForm, type AgentFormState } from '../../components/store/AgentForm'
import { parsePolicy } from '../../lib/agents/policy'
import { parseTask } from '../../lib/agents/parse'

const CONN = '00000000-0000-4000-8000-000000000001'
const ACC = '00000000-0000-4000-8000-000000000002'

function emailOnly(over: Partial<AgentFormState> = {}): AgentFormState {
  return {
    ...emptyForm(CONN),
    emailOn: true, emailAccountId: ACC, emailPermission: 'send_approved', emailPurpose: 'Restock requests and run summaries',
    emailTasks: { run_report: true, needs_person_alert: false, supplier_reorder: true, supplier_followup: false },
    emailAddresses: 'owner@northwind-goods.example', emailDomains: 'supplier.example', emailNotify: 'owner@northwind-goods.example',
    supplierAddress: 'orders@supplier.example', scopeMode: 'all',
    ...over,
  }
}

describe('agent form: email section', () => {
  it('builds an email-only policy the server accepts (no correction types)', () => {
    const { policy, problems } = policyFromForm(emailOnly(), 'UTC')
    expect(problems).toEqual([])
    const p = parsePolicy(policy)
    expect(p.correctionTypes).toEqual([])
    expect(p.email?.tasks).toEqual(['run_report', 'supplier_reorder'])
    expect(p.email?.recipients).toEqual({ addresses: ['owner@northwind-goods.example'], domains: ['supplier.example'] })
    expect(p.email?.supplierReorder).toEqual({ supplierAddress: 'orders@supplier.example', thresholdAvailable: 0, cooldownDays: 7, followupDays: 3 })
    expect(p.email?.read.enabled).toBe(false)
    // round trip for editing
    const again = policyFromForm(formFromPolicy(p), 'UTC')
    expect(again.policy?.email).toEqual(policy?.email)
  })

  it('does not need products or a change-approval mode for summaries only', () => {
    const f = emailOnly({ emailTasks: { run_report: true, needs_person_alert: false, supplier_reorder: false, supplier_followup: false }, scopeMode: '', supplierAddress: '' })
    const { policy, problems } = policyFromForm(f, 'UTC')
    expect(problems).toEqual([])
    expect(parsePolicy(policy).productScope.mode).toBe('all')
  })

  it('flags notify and supplier addresses outside the recipient rules, and invalid entries', () => {
    const f = emailOnly({ emailDomains: '', emailNotify: 'boss@elsewhere.example, not-an-address' })
    const r = emailRules(f)
    expect(r.outside).toEqual(['boss@elsewhere.example', 'orders@supplier.example'])
    expect(r.badNotify).toEqual(['not-an-address'])
    const { policy, problems } = policyFromForm(f, 'UTC')
    expect(policy).toBeNull()
    expect(problems.join(' | ')).toMatch(/outside the recipient rules: boss@elsewhere.example, orders@supplier.example/)
  })

  it('needs an end date within a year to send without asking', () => {
    expect(policyFromForm(emailOnly({ emailPermission: 'send_autonomous' }), 'UTC').problems.join(' | ')).toMatch(/needs an end date/)
    const far = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10)
    expect(policyFromForm(emailOnly({ emailPermission: 'send_autonomous', emailValidUntil: far }), 'UTC').problems.join(' | ')).toMatch(/at most one year/)
    const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
    const ok = policyFromForm(emailOnly({ emailPermission: 'send_autonomous', emailValidUntil: soon }), 'UTC')
    expect(ok.problems).toEqual([])
    expect(parsePolicy(ok.policy).email?.validUntil).toBeTruthy()
  })

  it('addresses found in the task are suggestions that must be confirmed', () => {
    const d = parseTask('Email orders@supplier.example to ask for restock of low stock products, ask me before sending.')
    const f = formFromDraft(d, CONN)
    expect(f.emailOn).toBe(true)
    expect(f.emailSuggested).toEqual(['orders@supplier.example'])
    expect(f.emailAddresses).toBe('orders@supplier.example')
    const filled = { ...f, emailAccountId: ACC, emailPurpose: 'Restock requests', supplierAddress: 'orders@supplier.example', scopeMode: 'all' as const }
    expect(policyFromForm(filled, 'UTC').problems.join(' | ')).toMatch(/confirm the addresses found in your text \(orders@supplier.example\)/)
    expect(policyFromForm({ ...filled, emailSuggestedConfirmed: true }, 'UTC').problems).toEqual([])
  })

  it('still refuses an agent with neither corrections nor email', () => {
    expect(policyFromForm({ ...emptyForm(CONN), scopeMode: 'all', approvalMode: 'review' }, 'UTC').problems).toContain('Choose at least one correction type or check, turn on email, or add competitor stores.')
  })
})
