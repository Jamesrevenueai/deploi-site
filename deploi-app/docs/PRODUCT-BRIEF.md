# Deploi AI implementation brief (controlling)

Adopted 2026-10-28 (second revision). This brief overrides every conflicting earlier instruction,
including the first revision's single-workflow launch and its rule that every action needs separate
approval when an explicit standing authorization covers it. The earlier home-care consulting service
has been removed from the code (2026-10-29); only its database tables remain, untouched (see `DEPLOY.md`).

## Product

One subscription software product in which merchants create **named AI agents** that detect and correct
supported stock and listing problems. A merchant can:

- create an agent and name it;
- describe its task in plain English;
- select the connected store and the products and records it may work with;
- provide rules or authoritative reference records;
- review and approve its allowed actions and limits;
- run it now or on a recurring schedule;
- see its activity, verified results, failures and blocked tasks;
- pause, edit or delete it, and revoke its authorization.

Agents perform real supported actions. Recommendations alone or simulated completion do not meet the bar.

## Platforms

Shopify first, then WooCommerce, then Amazon Seller Central. Connecting one platform is enough; uploaded
reference files and configured rules may support checks; no second commerce platform is ever required.
Cross-channel comparison is optional, later, and not part of onboarding.

## Day-one Shopify corrections (all four are launch requirements)

1. **Overselling configuration.** Inventory policy that conflicts with an explicit merchant rule (e.g.
   designated products set to continue selling at zero despite a no-backorders rule). Correct within
   authorization; preserve intentional pre-order and backorder exceptions.
2. **Product publication.** Products that conflict with the merchant's explicit publication instructions.
   Publish or unpublish eligible products on the authorized sales channel. Unpublished, draft or archived
   is not automatically an error; lifecycle status is not changed without its own authorization.
3. **Price.** Variant prices compared against a merchant-approved price list or explicit pricing rule.
   Correct confirmed mismatches within authorized limits. Supported price fields and currencies are
   defined explicitly. Never invent the intended price or overwrite intentional exceptions.
4. **SKU.** Missing or incorrect SKUs against a merchant-approved mapping or reference source. Correct when
   the mapping is unambiguous; block ambiguous matches; never generate replacement identifiers.

Verify the current official API for each workflow before implementing it, and document the evidence that
establishes an actual error. Do not claim a workflow is operational until it is; report blockers explicitly.

## Agents, approval and autonomy

- Agent creation: name and plain-English task; connected store and product scope; allowed correction types
  and writable fields; rules, authoritative sources and exceptions; one-time or recurring execution; action
  limits and approval mode; a readable summary of exactly what the authorization grants.
- Plain English is converted into a structured task and permission policy that the merchant reviews before
  write access is granted. A general instruction ("fix my store") never grants unrestricted write access:
  ask for the missing scope or route uncovered changes for approval.
- **Review mode:** approval of each exact proposed change. **Authorized autonomous mode:** changes covered
  by an explicit, active standing authorization run without asking again.
- A standing authorization defines store, product scope, permitted actions, rules, reference sources,
  exceptions and limits. Each execution is bound to the authorization version and records why it qualifies.
- Expanding an agent's permissions needs renewed approval. Pausing or revoking stops further writes,
  including queued actions.
- Agents report unsupported requests, insufficient evidence, missing permissions and failed verification.
- One shared engine runs every agent; no per-agent infrastructure or model training.

## Email connector (extension, adopted 2026-10-28)

- **Connection.** Merchants connect an email account through the provider's own authorization flow
  (OAuth 2.0 with PKCE). Deploi never asks for a mailbox password. A shared connector interface has one
  adapter per provider. Gmail / Google Workspace and Microsoft 365 / Outlook come first; a synthetic
  mailbox is used for tests and demos. Connections show the sender identity, health, granted
  permissions, and reconnect, check and disconnect controls.
