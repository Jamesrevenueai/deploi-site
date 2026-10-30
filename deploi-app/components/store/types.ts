/** Response shapes of /api/store/* as the browser receives them (dates are ISO strings). */
import type { ConnectionView, IssueView, ProposalView, ExecutionView, AuditView } from '@/lib/engine/queries'
import type { Outcome } from '@/lib/engine/outcomes'
import type { AgentListItem } from '@/lib/agents/queries'
import type { TaskDraft } from '@/lib/agents/parse'
import type { AgentPolicy } from '@/lib/agents/policy'
import type { AgentRunCounts } from '@/lib/agents/run'

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

// ---------------------------------------------------------------- agents

export type { AgentListItem, TaskDraft, AgentPolicy, AgentRunCounts }

export type AuthorizationSummary = { grants: string[]; limits: string[]; never: string[] }

export type AgentTemplateView = { key: string; name: string; job: string; tools: ('shopify' | 'email' | 'public_web')[]; mailbox: boolean; needs: string[]; minutesPerItem: number }
export type AgentsResponse = { ok: true; agents: AgentListItem[]; templates?: AgentTemplateView[] }
export type WeeklyResponse = {
  ok: true
  facts: { orgName: string; weekStart: string; weekEnd: string; agents: { agentId: string; name: string; status: string; runs: number; verified: number; drafted: number; failed: number; emailsAccepted: number; emailsDrafted: number; tasksDone: number; competitorObserved?: number; competitorInferences?: number }[]
    attention: { kind: string; count: number; label: string }[]; estimate: { minutes: number; formula: string; label: 'Estimate' } }
  rendered: { subject: string; text: string; html?: string }
  from?: string
  last: { week_start: string; status: string; status_reason: string | null; sent_at: string | null } | null
  liveSends: 'off' | 'allowlist' | 'all'
}
export type ParseResponse = { ok: true; draft: TaskDraft }
export type CreateAgentResponse = { ok: true; agentId: string; policyId: string; policyHash: string; summary: AuthorizationSummary; mailbox?: { id: string; address: string } | null }
export type EditAgentResponse = { ok: true; policyId: string; version: number; requiresGrant: boolean; expansion: string[]; policyHash: string; summary: AuthorizationSummary; /** Shopify scopes the store has not granted for what this version may write */ missingScopes: string[] }
export type GrantResponse = { ok: true; version: number; warnings: string[]; nextRunAt: string | null }
export type AgentRunResponse = { ok: true; runId: string; status: 'completed' | 'failed' | 'blocked'; reason?: string; counts: AgentRunCounts }

export type AgentRow = {
  id: string; org_id: string; name: string; status: string; task_text: string; connection_id: string; active_policy_id: string | null
  schedule: unknown; next_run_at: string | null; last_run_at: string | null; created_at: string; created_by: string
}
export type AgentPolicyRow = {
  id: string; version: number; policy: AgentPolicy; policy_hash: string; summary: AuthorizationSummary; status: 'pending_grant' | 'active' | 'superseded' | 'revoked' | 'discarded'
  requires_grant: boolean; created_by: string; created_at: string; granted_by: string | null; granted_at: string | null; revoked_at: string | null; revoke_reason: string | null
  /** Shopify scopes the store has not granted for what this version may write (empty at drafts only) */
  missing_scopes?: string[]
}
export type AgentRunRow = { id: string; policy_version: number | null; trigger: string; status: string; status_reason: string | null; counts: Partial<AgentRunCounts>; started_at: string; finished_at: string | null }
export type ChangeShape = { field: string; from: unknown; to: unknown; params?: Record<string, unknown> }
export type AgentExecutionRow = {
  id: string; status: string; status_reason: string | null; started_at: string; finished_at: string | null; verified_at: string | null; attempt: number
  before_value: unknown; after_value: unknown; qualification: { covered: boolean; reasons: string[]; blockers: string[] } | null; policy_version: number | null
  action_key: string; target_label: string | null; change: ChangeShape; approver_kind: string; approved_by: string
}
export type AgentWaitingRow = {
  id: string; action_key: string; target_label: string | null; change: ChangeShape; change_hash: string; status: string; status_reason: string | null
  expires_at: string; issue_id: string; summary: string | null; severity: string; evidence: Record<string, unknown>
}
export type AgentNeedsPersonRow = { id: string; check_key: string; resource_label: string | null; severity: string; summary: string | null; human_action: string | null; evidence: Record<string, unknown>; first_detected_at: string }
export type AgentDetailResponse = {
  ok: true; agent: AgentRow; policies: AgentPolicyRow[]; runs: AgentRunRow[]; executions: AgentExecutionRow[]; waiting: AgentWaitingRow[]; needsPerson: AgentNeedsPersonRow[]
  /** what the version waiting for a grant adds to the active one */
  pendingExpansion: string[] | null
  /** what the store has granted the app, and what it can still be asked for at runtime */
  storeScopes?: { granted: string[]; requestable: string[] }
}

