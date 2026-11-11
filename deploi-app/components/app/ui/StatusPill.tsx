import type { AgentStatus } from '@/lib/app/contract'
import { tokens } from '@/lib/app/tokens'

/** An agent's status: Working, Waiting on you, Watching or Off (999px pill, 12px, 600; colours from the tokens). */
export function StatusPill({ status, label }: { status: AgentStatus; label?: string }) {
  return <span className={`app-pill app-pill--${status}`} data-status={status}>{label ?? tokens.status[status].label}</span>
}