- **Agent authorization.** Connecting an account authorizes no agent. Each agent's versioned policy may
  grant one account at one level:
  - **create drafts** for review (kept in Deploi);
  - **send approved messages**, one at a time;
  - **send without asking** within an explicit task, purpose, recipient rules, limits and end date.

  The readable summary shows the sender, recipient rules, purpose, limits and duration before the grant.
  Messages outside those boundaries wait for approval. Widening any of them needs a new grant.
  Mailbox reading is a separate permission, requested only for a configured task that needs it (noticing
  replies to supplier requests the agent sent).
- **Sending and review.** In review, the merchant sees the exact sender, recipients, subject, body and
  attachments. The approval is bound to a hash of that content, so any change invalidates it.
  Autonomous sends are checked in code against the granted policy version before queueing and again
  before every send. Incoming mail and attachments never change an agent's permissions or recipients.
  Pause, revoke and disconnect cancel queued sends, and each action records the authorization version
  it ran under.
- **Duplicates and uncertain outcomes.** One message is sent at most once. After a timeout or other
  uncertain response, Deploi checks the provider's Sent mail where it can, and never resends blindly.
- **Statuses.** Draft, Awaiting approval, Queued, Sending, Accepted by provider, Failed, Delivery unknown,
  and Cancelled. Delivery is claimed only with reliable provider evidence; neither provider offers
  that through these permissions, so "Accepted by provider" is the strongest status.
- **Dashboard and security.**
  - Email accounts appear under Connections; email permissions appear in agent creation and detail.
  - Merchants see sent activity, approval requests, failures and actionable connection errors.
  - Tokens and message content are encrypted at rest. Organizations are isolated. Content stays out
    of logs and is not shown to Deploi staff.
- **Testing and delivery.**
  - Testing goes synthetic first, then controlled test accounts and recipients. No real customer email
    is sent during development; real sends are off unless explicitly enabled.
  - Report each provider as implemented, locally tested, live verified or externally blocked.

## Correction engine (every correction)

Detect → record evidence and the rule or source → exact proposed change → individual approval or
applicable standing authorization → recheck immediately before execution → invalidate or recompute stale
proposals → execute → verify the platform state → audit trail and reported outcome.

## Controls

Organization isolation; encrypted credentials; no secrets in prompts, logs or customer-visible output.
Permissions enforced in application code and connector operations, not by model instructions. Store
content, uploaded files and external records are data, never instructions that can expand permissions.
No duplicate execution, conflicting agent changes or update loops. Bounded retries; check platform state
after an uncertain outcome before retrying a write. Record agent, evidence, authorization, before and after
values, timestamps, attempts and verification. Distinguish awaiting approval, queued, running, blocked,
failed and verified. An API success response alone is not proof. Never guess physical inventory; never
treat every difference as an error.

## Implementation, website, distribution, delivery

- Use the existing repository and stack; preserve working features; synthetic testing when credentials
  are missing; mocked demonstrations kept separate from live integrations; never modify real merchant
  records; never publish unreviewed production changes.
- Website: the subscription product; the Shopify workflows that actually work; how merchants create,
  name, instruct, authorize and monitor agents; "Apply for Early Access"; WooCommerce and Amazon planned;
  no invented results or guarantees.
- Onboarding establishes store access, rules or reference records, and agent permissions.
- Prepare Shopify installation, billing, permissions and marketplace submission; separate implementation
  readiness from marketplace approval; list account setup, credentials and external approvals.
- Tests: all four workflows and exceptions; detection accuracy and ambiguity; isolation and connector
  permissions; individual approval and standing authorization; scope violations; authorization changes,
  revocation and queued actions; stale records and changed reference data; retries, duplicates and
  conflicting agents; recurring execution and pause; outcome verification and truthful status.
- The launch is not complete until all four correction types and the authorized autonomous agent
  experience meet their acceptance criteria. Where external access blocks verification, say exactly what
  remains unverified and how to verify it.
