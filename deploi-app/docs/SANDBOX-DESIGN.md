# Design: a sandboxed computer per agent

Status: **design only. Nothing here is built.** This document fixes the safety rules before any code exists. An agent today works only through connectors (store, email). This design covers what changes if an agent also gets a small computer, to browse a supplier portal or open a spreadsheet, for example.

## 1. Principles

1. **The sandbox adds capability, never authority.** What an agent may do is still decided only by its granted policy version (tool, tier, scope, limits, end date). The sandbox is one more tool with the same three tiers: drafts only (default), after approval, or without asking within limits for at most one year.
2. **Fail closed.** If any control below is unavailable (the egress proxy is down, the credential broker cannot be reached, the audit write fails), the session stops before acting.
3. **Nothing in the sandbox is trusted.** Web pages, files and email are data. Nothing the sandbox reads can widen a permission, add a recipient or extend a session.

## 2. Isolation

- **One microVM per session** (Firecracker or an equivalent hardware-virtualised sandbox), not a shared container. A new VM is made from a read-only, signed base image for every session and destroyed at the end. Nothing persists between sessions except the outputs the agent explicitly hands back.
- **No host mounts and no access to cloud metadata.** The guest has no route to `169.254.169.254` or to any other internal address; this is enforced on the host, not in the guest.
- **Non-root user**, read-only root filesystem, a small scratch disk (≤ 2 GB) and no device passthrough.
- **One tenant per VM.** A session is bound to one organization, one agent and one policy version. That binding is set by the controller that starts the VM and cannot be changed from inside it.
- The controller runs outside the VM, holds the policy and the session clock, and is the only path for tool calls and approvals.

## 3. Network allowlist

- **Default deny.** All egress goes through a controller-side proxy. The guest has no other route and no DNS of its own.
- The allowlist is **part of the granted policy**: a list of exact hostnames with a purpose for each (for example `portal.supplier.example: check stock`). Adding a host is a widening and needs a new grant.
- HTTPS only. The proxy checks SNI and the Host header against the allowlist and refuses IP literals and redirects to hosts that are not listed.
- Per-host methods: read-only (`GET`/`HEAD`) unless the tier and policy allow writes on that host. A `POST` to a listed host in drafts-only mode is refused and logged.
- Rate and volume limits per session (requests per minute, bytes in and out). An upload beyond the limit stops the session.
- No inbound connections.

## 4. Credentials

- **No secret enters the VM.** A credential broker in the controller injects credentials into outgoing requests at the proxy, scoped to the allowed host. The guest sees placeholders, never values.
- Credentials are stored like store and email tokens today: AES-GCM at rest with a key ID, decrypted only in the broker, and never logged (the audit trail scrubs secret-looking keys).
- Credentials belong to the organization and are bound to one agent and one host. Revoking the agent, or removing the host from its policy, makes the broker refuse them at once.
- Password entry into web forms is not allowed. Supplier portals are reached only through OAuth or API keys the merchant adds in Deploi, or are read-only.

## 5. Session limits

| Limit | Default | Hard maximum |
|---|---|---|
| Wall-clock time per session | 10 minutes | 30 minutes |
| Idle time (no tool call) | 2 minutes | 5 minutes |
| Sessions per agent per day | 5 | as granted, up to 50 |
| CPU / memory | 1 vCPU / 1 GB | 2 vCPU / 4 GB |
| Egress | 50 MB | 500 MB |
| Actions that change something outside the VM | 0 in drafts only | the policy's per-run and per-day limits |

When a limit is reached, the session is frozen and destroyed, and the run is recorded as *blocked* with the reason. Never as *done*.

## 6. Audit

- Every tool call, proxy request (host, method, path, status and byte counts; never bodies), credential use (credential ID, host) and approval is written to the same append-only engine audit trail as connector actions. Each entry carries the session ID, agent, policy version and tier, so the agent's work log shows what, when, why and which permission allowed it.
- A screenshot is captured every 10 seconds and for every action that changes something. Screenshots are stored encrypted for 30 days, shown to the merchant only, and redacted where a field is marked secret.
- The audit write is synchronous. If it fails, the action does not happen.
- Statuses stay honest: a session that ends early is *blocked*, *failed* or *timed out*. A task is *done* only with the session's evidence.

## 7. Kill switch

Four levels, all taking effect within 5 seconds:

1. **Session:** the merchant presses Stop on the live session view. The controller kills the VM, the proxy drops its connections, and queued actions are cancelled.
2. **Agent:** Pause, Revoke or Delete (exactly as today) also kills any running session of that agent and refuses new ones.
3. **Organization:** the merchant turns off "computer use" for the whole organization. Every session stops, and the tool disappears from all policies until it is turned on again with a new grant.
4. **Global (Deploi operators):** a feature flag stops all sessions platform-wide and refuses new ones. It is used for incidents.

Each kill is audited with who triggered it and why.

## 8. Rollout (each step needs owner approval)

1. Internal only, drafts only, on a synthetic supplier portal.
2. Private beta merchants, drafts only.
3. "After approval" for named hosts.
4. "Without asking": only after the audit and kill switch have been tested in production, and never for payments, account settings or messages to new recipients.

## 9. Not covered yet (open questions)

- The VM provider and region, and the cost per session.
- How a merchant safely connects a supplier portal that has no API or OAuth.
- Legal review of screenshot retention.