export type ReferenceKindName = 'price_list' | 'sku_mapping' | 'publication_list'
export type ReferenceSourceView = {
  id: string; connection_id: string; kind: ReferenceKindName; name: string; version: number; status: string; row_count: number; error_count: number; ambiguous_keys: number
  row_errors: { row: number; message: string }[]; columns: string[]; uploaded_by: string; created_at: string; updated_at: string
}
export type ReferencesResponse = { ok: true; references: ReferenceSourceView[]; templates: Record<ReferenceKindName, { columns: string[]; example: string[]; notes: string }> }
export type UploadReferenceResponse = { ok: true; source: ReferenceSourceView; unchanged: boolean; rowErrors: { row: number; message: string }[] }
export type PublicationsResponse = { ok: true; currency: string | null; publications: { id: string; title: string }[] }

// ---------------------------------------------------------------- email

export type EmailAccountView = {
  id: string; org_id: string; provider: 'gmail' | 'microsoft' | 'synthetic'; address: string; display_name: string | null
  status: 'active' | 'needs_reauth' | 'error' | 'disconnected'; status_reason: string | null; granted_scopes: string[]
  can_send: boolean; can_read: boolean; is_synthetic: boolean; last_checked_at: string | null; last_success_at: string | null
  last_error_code: string | null; connected_by: string; connected_at: string; label: string
  usage: { agents: number; sentToday: number; failed7d: number; unknown: number; awaiting: number }
}
export type EmailProviderView = { provider: EmailAccountView['provider']; label: string; configured: boolean; status: 'test_only' | 'configured_unverified' | 'not_configured'; readScopes: string[] }
export type EmailAccountsResponse = { ok: true; accounts: EmailAccountView[]; providers: EmailProviderView[] }
export type EmailConnectResponse = { ok: true; url: string }
export type EmailDisconnectResponse = { ok: true; revokedAtProvider: 'revoked' | 'not_supported' | 'failed'; messagesCancelled: number }

export type EmailStatusName = 'draft' | 'awaiting_approval' | 'queued' | 'sending' | 'accepted' | 'failed' | 'delivery_unknown' | 'cancelled'
export type EmailMessageItem = {
  id: string; org_id: string; agent_id: string | null; run_id: string | null; account_id: string; policy_version: number | null; task_key: string
  status: EmailStatusName; status_reason: string | null; from_address: string; to_addresses: string[]; cc_addresses: string[]
  attachment_count: number; attachment_bytes: number; content_hash: string; approval_kind: 'individual' | 'standing' | null; approved_by: string | null; approved_at: string | null
  attempts: number; next_attempt_at: string | null; accepted_at: string | null; accepted_evidence: string | null; failure_code: string | null
  reply_seen_at: string | null; reply_count: number; created_at: string; updated_at: string
  /** decrypted for merchant users; null for Deploi staff */
  subject: string | null; agent_name?: string | null
}
export type EmailAttachmentView = { filename: string; contentType: string; bytes: number; preview: string | null }
export type EmailMessageDetail = Omit<EmailMessageItem, 'subject' | 'agent_name'> & { content: { subject: string; bodyText: string; attachments: EmailAttachmentView[] } | null }
export type EmailMessagesResponse = { ok: true; messages: EmailMessageItem[] }
export type EmailMessageResponse = { ok: true; message: EmailMessageDetail }
export type EmailSendOutcome = { ok: true; messageId: string; status: EmailStatusName; reason?: string | null; duplicate?: boolean }
export type EmailEditResponse = { ok: true; contentHash: string; status: EmailStatusName }

export type StoreAccess = {
  eligible: boolean
  status: 'eligible' | 'pending' | 'denied'
  basis: 'open_access' | 'development_store' | 'beta_invite' | 'staff_approved' | 'synthetic' | null
  mode: 'beta' | 'open'
  reason: string
  isDevelopmentStore: boolean | null
  requestedAt: string | null
  writesPaused: boolean
}
export type StoreAccessResponse = { ok: true; access: StoreAccess }

export type BillingState = { required: boolean; active: boolean; planHandle: string | null; checkFailed: boolean; plansUrl: string | null; partnerApiConfigured: boolean }
export type BillingResponse = { ok: true; billing: BillingState }
