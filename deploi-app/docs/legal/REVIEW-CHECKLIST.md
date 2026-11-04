# Legal review checklist (for counsel)

Status on 2026-11-04: **every document in this folder is an unreviewed draft.** None may be published,
linked from the public site as final, or relied on until counsel signs off. This page lists what the
drafts assume and the questions we need answered.

## How the documents are used in the product

- The Markdown files in `docs/legal/` are the only source of the text. The app reads them at runtime
  (`lib/legal/documents.ts`), computes a SHA-256 fingerprint of each file, and records every version it
  serves in `legal_documents` with status **draft**.
- Customers accept by clickwrap on `/store/legal`: each required document is shown in full with its own
  checkbox and an "I accept" button. Each acceptance is stored append-only in `legal_acceptances` with
  organization, user, e-mail, document key, version, SHA-256, document status at the time (draft or
  published), product, method (`clickwrap`), time, IP address and browser user-agent.
- Organization-level documents (Terms, DPA, AI Agent Authorization Terms, Pilot Agreement) are accepted
  once per organization by an authorized user; user-level documents (Privacy notice acknowledgement,
  Acceptable Use Policy) by each person. **Q-1: is that split right?**
- Any edit to a file changes its fingerprint and requires everyone to accept again, even if the version
  label was not changed.
- The gate is controlled by `LEGAL_GATE`:
  - `off` (default): nothing is required;
  - `draft`: pilots must accept the current draft text before connecting a store, creating or granting an
    agent, or starting billing; the acceptance is recorded as of a **draft**;
  - `enforce`: the documents must also be **published**. Nothing in the app publishes a document.
    Publishing is a manual database step (below) after your sign-off.
- **Q-2: is acceptance of a clearly labelled draft by pilot customers acceptable, or should pilots sign
  the Pilot Agreement by e-signature instead?**

## To publish after sign-off (founder, not engineering)

1. Edit each file: remove the DRAFT banner, set the version (e.g. `1.0.0`), set the effective date, fill
   every `[PLACEHOLDER]`.
2. Deploy. The app records the new fingerprints as draft.
3. In the production database, mark exactly those fingerprints published:
   `update legal_documents set status = 'published', published_at = now() where key = '<key>' and version = '<version>' and sha256 = '<sha256 shown on /store/legal>';`
4. Set `LEGAL_GATE=enforce` and redeploy.
5. Update the public site's `/terms` and `/privacy` (owned by the website workstream) from these files.

## Placeholders to fill

`[COMPANY LEGAL NAME]`, `[POSTAL ADDRESS]`, `[EFFECTIVE DATE]`, notice addresses (`legal@`, `privacy@`,
`security@`, `abuse@getdeploi.com` — confirm they exist), grace period (draft: 7 days, matches
`BILLING_GRACE_DAYS`), retention periods, pilot fees and term, liability cap, SCC governing law.

## Open questions by document

### Terms of Service (`terms`)
- **T-1** Liability cap: 3 months' fees (current site text) gives free-beta customers a cap of zero. Fixed
  minimum? Higher cap for data-protection breaches?
