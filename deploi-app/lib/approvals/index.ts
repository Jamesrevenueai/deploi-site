/**
 * Unified approvals entry point: importing this module registers the built-in sources.
 *
 * Deploi Office registers its own source at integration (lib/office/approvals.ts exports
 * listOfficePendingApprovals and decideOfficeAction). The hook, to be enabled there:
 *
 *   // import { listOfficePendingApprovals, decideOfficeAction } from '../office/approvals'
 *   // registerApprovalSource({
 *   //   key: 'office', label: 'Office',
 *   //   list: (db, orgId) => listOfficePendingApprovals(db, orgId),
 *   //   find: async (db, orgId, id) => (await listOfficePendingApprovals(db, orgId)).find(i => i.id === id) ?? null,
 *   //   decide: (db, actor, id, decision, input) => decideOfficeAction(db, actor, id, decision, input),
 *   // })
 *
 * Every source item must carry a content-hash `version`; the registry refuses stale, expired and
 * cross-organization decisions before the source is called.
 */
import { registerApprovalSource } from './registry'
import { BUILT_IN_SOURCES } from './sources'

for (const s of BUILT_IN_SOURCES) registerApprovalSource(s)

export { registerApprovalSource, listPendingApprovals, decideApproval, approvalSources, getApprovalSource } from './registry'
export type { ApprovalItem, ApprovalSource, ApprovalDecision, DecisionInput, DecisionResult } from './registry'
