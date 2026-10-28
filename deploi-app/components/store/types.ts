/** Response shapes of /api/store/* as the browser receives them (dates are ISO strings). */
import type { ConnectionView, IssueView, ProposalView, ExecutionView, AuditView } from '@/lib/engine/queries'
import type { Outcome } from '@/lib/engine/outcomes'

export type { ConnectionView, IssueView, ProposalView, ExecutionView, AuditView, Outcome }

/** api_version / timezone are shown when the API includes them */
export type Connection = ConnectionView & { api_version?: string | null; timezone?: string | null }

export type LastScan = { id: string; status: string; started_at: string; finished_at: string | null; resources_scanned: number; issues_opened: number; issues_resolved: number; error: string | null } | null
export type Subscription = { provider: string; plan_key: string; status: string; is_test: boolean; current_period_end: string | null } | null

export type OverviewResponse = {
  ok: true
  actor: { kind: 'profile' | 'shopify_user' | 'staff'; label: string; canApprove: boolean }
  org: { id: string; name: string; timezone: string } | null
  connections: Connection[]
  overview: {
    openIssues: number; needsReview: number; needsPerson: number; highSeverity: number; waitingApproval: number
    executions30d: Record<Outcome, number>
    lastScan: LastScan
    subscription: Subscription
  }
  platforms: { platform: string; status: 'operational' | 'planned' }[]
}

export type IssuesResponse = { ok: true; issues: IssueView[] }

export type RuleView = {
  id: string; check_key: string; enabled: boolean; config: Record<string, unknown>; version: number; updated_by: string | null; updated_at: string
  title: string; description: string; whyItIsAnError: string; kind: 'correctable' | 'needs_person'
}
export type RulesResponse = { ok: true; connectionId: string; rules: RuleView[] }

export type IssueDetailResponse = {
  ok: true
  issue: IssueView
  check: { key: string; title: string; description: string; whyItIsAnError: string } | null
  rule: { enabled: boolean; config: Record<string, unknown>; version: number } | null
  proposals: ProposalView[]
  executions: ExecutionView[]
  trail: AuditView[]
  canApprove: boolean
}

export type ActivityResponse = { ok: true; executions: ExecutionView[]; blockedProposals: ProposalView[] }

export type ExecutionStatusResult = 'prechecking' | 'blocked' | 'stale' | 'executing' | 'applied' | 'unknown' | 'verified' | 'failed' | 'verification_failed' | 'not_approved'
export type ExecutionResult = { ok: true; approvalId?: string; executionId: string | null; status: ExecutionStatusResult; reason?: string; duplicate?: boolean }

export type ScanResult = { ok: true; scan: { scanId: string; resourcesScanned: number; issuesOpened: number; issuesUpdated: number; issuesResolved: number; proposalsCreated: number; proposalsInvalidated: number } }

export const OVERSELL_CHECK = 'shopify.oversell_policy'
