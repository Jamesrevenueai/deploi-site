# Gap analysis against the Final Master Build Brief — 2026-11-05

Base: `claude/deploi-full-implementation` @ 5b732db (577/577 vitest, 40/43 e2e, migration rehearsal green;
not pushed: push access to deploi-site was refused). Production: `main` @ e7d2b6c, migrations through 035.
Production email sign-up is still open (security finding F-02 live; owner action).

| Brief area | Exists | Gap |
|---|---|---|
| Resolution Engine (cases, lifecycle, evidence, verified outcomes) | Per-domain records: issues/proposals/executions, email_messages, supplier_requests, office_actions/leads/meetings | **No unified case.** Nothing carries a problem from detection through external waiting to a verified outcome. |
| Business Discovery + automatic agent selection/configuration | Wizard creates fixed templates at drafts only | **No discovery**: no business profile, no data-driven agent recommendation, no "We found work" first run. |
| Commerce flagship: supplier exception resolution | Restock requests per supplier, reply + ETA recorded | **No purchase orders** (Shopify has no PO API): no PO import, confirmation/quantity/price/delay discrepancy detection, reply-to-PO matching, resolution options. |
| Office flagship: CRM follow-up resolution | HubSpot + Calendar lead follow-up, meetings, CRM notes | Outcomes not tracked as verified cases (meeting held/booked verified on the calendar, CRM stage verified by read). |
| Accounts Receivable / QuickBooks | none | Not implemented. |
| Email Operations Agent (unanswered inbox) | Customer inbox, threads | No unanswered-message detection or case tracking; Outlook (Graph) mail read and calendar not wired to Office. |
| Multi-agent coordination | Separate agents | No case ownership/handoff model; handoffs must not widen permissions. |
| Cost control / model metering | Agents are deterministic (no model calls today) | No AI gateway, usage metering, per-agent/per-org budgets or cost-per-resolution reporting. |
| Billing: configurable pricing | Stripe, plan limits, allowance | Prices/limits hard-coded per tier; brief's $149/$299/$499 suites need DB-configurable plans (owner approval before final). |
| RBAC | Any org member can grant agents (F-08) | Owner/admin/member roles; owner-only grants. |
| Account deletion, retention, backups/restore | none documented/tested | Deletion flow, retention jobs, restore rehearsal. |
| Customer experience | Dark theme; Control Room | Brief requires a light premium theme and the nav Home / My AI Team / Work in Progress / Needs My Approval / Completed Work / Inbox / Business Insights / Integrations / Billing / Settings; case detail. |
| Website | Commerce + Office sections | Pages: Office, Commerce, How it works, Integrations (honest status), Pricing, Security, Contact, Signup, Legal. |
| Live verification | none possible | No third-party credentials in this environment. |

Implementation order: Resolution Engine core (shared contract) → in parallel: commerce flagship + PO,
office flagship + email operations, QuickBooks + AR, discovery + auto-configuration, light UI + website,
platform (AI gateway/metering, configurable pricing, RBAC, deletion/retention, restore) → integration.
