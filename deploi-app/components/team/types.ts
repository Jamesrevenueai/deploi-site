/** Response shapes of /api/store/library/*, /api/store/plan and /api/store/onboarding as the browser receives them. */
import type { TeamView, TeamAgent, CustomAgentView } from '@/lib/library/switches'
import type { ActionRow, LogEntry, LibraryRunResult } from '@/lib/library/actions'
import type { ChatMessage } from '@/lib/library/chat'
import type { UsageSummary } from '@/lib/library/usage'
import type { OnboardingView } from '@/lib/library/onboarding'
import type { LibraryAgent, PermissionLevel, Tier, TierKey } from '@/lib/library/config'

export type { TeamView, TeamAgent, CustomAgentView, ActionRow, LogEntry, LibraryRunResult, ChatMessage, UsageSummary, OnboardingView, LibraryAgent, PermissionLevel, Tier, TierKey }

export type TeamResponse = { ok: true } & TeamView
export type AgentResponse = { ok: true; agent: TeamAgent; tier: TierKey; tiers: Tier[]; permissionLevels: TeamView['permissionLevels']; store: TeamView['store']; usage: UsageSummary; queue: ActionRow[]; log: LogEntry[]; chat: ChatMessage[] }
export type ChatResponse = { ok: true; merchant: ChatMessage; agent: ChatMessage }
export type PlanResponse = { ok: true; tiers: Tier[]; pricingStatus: 'coming_soon' | 'published'; usage: UsageSummary }
export type OnboardingResponse = { ok: true } & OnboardingView
export type UpgradeError = { code: 'upgrade_required'; detail: { tier: TierKey; upgradeTo: TierKey | null; agentKey?: string } }
