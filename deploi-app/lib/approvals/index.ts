/**
 * Unified approvals entry point: importing this module registers the built-in sources.
 *
 * Deploi Office actions (lib/office/approvals.ts) are registered here as the 'office' source.
 *
 * Every source item must carry a content-hash `version`; the registry refuses stale, expired and
 * cross-organization decisions before the source is called.
 */
import { registerApprovalSource } from './registry'
import { BUILT_IN_SOURCES } from './sources'
import { officeSource } from './office-source'

for (const s of BUILT_IN_SOURCES) registerApprovalSource(s)
registerApprovalSource(officeSource)

export { registerApprovalSource, listPendingApprovals, decideApproval, approvalSources, getApprovalSource } from './registry'
export type { ApprovalItem, ApprovalSource, ApprovalDecision, DecisionInput, DecisionResult } from './registry'
