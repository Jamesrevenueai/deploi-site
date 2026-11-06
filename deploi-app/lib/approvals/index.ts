/**
 * Unified approvals entry point: importing this module registers the built-in sources.
 *
 * Deploi Office actions (lib/office/approvals.ts) are registered here as the 'office' source, and cases
 * whose decision is the case itself (lib/cases/decisions.ts) as the 'case' source.
 *
 * Every source item must carry a content-hash `version`; the registry refuses stale, expired and
 * cross-organization decisions before the source is called.
 */
import { registerApprovalSource } from './registry'
import { BUILT_IN_SOURCES } from './sources'
import { officeSource } from './office-source'
import { purchaseOrderSource } from '../commerce/approval-source'
import { caseSource } from '../cases/decisions'
// registers the synthetic demo case kind's decision handler (its cases exist only on synthetic stores)
import '../cases/demo'

for (const s of BUILT_IN_SOURCES) registerApprovalSource(s)
registerApprovalSource(officeSource)
// purchase-order resolution options from the Supplier Coordinator (lib/commerce)
registerApprovalSource(purchaseOrderSource)
registerApprovalSource(caseSource)

export { registerApprovalSource, listPendingApprovals, decideApproval, approvalSources, getApprovalSource } from './registry'
export type { ApprovalItem, ApprovalSource, ApprovalDecision, DecisionInput, DecisionResult } from './registry'