- **T-2** Arbitration / class-action waiver for US customers; how to treat EU/UK business customers.
- **T-3** Shopify App Store merchants are billed by Shopify. Do our Terms need a Shopify-specific section
  (Shopify's Partner Program Agreement and App Store requirements: e.g. refunds through Shopify)?
- **T-4** Change-of-terms mechanism: re-acceptance is enforced in the app for new store connections,
  agents and billing; is continued use enough for existing agents, or must running agents pause until
  re-acceptance?
- **T-5** Indemnities: scope and procedure.
- **T-6** Read-only after non-payment or cancellation: is 30 days of read-only export enough?

### Privacy Policy (`privacy`)
- **P-1** The public site's current privacy text says the app **does not read customer or order data**.
  The Order Tracker, Customer Care, Returns and Payout agents do. The site text must be replaced before
  those agents run on a real store, and the Shopify `customers/redact` and `customers/data_request`
  handlers (which currently answer "no customer data held") must be changed to export and erase it.
  Engineering finding F-07 in `docs/SECURITY-REVIEW-2026-11-04.md`.
- **P-2** Retention periods (acceptance evidence 6 years; billing 7 years; early-access 12 months).
- **P-3** EU/UK representative (Art. 27) — needed given our customer base?
- **P-4** Are we a "business" under CCPA thresholds for our own account data? US state law coverage
  (Virginia, Colorado, Connecticut, Texas, etc.).

### Data Processing Addendum (`dpa`)
- **D-1** SCC module, governing law and courts (draft: Module Two, Ireland). Do we need Module Three for
  onward transfers to subprocessors?
- **D-2** Are customer-connected platforms (their Shopify, WooCommerce host, HubSpot, Google) our
  subprocessors or customer-instructed recipients? Draft treats them as the latter (Subprocessor List
  section B).
- **D-3** Breach notification window (draft: 48 hours).
- **D-4** Audit right: once a year with 30 days' notice — acceptable?

### Acceptable Use Policy (`aup`)
- **U-1** Competitor monitoring: is reading public pages under robots.txt enough, or do target sites'
  terms of service forbid automated access we should honour too?

### AI Agent Authorization Terms (`ai_agent_terms`)
- **A-1** Is the characterization "an Agent acting within your Authorization is acting for you"
  (agency/attribution) enforceable and adequate for unauthorized-act disputes?
- **A-2** Role controls: today any signed-in member of the organization (or any Shopify admin user of the
  store) can grant and approve. Should the terms require the customer to restrict this, or should the
  product add owner-only grants before launch?
- **A-3** E-mail: the customer is the "sender" for CAN-SPAM (15 U.S.C. 7701 et seq.) and the initiator
  for CASL even when the agent sends from an address on Deploi's domain. Is Deploi at risk of being a
  "sender" or "initiator" itself? Do we need a mandatory footer (postal address, unsubscribe) enforced in
  the product for commercial messages?
- **A-4** AI disclosure: should agent-written e-mails disclose automated authorship (e.g. EU AI Act Art. 50
  transparency, California bot disclosure law)?
- **A-5** Remedy if an agent acts outside its Authorization due to our defect (service credit?).
- **A-6** "No guarantee of outcomes" vs. marketing claims on the site (e.g. recovered revenue figures) —
  consistency.

### Pilot / Beta Agreement (`pilot`)
- **B-1** Fees, term (draft 60 days), conversion terms, refund on early termination by us.
- **B-2** Feedback licence and confidentiality of the pre-release.

### Cookie Notice (`cookies`)
- **C-1** All cookies are strictly necessary; no banner. Confirm for EEA/UK (PECR/ePrivacy).
- **C-2** Google Fonts loads from Google's servers (IP transfer). German courts have found this unlawful
  without consent (LG München, 2022). Recommend self-hosting the font (website workstream).

### Subprocessor List (`subprocessors`)
- **S-1** Confirm each provider's DPA is executed/accepted in the account (Vercel, Supabase, Resend,
  Stripe) and the regions.
- **S-2** Notice mechanism for new subprocessors (e-mail subscription).
- **S-3** No AI model provider is called in the current build. If one is added, it must be listed, its
  no-training/zero-retention terms confirmed, and customers notified 30 days ahead.

### Security Overview (`security`)
- **X-1** Confirm we may publish the statements as written (no certification claims).

## Product facts counsel should know

- Billing: Shopify App Store installs are billed by Shopify (required by Shopify); WooCommerce and Office
  customers by Stripe. An organization whose only store is on Shopify is routed to Shopify billing.
  Billing is off (`BILLING_MODE=off`) during the free beta; nothing is charged.
- Failed payment: past due → grace period (`BILLING_GRACE_DAYS`, default 7) → read-only (agents stop
  writes and sends; data stays visible). Cancelled → read-only.
- Prices in `agent-library.json` are proposals (`pricingStatus: coming_soon`) and are not shown as real
  prices.
