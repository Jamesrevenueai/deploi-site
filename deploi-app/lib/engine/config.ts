/** Engine configuration from the environment. Safe defaults: approvals required, live writes off. */
const e = (k: string) => (process.env[k] ?? '').trim()
const num = (k: string, d: number) => { const v = Number(e(k)); return Number.isFinite(v) && v > 0 ? v : d }

export const engineConfig = {
  /** an unapproved proposal expires after this long and must be re-derived */
  get proposalTtlHours() { return num('PROPOSAL_TTL_HOURS', 24) },
  /** do not re-propose a change Deploi already made if someone reverted it within this window */
  get loopGuardHours() { return num('LOOP_GUARD_HOURS', 72) },
  get verifyAttempts() { return num('VERIFY_ATTEMPTS', 3) },
  get verifyDelayMs() { return Number(e('VERIFY_DELAY_MS') || 400) },
  /** when true, corrections only run for organizations with an active subscription */
  get billingRequired() { return e('BILLING_REQUIRED') === 'true' },
}
