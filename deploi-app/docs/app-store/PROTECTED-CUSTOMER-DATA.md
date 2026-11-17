# Protected customer data: what to enter in the Partner Dashboard

Written 2026-11-06 against shopify.dev "Work with protected customer data" (read the same day).
Partner Dashboard path: **Apps → Deploi AI → API access requests → Protected customer data access**.
Shopify will not take a protected-data request while the app is under review, so decide this before you submit.

## 1. Decision for the first submission: do not request protected customer data

What the Shopify app does today:

- It installs with `read_products, read_inventory, read_locations`. The optional scopes are `write_products`,
  `read_publications` and `write_publications`. It asks for no customer, order, draft-order, fulfillment, return
  or checkout scope. `tests/shopify/app-store-requirements.test.ts` ("3.2 scopes") fails if one is added.
- No embedded feature reads a Shopify Customer or Order object. The library agents that would (Order Tracker,
  Returns, Customer Care) are hidden inside Shopify (`lib/shopify/embedded.ts`). Their live store reader is not
  connected: `lib/library/store-data.ts` refuses every live call.
- Customer details reach Deploi only through the mandatory compliance webhooks (`customers/data_request`,
  `customers/redact`). Deploi stores the customer only as a one-way SHA-256 hash (`lib/connectors/shopify/compliance.ts`).

**So on the review page, choose "My app doesn't require protected customer data" (opt out).** Requesting access
you don't use goes against Level 1 requirement 1 (process only the minimum data needed) and adds review work.

## 2. Ready to paste once an order-reading agent ships

Use this only when an agent that reads orders is built, tested on a development store, and marked
`status: 'working', shopifyReady: true` in `lib/packs/registry.ts`. It also needs the `read_orders` scope added
as an **optional** scope. Ask for the smallest set below, and only for the agents actually shipped.

### 2a. Protected customer data (Level 1): reason for use

> Deploi AI lets a merchant create agents that watch their own store's orders for problems that need a person.
> The Order Tracker agent reads the merchant's orders (order name, created date, fulfillment status, tracking
> number and tracking events, line items and total) to find orders that are late to ship or whose tracking has
> stopped moving. It then shows the merchant a draft delay update for that customer. The Returns agent reads
> return requests tied to those orders to draft a reply under the merchant's return policy. Nothing is sent
> without the merchant: at the default permission ("drafts only"), the agent shows the draft and the merchant
> sends it. Order data is read on demand when the agent runs. Only what a finding needs is kept, as evidence on
> the merchant's case. It is never shared with other merchants, sold, or used to train models.

### 2b. Protected customer fields (Level 2): request only these

| Field | Request? | Reason to paste |
|---|---|---|
| **Name** | Yes | "The agent greets the customer by first name in the draft delay or return update the merchant reviews and sends. Only the first name is used and stored with the draft. The last name is not used." |
| **Email** | Yes | "The draft update is addressed to the customer's email on the order, so the merchant can send it from their connected mailbox after reviewing it. The address is stored encrypted with the draft and deleted on `customers/redact`." |
| **Phone** | **No** | Not used by any agent. Don't request it. |
| **Address** | **No** | Not used by any agent (tracking comes from the fulfillment, not the shipping address). Don't request it. |

### 2c. Data protection details (the questions on the form)

Every answer below is true of the code today. Where it is not, the answer says so; fix the gap before you request access.

| Requirement | Answer to paste | Evidence |
|---|---|---|
| L1.1 Minimum data | "Only the fields listed above, only for the agents that need them, read on demand. Products and inventory are read for the other agents; no customer object is read." | scopes test; `lib/shopify/embedded.ts` |
| L1.2 Tell merchants what is processed and why | "Our privacy policy (getdeploi.com/privacy) and the agent's authorization screen list the data each agent reads and why, before the merchant grants it." | `getdeploi.com/privacy` (**draft, pending legal review**) |
| L1.3 Limit processing to stated purposes | "Each agent runs under a written authorization the merchant grants. It lists the data, the actions and the limits. The runtime refuses anything outside it." | `lib/agents/policy.ts`, `lib/autonomy` |
| L1.4 Consent | "Deploi sends nothing to a customer on its own. Every message is a draft the merchant approves, or is sent within limits the merchant set, from the merchant's own mailbox. Recipients who opt out are suppressed." | `email_suppressions`, `lib/email` |
| L1.5 Opt-out of data sale | "Deploi does not sell or share customer personal data." | privacy policy |
| L1.6 Automated decisions with significant effects | "None. Agents draft messages and flag orders. They make no decision about a customer with legal or similar effect." | runners in `lib/library/runners.ts` |
| L1.7 Privacy / data protection agreement with merchants | "Merchants accept our Terms and Data Processing terms in the app before an agent can be switched on." | `docs/legal/*` (**drafts; counsel must sign off**), `LEGAL_GATE` |
| L1.8 Retention | "Inbound mail raw content 30 days; sent message bodies 365 days (adjustable 1–730); webhook receipts 90 days; all shop data erased on `shop/redact` 48 hours after uninstall; a customer's data erased or anonymized on `customers/redact`." | `docs/DATA-RETENTION.md`, `lib/platform/retention.ts`, `lib/connectors/shopify/install.ts#redactShop` |
| L1.9 Encryption at rest and in transit | "TLS everywhere (HSTS). Store tokens, mail bodies, received mail and customer data exports are encrypted with AES-256-GCM, bound to each row. The database is encrypted at rest by the provider." | `lib/connectors/credentials.ts`, `lib/email/inbound.ts`, `lib/privacy/exports.ts`, `next.config.ts` |
| L2.1 Encrypted backups | "Daily provider backups (Supabase), encrypted at rest by the provider." | `docs/BACKUP-RESTORE.md` (**confirm the plan's encryption statement in the Supabase dashboard**) |
| L2.2 Separate test and production data | "Separate projects and databases. Tests and demos use a synthetic store only; scripts refuse the production host." | `docs/PRODUCTION-SAFETY.md`, `scripts/launch-migrations.ts` |
| L2.3 Data loss prevention | "Row-level security on every merchant table, tenant isolation tests, an outbound host allowlist, no customer data in logs (structured logger redacts), and export downloads recorded." | `tests/security/tenant-isolation.test.ts`, `tests/security/rls-coverage.test.ts`, `lib/net/outbound.ts` |
| L2.4 Limited staff access | "Staff accounts are read-only to merchant data and cannot download customer data exports. Access requires staff role, granted by allowlist." | `lib/privacy/exports.ts` (staff refused), `lib/platform/rbac.ts` |
| L2.5 Strong staff passwords | "Staff sign in through Supabase Auth with a minimum password policy and MFA." | **Founder: set minimum length 12 and enable MFA for staff in Supabase Auth settings before requesting.** |
| L2.6 Access log | "Every read of a customer data export, every agent action and every approval is written to an append-only, hash-chained audit log." | `lib/engine/audit.ts` (`engine_audit`) |
| L2.7 Incident response policy | "Documented incident switches and escalation; affected merchants are notified." | `docs/MONITORING.md` §6. **There is no written incident response policy yet. Write one page (severity, roles, 72-hour notification) before requesting.** |

## 3. What to do

1. For Saturday: opt out on the review page (§1). Nothing to paste.
2. Later, when an order-reading agent is ready: add `read_orders` to `optional_scopes` in the TOML and to
   `OPTIONAL_SCOPES` in `lib/connectors/shopify/config.ts`, and update the scopes test. Then close the two gaps
   marked in §2c (staff password policy, incident policy). Then paste §2a, §2b and §2c.
