# Deploi AI implementation brief (current)

Adopted 2026-10-28. This brief overrides any conflicting earlier instruction, including the
home-care operations-service brief (`docs/BUILD-REPORT-2.md`, `docs/CURRENT-STATE.md`,
`docs/OPERATING-CHECKLISTS.md`). Those documents describe code that still exists and still
works; they no longer describe what Deploi sells.

## Product

One subscription software product with platform-specific integrations and installation
experiences. No consulting offer is advertised.

Launch order:

1. Shopify.
2. WooCommerce.
3. Amazon Seller Central.

A merchant gets useful functionality by connecting **one** platform. A Shopify merchant needs
only Shopify; the same will apply independently to WooCommerce and Amazon. Customers are never
required to operate on more than one platform. Cross-channel comparison is optional, later,
additional functionality and is not part of onboarding.

## Core value

Detect a supported stock or listing problem, show the evidence, propose a correction, obtain
approval, execute the supported correction, verify the outcome.

The first useful release completes at least one **real correction workflow** end to end. Alerts
alone do not meet the bar.

## Scope distinction

- **Single-platform checks** use only platform records, merchant-defined rules, or an
  explicitly configured authoritative source. They never guess physical stock counts and never
  treat every difference as an error.
- **Cross-channel comparisons** are a separate, optional capability. The Shopify-versus-Amazon
  stock comparison is not the onboarding journey.

## Implementation rules

- Inspect the existing repository, follow its instructions, preserve working features, use its
  stack (Next.js 15 App Router, TypeScript strict, Postgres with row-level security).
- Before building a correction workflow, verify the platform's current official API and record:
  problems detectable with that platform alone; the evidence needed to establish each problem;
  supported correction actions and the permissions they need; problems that need additional
  records, connections or a person. Research lives in `docs/platform-research/`.
- Implement the strongest feasible Shopify workflow first and document why the selected check is
  an actual error rather than an intentional configuration (`docs/shopify-workflow.md`).
- Do not invent demand validation or API capabilities.
- One shared issue, approval, execution and verification engine (`lib/engine`) with
  platform-specific connectors (`lib/connectors/<platform>`). WooCommerce is prepared next,
  Amazon afterwards.

## Website

- Replace the consulting positioning with the subscription product.
- Explain what the Shopify version actually does today.
- Show WooCommerce and Amazon as planned until they are operational.
- The call to action is **Apply for Early Access** while access is limited.
- No invented customer results; no unfinished feature presented as available.

## Controls

- Organization isolation (database row-level security) and secure credential storage
  (encrypted at rest, never readable by application users, never logged).
- Approval is tied to the exact proposed change (a hash of the change and its preconditions).
- Relevant records are re-read immediately before execution.
- Stale proposals are invalidated.
- Duplicate actions and conflicting update loops are prevented.
- Results are verified after execution and every step is kept in an audit trail.
- Pending, failed, blocked and verified outcomes are clearly distinguished.

## Distribution and delivery

- Prepare Shopify installation, billing, permissions and marketplace submission requirements from
  current official documentation. Marketplace approval is separate from implementation.
- Test permissions, detection accuracy, approval enforcement, stale data, retries, duplicate
  prevention and outcome verification.
- Deliver working changes, synthetic demonstrations, setup instructions, test results and a
  readiness report that separates local verification, live verification and external blockers.
- Continue independent work when credentials are missing. Never modify real merchant records
  during development; never publish unreviewed production changes.

## What carries over from earlier briefs

Hard rules still apply: no references to the previous companies named in the master brief, no
secrets in replies, commits or logs, synthetic data only in seeds and tests, nothing sent,
charged or deployed without separate authorisation.
