import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { getService } from '@/lib/catalog/services'
import { getPricing, range } from '@/lib/catalog/pricing'
import { INPUT_METHOD_LABEL, integrationsForInput } from '@/lib/engagements/defaults'
import { INTEGRATIONS, INTEGRATION_LEVEL_LABEL } from '@/lib/catalog/integrations'
import type { EngagementView } from '@/lib/engagements/types'
import { saveProposal } from '@/app/staff/engagements/actions'

const dollars = (cents: number) => String(Math.round(cents / 100))

/** Proposal (commercial scope) editor. Commercial fields lock after acceptance; contacts and support stay editable. */
export function ProposalForm({ e }: { e: EngagementView }) {
  const svc = getService(e.service_key)
  const p = getPricing()
  const locked = e.status !== 'draft' && e.status !== 'proposed'
  const ro = locked ? { readOnly: true, 'aria-readonly': true, className: 'input opacity-60' } : {}
  const milestoneLines = e.milestones.map(m => `${m.title}${m.due_on ? ` @ ${m.due_on}` : ''}${m.done ? ' [x]' : ''}`).join('\n')
  const integrations = integrationsForInput(e.input_method)
  return (
    <form action={saveProposal} className="flex flex-col gap-5 rounded-[20px] border border-line p-5 md:p-6">
      <input type="hidden" name="id" value={e.id} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg">Proposal</h2>
        {locked ? <Badge tone="muted">commercial terms locked after acceptance</Badge> : <Badge tone="warn">draft terms</Badge>}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Setup fee ($)" htmlFor="setup_fee_dollars" hint={`Build range ${range(p.build)}; exact scope sets the quote.`}><Input id="setup_fee_dollars" name="setup_fee_dollars" type="number" min={0} step="50" defaultValue={dollars(e.setup_fee_cents)} {...ro} /></Field>
        <Field label="Monthly management ($)" htmlFor="monthly_fee_dollars" hint={`Management range ${range(p.management)}.`}><Input id="monthly_fee_dollars" name="monthly_fee_dollars" type="number" min={0} step="50" defaultValue={dollars(e.monthly_fee_cents)} {...ro} /></Field>
        <Field label="Credit applied" hint="Mirrors the ledger; apply credits below."><div className="input opacity-60">${Math.round(e.credit_applied_cents / 100).toLocaleString('en-US')}</div></Field>
      </div>
      <Field label="Defined workflow" htmlFor="defined_workflow" hint="What the service does, in the customer's words."><Textarea id="defined_workflow" name="defined_workflow" rows={5} defaultValue={e.defined_workflow ?? ''} {...ro} /></Field>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Included volume" htmlFor="included_volume"><Input id="included_volume" name="included_volume" type="number" min={0} defaultValue={e.included_volume ?? ''} {...ro} /></Field>
        <Field label="Volume units" htmlFor="volume_units"><Input id="volume_units" name="volume_units" defaultValue={e.volume_units ?? ''} placeholder="referrals per month" {...ro} /></Field>
        <Field label="Input format" htmlFor="input_method" hint={svc ? `Catalog: ${svc.inputMethods.map(m => INPUT_METHOD_LABEL[m]).join(', ')}` : undefined}>
          <Select id="input_method" name="input_method" defaultValue={e.input_method ?? ''} disabled={locked}>
            {(svc?.inputMethods ?? []).map(m => <option key={m} value={m}>{INPUT_METHOD_LABEL[m] ?? m}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Usage and overage terms" htmlFor="usage_terms"><Textarea id="usage_terms" name="usage_terms" rows={3} defaultValue={e.usage_terms ?? ''} {...ro} /></Field>
        <Field label="Supported integration" htmlFor="integration_key" hint="A vendor name is a compatibility statement, never a partnership claim.">
          <Select id="integration_key" name="integration_key" defaultValue={e.integration_key ?? ''} disabled={locked}>
            <option value="">None (manual or file based)</option>
            {(integrations.length ? integrations : INTEGRATIONS).map(i => <option key={i.key} value={i.key}>{i.name} · {INTEGRATION_LEVEL_LABEL[i.level]}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Implementation milestones" htmlFor="milestones" hint="One per line. Optional: `title @ YYYY-MM-DD`, append [x] when done."><Textarea id="milestones" name="milestones" rows={5} defaultValue={milestoneLines} {...ro} /></Field>
        <Field label="Acceptance criteria" htmlFor="acceptance_criteria" hint="One per line. These are what the customer signs off on."><Textarea id="acceptance_criteria" name="acceptance_criteria" rows={5} defaultValue={e.acceptance_criteria.join('\n')} {...ro} /></Field>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Agency contact" htmlFor="agency_contact"><Input id="agency_contact" name="agency_contact" defaultValue={e.agency_contact ?? ''} /></Field>
        <Field label="Deploi owner" htmlFor="deploi_owner"><Input id="deploi_owner" name="deploi_owner" defaultValue={e.deploi_owner ?? ''} /></Field>
        <Field label="Action-approval owner" htmlFor="approval_owner" hint="The person who approves proposed actions."><Input id="approval_owner" name="approval_owner" defaultValue={e.approval_owner ?? ''} /></Field>
        <Field label="Support hours" htmlFor="support_hours"><Input id="support_hours" name="support_hours" defaultValue={e.support_hours ?? ''} /></Field>
        <Field label="Support timezone" htmlFor="support_timezone"><Input id="support_timezone" name="support_timezone" defaultValue={e.support_timezone ?? ''} /></Field>
        <Field label="Escalation contact" htmlFor="escalation_contact"><Input id="escalation_contact" name="escalation_contact" defaultValue={e.escalation_contact ?? ''} /></Field>
        <Field label="Fix period (days)" htmlFor="fix_period_days"><Input id="fix_period_days" name="fix_period_days" type="number" min={0} defaultValue={e.fix_period_days ?? ''} {...ro} /></Field>
        <Field label="Initial term (months)" htmlFor="initial_term_months"><Input id="initial_term_months" name="initial_term_months" type="number" min={0} defaultValue={e.initial_term_months ?? ''} {...ro} /></Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Exclusions" htmlFor="exclusions" hint="One per line. Prefilled from the catalog."><Textarea id="exclusions" name="exclusions" rows={4} defaultValue={e.exclusions.join('\n')} {...ro} /></Field>
        <Field label="Change-request process" htmlFor="change_request_process"><Textarea id="change_request_process" name="change_request_process" rows={4} defaultValue={e.change_request_process ?? ''} {...ro} /></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn ghost sm">{locked ? 'Save contacts and support' : 'Save proposal'}</button>
        <a className="btn ghost sm" href={`/staff/engagements/${e.id}/proposal.pdf`} target="_blank" rel="noopener noreferrer">Proposal PDF</a>
      </div>
    </form>
  )
}
